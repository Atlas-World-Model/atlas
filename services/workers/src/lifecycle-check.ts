/**
 * Lifecycle check worker — runs on a schedule (e.g. every 6 hours).
 * Finds due outcome checks and processes them.
 *
 * Usage: bun services/workers/src/lifecycle-check.ts
 */
import { getDb, outcomeChecks, campaignRuns } from "../../../packages/db/src/index.js";
import { getDueChecks, synthesizeCampaign, transitionCampaign } from "../../../packages/agent/src/index.js";
import { createHttpLootiClient } from "../../../packages/sdk/src/index.js";
import { and, eq } from "drizzle-orm";

async function main() {
  const db = getDb();
  const dueChecks = await getDueChecks(db);

  console.log(`[lifecycle-check] Found ${dueChecks.length} due checks`);

  for (const check of dueChecks) {
    console.log(
      `[lifecycle-check] Processing ${check.checkType} for campaign_run ${check.campaignRunId}`,
    );

    const [claimed] = await db
      .update(outcomeChecks)
      .set({ status: "running", startedAt: new Date() })
      .where(and(eq(outcomeChecks.id, check.id), eq(outcomeChecks.status, "scheduled")))
      .returning();

    if (!claimed) {
      console.log(`[lifecycle-check] Skipping already-claimed check ${check.id}`);
      continue;
    }

    try {
      const run = await db.query.campaignRuns.findFirst({
        where: eq(campaignRuns.id, check.campaignRunId),
      });

      if (!run) {
        throw new Error(`Campaign run ${check.campaignRunId} not found`);
      }

      let result: string;

      switch (check.checkType) {
        case "day_7_synthesis": {
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
            result = `Synthesized ${synthesis.rewardSet.entries.length} entries (${synthesis.synthesisResult})`;
            break;
          }
          if (run.lifecycleStage === "collect") {
            await transitionCampaign(
              db,
              run.id,
              "synthesize",
              "Day 7 synthesis check triggered",
            );
          }
          result = `Campaign ${run.campaignId} ready for synthesis (stage: ${run.lifecycleStage})`;
          break;
        }

        case "day_30_evaluation": {
          // If in build_test, transition to evaluate
          if (run.lifecycleStage === "build_test") {
            await transitionCampaign(
              db,
              run.id,
              "evaluate",
              "Day 30 evaluation check triggered",
            );
          }
          result = `Campaign ${run.campaignId} day 30 evaluation (stage: ${run.lifecycleStage})`;
          break;
        }

        case "day_90_final_label": {
          // Final label — transition to remember then closed
          let currentRun = run;
          if (
            currentRun.lifecycleStage !== "closed" &&
            currentRun.lifecycleStage !== "remember"
          ) {
            currentRun = await transitionCampaign(
              db,
              run.id,
              "remember",
              "Day 90 final label — recording outcomes",
            );
          }
          if (currentRun.lifecycleStage !== "closed") {
            await transitionCampaign(
              db,
              run.id,
              "closed",
              "Day 90 final label complete",
            );
          }
          result = `Campaign ${run.campaignId} closed with final label`;
          break;
        }

        default:
          result = `Unknown check type: ${check.checkType}`;
      }

      // Mark completed
      await db
        .update(outcomeChecks)
        .set({ status: "completed", completedAt: new Date(), result })
        .where(eq(outcomeChecks.id, check.id));

      console.log(`[lifecycle-check] ✓ ${check.checkType}: ${result}`);
    } catch (err: any) {
      await db
        .update(outcomeChecks)
        .set({
          status: "failed",
          completedAt: new Date(),
          result: err.message,
        })
        .where(eq(outcomeChecks.id, check.id));

      console.error(
        `[lifecycle-check] ✗ ${check.checkType}: ${err.message}`,
      );
    }
  }

  console.log(`[lifecycle-check] Done. Processed ${dueChecks.length} checks.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[lifecycle-check] Fatal:", err);
  process.exit(1);
});

function readRewardSetLimit(): 3 | 10 {
  const value = process.env.ATLAS_REWARD_SET_LIMIT || "10";
  if (value === "3") return 3;
  if (value === "10") return 10;
  throw new Error("ATLAS_REWARD_SET_LIMIT must be 3 or 10");
}
