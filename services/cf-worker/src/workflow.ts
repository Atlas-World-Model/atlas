/**
 * Atlas Campaign Lifecycle Workflow
 *
 * A durable, multi-step state machine for each campaign.
 * Each campaign gets its own workflow instance that sleeps
 * between stages — no polling, no cron checking.
 *
 * V0 timeline (tight feedback loop):
 *   Day 0   — Campaign created, enter collect stage
 *   Day 0+  — Active engagement: Atlas quotes its own cast, comments
 *             on contributions, adds insights, promotes the campaign
 *   Day 1   — Synthesize: call VPS brain to review reward set
 *   Day 2   — Build/test window (if applicable)
 *   Day 3   — Evaluate: call VPS brain to assess outcomes
 *   Day 7   — Final label: close and update reputation
 *
 * During collection, Atlas is NOT idle. It actively engages
 * with the campaign every few hours — commenting on quotes,
 * adding its own thinking, and drawing attention to the question.
 */

import {
  WorkflowEntrypoint,
  WorkflowEvent,
  WorkflowStep,
} from "cloudflare:workers";
import { SupabaseDB } from "./db.js";

interface CampaignParams {
  campaignRunId: string;
  campaignId: string;
  questionId: string;
  expectedAction: string;
  collectDays: number;
  castHash?: string;
}

interface Env {
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
  ATLAS_VPS_BRAIN_URL?: string;
  NEYNAR_WEBHOOK_SECRET?: string;
}

export class CampaignLifecycleWorkflow extends WorkflowEntrypoint<Env, CampaignParams> {
  async run(event: WorkflowEvent<CampaignParams>, step: WorkflowStep) {
    const { campaignRunId, campaignId, questionId, expectedAction, collectDays, castHash } = event.payload;
    const db = new SupabaseDB(this.env.SUPABASE_URL, this.env.SUPABASE_SECRET_KEY);

    // --- Step 1: Transition to collect ---
    await step.do("transition-to-collect", async () => {
      await this.transition(db, campaignRunId, "collect", "Workflow: entering collect");
      console.log(`[workflow] Campaign ${campaignId}: collecting for ${collectDays} days`);
    });

    // --- Step 2: Active engagement during collection ---
    // Atlas doesn't rest. It engages every 4 hours during collection.
    const engagementRounds = collectDays * 6; // ~6 times per day
    for (let i = 0; i < engagementRounds; i++) {
      await step.sleep(`engage-wait-${i}`, "4 hours");

      await step.do(`engage-${i}`, async () => {
        await this.callBrain("engage-campaign", {
          campaignRunId,
          campaignId,
          questionId,
          castHash: castHash || "",
          round: String(i + 1),
          totalRounds: String(engagementRounds),
        });
        console.log(`[workflow] Campaign ${campaignId}: engagement round ${i + 1}/${engagementRounds}`);
      });
    }

    // --- Step 3: Synthesize ---
    const synthesisResult = await step.do("synthesize", async () => {
      await this.transition(db, campaignRunId, "synthesize", "Workflow: collection complete, synthesizing");

      const brainResult = await this.callBrain("synthesize", {
        campaignRunId,
        campaignId,
        questionId,
      });

      const result = brainResult.ok ? "completed" : "manual_review";
      await db.update("campaign_runs", `id=eq.${campaignRunId}`, {
        synthesis_result: result,
        synthesized_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      console.log(`[workflow] Campaign ${campaignId}: synthesis ${result}`);
      return { result, shouldBuild: this.shouldBuild(expectedAction) };
    });

    // --- Step 4: Build/test window (conditional, 1 day) ---
    if (synthesisResult.shouldBuild) {
      await step.do("transition-to-build", async () => {
        await this.transition(db, campaignRunId, "build_test", "Workflow: entering build/test");
        console.log(`[workflow] Campaign ${campaignId}: build/test window open`);
      });

      await step.sleep("wait-for-build", "1 day");
    } else {
      await step.do("skip-build", async () => {
        console.log(`[workflow] Campaign ${campaignId}: skipping build (${expectedAction})`);
      });
    }

    // --- Step 5: Evaluate ---
    await step.do("evaluate", async () => {
      await this.transition(db, campaignRunId, "evaluate", "Workflow: evaluation");

      await this.callBrain("evaluate", {
        campaignRunId,
        campaignId,
        questionId,
      });

      await db.update("campaign_runs", `id=eq.${campaignRunId}`, {
        evaluated_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      console.log(`[workflow] Campaign ${campaignId}: evaluation complete`);
    });

    // --- Step 6: Wait for final label ---
    await step.sleep("wait-for-final", "4 days");

    // --- Step 7: Final label and close ---
    await step.do("final-label", async () => {
      await this.transition(db, campaignRunId, "remember", "Workflow: final label");

      await this.callBrain("final-label", {
        campaignRunId,
        campaignId,
        questionId,
      });

      console.log(`[workflow] Campaign ${campaignId}: final label applied`);
    });

    await step.do("close", async () => {
      await this.transition(db, campaignRunId, "closed", "Workflow: lifecycle complete");

      await db.update("campaign_runs", `id=eq.${campaignRunId}`, {
        status: "completed",
        closed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      console.log(`[workflow] Campaign ${campaignId}: closed`);
    });
  }

  private shouldBuild(expectedAction: string): boolean {
    return ["build_skill", "build_tool", "run_experiment"].includes(expectedAction);
  }

  private async transition(db: SupabaseDB, runId: string, stage: string, reason: string) {
    const now = new Date().toISOString();
    await db.update("campaign_runs", `id=eq.${runId}`, {
      lifecycle_stage: stage,
      updated_at: now,
    });
    await db.insert("audit_log", {
      id: this.randomId(),
      entity_type: "campaign_run",
      entity_id: runId,
      action: "status_changed",
      new_value: { lifecycleStage: stage },
      actor: "workflow",
      reason,
      created_at: now,
    });
  }

  private async callBrain(
    action: string,
    params: Record<string, string>,
  ): Promise<{ ok: boolean }> {
    const brainUrl = this.env.ATLAS_VPS_BRAIN_URL || "https://api.joinatlas.xyz";
    const token = this.env.NEYNAR_WEBHOOK_SECRET;
    if (!token) {
      console.error("[workflow] NEYNAR_WEBHOOK_SECRET missing; refusing brain call");
      return { ok: false };
    }

    try {
      const res = await fetch(`${brainUrl}/api/brain`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ action, ...params }),
      });
      return { ok: res.ok };
    } catch (err: any) {
      console.error(`[workflow] Brain call failed: ${err.message}`);
      return { ok: false };
    }
  }

  private randomId(): string {
    const arr = new Uint8Array(12);
    crypto.getRandomValues(arr);
    return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
  }
}
