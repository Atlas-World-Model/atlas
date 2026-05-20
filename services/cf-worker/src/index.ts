/**
 * Atlas Cloudflare Worker — handles all mechanical scheduled jobs.
 *
 * Uses Supabase REST API (no Node.js dependencies).
 *
 * Cron triggers:
 *   Every 6h  — lifecycle checks (7/30/90 day) + heartbeat
 *   Daily     — reputation decay
 *   Every 30m — Farcaster campaign publishing
 *
 * Env vars (set as secrets in Cloudflare dashboard):
 *   SUPABASE_URL
 *   SUPABASE_SECRET_KEY
 *   NEYNAR_API_KEY
 *   SIGNER_UUID
 *   ATLAS_FARCASTER_PUBLISH_ENABLED
 */

import { SupabaseDB } from "./db.js";

// Re-export the workflow class — Cloudflare requires it at the module level
export { CampaignLifecycleWorkflow } from "./workflow.js";

interface Env {
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
  NEYNAR_API_KEY?: string;
  SIGNER_UUID?: string;
  ATLAS_FARCASTER_PUBLISH_ENABLED?: string;
  ATLAS_VPS_BRAIN_URL?: string;
  NEYNAR_WEBHOOK_SECRET?: string;
  CAMPAIGN_LIFECYCLE: Workflow;
}

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const db = new SupabaseDB(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);

    switch (event.cron) {
      case "0 */6 * * *":
        await runHeartbeat(db);
        break;

      case "0 5 * * *":
        await runReputationDecay(db);
        break;

      case "*/30 * * * *":
        if (env.ATLAS_FARCASTER_PUBLISH_ENABLED === "true" && env.NEYNAR_API_KEY && env.SIGNER_UUID) {
          await runFarcasterPublish(db, env.NEYNAR_API_KEY, env.SIGNER_UUID);
        }
        break;
    }
  },

  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json({
        status: "ok",
        service: "atlas-worker",
        timestamp: new Date().toISOString(),
      });
    }

    // Start a campaign lifecycle workflow
    if (request.method === "POST" && url.pathname === "/workflow/campaign") {
      // Auth check
      const auth = request.headers.get("authorization") || "";
      if (!env.NEYNAR_WEBHOOK_SECRET || auth !== `Bearer ${env.NEYNAR_WEBHOOK_SECRET}`) {
        return new Response("Unauthorized", { status: 401 });
      }

      let body: {
        campaignRunId: string;
        campaignId: string;
        questionId: string;
        expectedAction: string;
        collectDays?: number;
      };

      try {
        body = await request.json();
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }

      if (
        !body.campaignRunId ||
        !body.campaignId ||
        !body.questionId ||
        !body.expectedAction
      ) {
        return new Response("Missing workflow fields", { status: 400 });
      }

      const instance = await env.CAMPAIGN_LIFECYCLE.create({
        id: body.campaignRunId,
        params: {
          campaignRunId: body.campaignRunId,
          campaignId: body.campaignId,
          questionId: body.questionId,
          expectedAction: body.expectedAction,
          collectDays: body.collectDays ?? 7,
        },
      });

      return Response.json({
        ok: true,
        workflowId: instance.id,
        campaignId: body.campaignId,
      });
    }

    // Check workflow status
    if (request.method === "GET" && url.pathname.startsWith("/workflow/campaign/")) {
      const id = url.pathname.split("/").pop();
      if (!id) return new Response("Missing ID", { status: 400 });

      try {
        const instance = await env.CAMPAIGN_LIFECYCLE.get(id);
        const status = await instance.status();
        return Response.json({ id, status });
      } catch {
        return Response.json({ id, status: "not_found" }, { status: 404 });
      }
    }

    return new Response("Not found", { status: 404 });
  },
};

function randomId(): string {
  const arr = new Uint8Array(12);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

// --- Lifecycle is handled by CampaignLifecycleWorkflow ---

async function transitionStage(db: SupabaseDB, runId: string, nextStage: string, reason: string) {
  const now = new Date().toISOString();
  await db.update("campaign_runs", `id=eq.${runId}`, {
    lifecycle_stage: nextStage,
    updated_at: now,
  });
  await db.insert("audit_log", {
    id: randomId(),
    entity_type: "campaign_run",
    entity_id: runId,
    action: "status_changed",
    new_value: { lifecycleStage: nextStage },
    actor: "system",
    reason,
    created_at: now,
  });
}

// --- Heartbeat ---

async function runHeartbeat(db: SupabaseDB) {
  await db.insert("audit_log", {
    id: randomId(),
    entity_type: "system",
    entity_id: "heartbeat",
    action: "heartbeat",
    new_value: { status: "ok", source: "cloudflare-worker" },
    actor: "system",
    reason: "Scheduled heartbeat",
    created_at: new Date().toISOString(),
  });
}

// --- Reputation Decay ---

async function runReputationDecay(db: SupabaseDB) {
  const dailyDecay = Math.pow(2, -1 / 180);
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const stale = await db.select(
    "contributor_reputation",
    `last_updated_at=lt.${yesterday}&select=id,score`,
  );

  for (const rep of stale) {
    await db.update("contributor_reputation", `id=eq.${rep.id}`, {
      score: rep.score * dailyDecay,
      last_updated_at: new Date().toISOString(),
    });
  }

  if (stale.length > 0) {
    console.log(`[reputation] Decayed ${stale.length} records`);
  }
}

// --- Farcaster Publishing ---

async function runFarcasterPublish(db: SupabaseDB, apiKey: string, signerUuid: string) {
  // Find unpublished campaigns by joining — Supabase REST supports embedded queries
  const runs = await db.select(
    "campaign_runs",
    `lifecycle_stage=in.(ask,collect)&select=id,question_id,lifecycle_stage,questions(id,text,problem,current_belief,success_test,farcaster_cast_hash)`,
  );

  for (const run of runs) {
    const q = (run as any).questions;
    if (!q || q.farcaster_cast_hash || !q.text) continue;

    const lines = [
      q.problem ? `problem: ${q.problem}` : null,
      q.current_belief ? `current belief: ${q.current_belief}` : null,
      `question: ${q.text}`,
      q.success_test ? `success test: ${q.success_test}` : null,
      "",
      "@looti rewards are for the most useful answers.",
    ].filter((l): l is string => l !== null);

    const text = lines.join("\n").slice(0, 1024);

    try {
      const res = await fetch("https://api.neynar.com/v2/farcaster/cast", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify({ signer_uuid: signerUuid, text }),
      });

      if (!res.ok) continue;
      const data: any = await res.json();
      const castHash = data.cast?.hash;

      if (castHash) {
        await db.update("questions", `id=eq.${q.id}`, { farcaster_cast_hash: castHash });
      }

      if (run.lifecycle_stage === "ask") {
        await transitionStage(db, run.id, "collect", "Campaign prompt published");
      }

      console.log(`[farcaster] Published: ${castHash}`);
    } catch (err: any) {
      console.error(`[farcaster] Failed: ${err.message}`);
    }
  }
}
