import {
  getDb,
  outcomeChecks,
  campaignRuns,
  questions,
  auditLog,
  createId,
} from "../../../../packages/db/src/index.js";
import {
  getDueChecks,
  synthesizeCampaign,
  transitionCampaign,
} from "../../../../packages/agent/src/index.js";
import { createHttpLootiClient } from "../../../../packages/sdk/src/index.js";
import { and, eq, lte } from "drizzle-orm";

export async function runLifecycleCheck(): Promise<void> {
  const db = getDb();
  await processCampaignIntegrityBackstop(db);
  await processCollectExpiryBackstop(db);

  const dueChecks = await getDueChecks(db);

  if (dueChecks.length === 0) return;

  console.log(`[lifecycle] ${dueChecks.length} due checks`);

  for (const check of dueChecks) {
    const [claimed] = await db
      .update(outcomeChecks)
      .set({ status: "running", startedAt: new Date() })
      .where(and(eq(outcomeChecks.id, check.id), eq(outcomeChecks.status, "scheduled")))
      .returning();

    if (!claimed) continue;

    try {
      const run = await db.query.campaignRuns.findFirst({
        where: eq(campaignRuns.id, check.campaignRunId),
      });

      if (!run) {
        throw new Error(`Campaign run ${check.campaignRunId} not found`);
      }

      let result: string;

      switch (check.checkType) {
        case "day_7_synthesis":
          if (run.synthesisResult || run.synthesizedAt) {
            result = `Already synthesized (${run.synthesisResult || "unknown"})`;
            break;
          }
          if (process.env.ATLAS_LOOTI_API_BASE_URL && process.env.ATLAS_LOOTI_API_KEY) {
            // Pre-check: verify the Looti campaign still exists before attempting synthesis.
            const lootiCheck = run.campaignId ? await fetchLootiCampaign(run.campaignId) : null;
            if (run.campaignId && !lootiCheck) {
              result = `Looti campaign ${run.campaignId} not found; skipping synthesis`;
              break;
            }
            const synthesis = await synthesizeCampaign({
              db,
              campaignRunId: run.id,
              lootiClient: createHttpLootiClient({
                baseUrl: process.env.ATLAS_LOOTI_API_BASE_URL,
                apiKey: process.env.ATLAS_LOOTI_API_KEY,
              }),
              rewardSetLimit: readRewardSetLimit(),
              recordAllocations: process.env.ATLAS_RECORD_ALLOCATIONS === "true",
            });
            result = `Synthesized ${synthesis.rewardSet.entries.length} entries (${synthesis.synthesisResult})`;
            break;
          }
          if (run.lifecycleStage === "collect") {
            await transitionCampaign(db, run.id, "synthesize", "Day 7 auto-trigger");
          }
          result = `Ready for synthesis (was: ${run.lifecycleStage})`;
          break;

        case "day_30_evaluation":
          if (run.lifecycleStage === "build_test") {
            await transitionCampaign(db, run.id, "evaluate", "Day 30 auto-trigger");
          }
          result = `Day 30 evaluation (was: ${run.lifecycleStage})`;
          break;

        case "day_90_final_label":
          if (run.lifecycleStage !== "closed" && run.lifecycleStage !== "remember") {
            await transitionCampaign(db, run.id, "remember", "Day 90 final label");
            await transitionCampaign(db, run.id, "closed", "Day 90 final label complete");
          } else if (run.lifecycleStage === "remember") {
            await transitionCampaign(db, run.id, "closed", "Day 90 final label complete");
          }
          result = `Final label applied`;
          break;

        default:
          result = `Unknown check: ${check.checkType}`;
      }

      await db
        .update(outcomeChecks)
        .set({ status: "completed", completedAt: new Date(), result })
        .where(eq(outcomeChecks.id, check.id));
    } catch (err: any) {
      await db
        .update(outcomeChecks)
        .set({ status: "failed", completedAt: new Date(), result: err.message })
        .where(eq(outcomeChecks.id, check.id));
      console.error(`[lifecycle] ✗ ${check.checkType}: ${err.message}`);
    }
  }
}

async function processCampaignIntegrityBackstop(db: ReturnType<typeof getDb>): Promise<void> {
  const activeRuns = await db
    .select({
      id: campaignRuns.id,
      campaignId: campaignRuns.campaignId,
      questionId: campaignRuns.questionId,
      lifecycleStage: campaignRuns.lifecycleStage,
      expectedAction: campaignRuns.expectedAction,
      collectEndsAt: campaignRuns.collectEndsAt,
      splitAddress: campaignRuns.splitAddress,
      fundingTxHash: campaignRuns.fundingTxHash,
      metadata: campaignRuns.metadata,
      castHash: questions.farcasterCastHash,
    })
    .from(campaignRuns)
    .leftJoin(questions, eq(campaignRuns.questionId, questions.id))
    .where(eq(campaignRuns.status, "active"));

  for (const run of activeRuns) {
    if (!run.campaignId) continue;

    const lootiCampaign = await fetchLootiCampaign(run.campaignId);
    if (lootiCampaign) {
      const splitAddress = lootiCampaign.split?.splitAddress || run.splitAddress || null;
      const fundingTxHash = lootiCampaign.split?.fundingTxHash || run.fundingTxHash || null;
      const metadata = {
        ...(run.metadata || {}),
        targetCastHash: lootiCampaign.targetCastHash || run.castHash,
        lootiStatus: lootiCampaign.status,
        rewardSetReady: lootiCampaign.rewardSetReady,
        lootiExpiresAt: readLootiExpiresAt(lootiCampaign)?.toISOString(),
        splitType: lootiCampaign.split?.splitType,
        splitController: lootiCampaign.split?.controller,
        integrityCheckedAt: new Date().toISOString(),
      };

      if (
        splitAddress !== run.splitAddress ||
        fundingTxHash !== run.fundingTxHash ||
        metadata.targetCastHash !== (run.metadata || {}).targetCastHash
      ) {
        const expiresAt = readLootiExpiresAt(lootiCampaign);
        await db
          .update(campaignRuns)
          .set({
            splitAddress,
            fundingTxHash,
            metadata,
            ...(expiresAt && run.lifecycleStage === "collect" ? { collectEndsAt: addMinutes(expiresAt, 10) } : {}),
            updatedAt: new Date(),
          })
          .where(eq(campaignRuns.id, run.id));
        await db.insert(auditLog).values({
          id: createId(),
          entityType: "campaign_run",
          entityId: run.id,
          action: "integrity_repaired",
          newValue: { campaignId: run.campaignId, splitAddress, fundingTxHash, targetCastHash: metadata.targetCastHash },
          actor: "atlas_agent",
          reason: "Lifecycle integrity backstop repaired Looti campaign metadata",
        });
      }
    }

    if (run.lifecycleStage === "collect" && run.castHash) {
      await ensureWorkflowStarted({
        campaignRunId: run.id,
        campaignId: run.campaignId,
        questionId: run.questionId || "",
        expectedAction: run.expectedAction,
        castHash: run.castHash,
      });
    }
  }
}

async function fetchLootiCampaign(campaignId: string): Promise<any | null> {
  const baseUrl = process.env.ATLAS_LOOTI_API_BASE_URL;
  const apiKey = process.env.ATLAS_LOOTI_API_KEY;
  if (!baseUrl || !apiKey) return null;

  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/atlas/campaigns/${encodeURIComponent(campaignId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      console.error(`[lifecycle] Looti campaign check failed for ${campaignId}: ${res.status} ${await res.text()}`);
      return null;
    }
    return await res.json();
  } catch (err: any) {
    console.error(`[lifecycle] Looti campaign check error for ${campaignId}: ${err.message}`);
    return null;
  }
}

function isRewardSetReady(campaign: any): boolean {
  return campaign?.rewardSetReady === true || String(campaign?.status || "").toLowerCase() === "completed";
}

function readLootiExpiresAt(campaign: any): Date | null {
  const value = campaign?.expiresAt;
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 10_000_000_000 ? value : value * 1000;
    return new Date(ms);
  }
  if (typeof value === "string") {
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) return date;
  }
  return null;
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

async function ensureWorkflowStarted(input: {
  campaignRunId: string;
  campaignId: string;
  questionId: string;
  expectedAction: string;
  castHash: string;
}): Promise<void> {
  const workerUrl = process.env.ATLAS_CF_WORKER_URL || "https://atlas-worker.jacob-247.workers.dev";
  const token = process.env.NEYNAR_WEBHOOK_SECRET;
  if (!token || !input.questionId) return;

  try {
    const statusRes = await fetch(`${workerUrl}/workflow/campaign/${encodeURIComponent(input.campaignRunId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (statusRes.ok) return;
    if (statusRes.status !== 404) {
      console.error(`[lifecycle] Workflow status check failed for ${input.campaignRunId}: ${statusRes.status} ${await statusRes.text()}`);
      return;
    }

    const createRes = await fetch(`${workerUrl}/workflow/campaign`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        ...input,
        collectDays: readCollectDays(),
      }),
    });
    if (!createRes.ok) {
      console.error(`[lifecycle] Workflow recovery failed for ${input.campaignRunId}: ${createRes.status} ${await createRes.text()}`);
      return;
    }
    console.log(`[lifecycle] Workflow recovery started for ${input.campaignId}`);
  } catch (err: any) {
    console.error(`[lifecycle] Workflow recovery error for ${input.campaignRunId}: ${err.message}`);
  }
}

async function processCollectExpiryBackstop(db: ReturnType<typeof getDb>): Promise<void> {
  const expiredCollectRuns = await db
    .select()
    .from(campaignRuns)
    .where(
      and(
        eq(campaignRuns.status, "active"),
        eq(campaignRuns.lifecycleStage, "collect"),
        lte(campaignRuns.collectEndsAt, new Date()),
      ),
    );

  if (expiredCollectRuns.length === 0) return;

  console.log(`[lifecycle] ${expiredCollectRuns.length} collect windows expired`);

  for (const run of expiredCollectRuns) {
    if (run.campaignId) {
      const lootiCampaign = await fetchLootiCampaign(run.campaignId);
      if (lootiCampaign && !isRewardSetReady(lootiCampaign)) {
        const expiresAt = readLootiExpiresAt(lootiCampaign);
        await db
          .update(campaignRuns)
          .set({
            collectEndsAt: expiresAt ? addMinutes(expiresAt, 10) : addHours(new Date(), 1),
            metadata: {
              ...(run.metadata || {}),
              lootiStatus: lootiCampaign.status,
              rewardSetReady: lootiCampaign.rewardSetReady,
              lootiExpiresAt: expiresAt?.toISOString(),
              synthesisDeferredAt: new Date().toISOString(),
            },
            updatedAt: new Date(),
          })
          .where(eq(campaignRuns.id, run.id));
        console.log(`[lifecycle] Deferring synthesis for ${run.campaignId}; Looti reward set is not ready`);
        continue;
      }
    }

    if (process.env.ATLAS_LOOTI_API_BASE_URL && process.env.ATLAS_LOOTI_API_KEY) {
      const synthesis = await synthesizeCampaign({
        db,
        campaignRunId: run.id,
        lootiClient: createHttpLootiClient({
          baseUrl: process.env.ATLAS_LOOTI_API_BASE_URL,
          apiKey: process.env.ATLAS_LOOTI_API_KEY,
        }),
        rewardSetLimit: readRewardSetLimit(),
        recordAllocations: process.env.ATLAS_RECORD_ALLOCATIONS === "true",
      });
      console.log(
        `[lifecycle] Backstop synthesized ${run.campaignId}: ${synthesis.rewardSet.entries.length} entries (${synthesis.synthesisResult})`,
      );
      await completeSynthesisCheckIfPresent(db, run.id, synthesis.synthesisResult);
      continue;
    }

    await transitionCampaign(
      db,
      run.id,
      "synthesize",
      "Collect window expired; synthesis backstop triggered",
    );
    console.log(`[lifecycle] Backstop moved ${run.campaignId} to synthesize`);
  }
}

async function completeSynthesisCheckIfPresent(
  db: ReturnType<typeof getDb>,
  campaignRunId: string,
  synthesisResult: string,
): Promise<void> {
  await db
    .update(outcomeChecks)
    .set({
      status: "completed",
      completedAt: new Date(),
      result: `Completed by collect-expiry backstop (${synthesisResult})`,
    })
    .where(
      and(
        eq(outcomeChecks.campaignRunId, campaignRunId),
        eq(outcomeChecks.checkType, "day_7_synthesis"),
        eq(outcomeChecks.status, "scheduled"),
      ),
    );
}

function readRewardSetLimit(): 3 | 10 {
  const value = process.env.ATLAS_REWARD_SET_LIMIT || "10";
  if (value === "3") return 3;
  if (value === "10") return 10;
  throw new Error("ATLAS_REWARD_SET_LIMIT must be 3 or 10");
}

function readCollectDays(): number {
  const value = Number.parseInt(process.env.ATLAS_COLLECT_DAYS || "", 10);
  return Number.isFinite(value) && value > 0 ? value : 1;
}
