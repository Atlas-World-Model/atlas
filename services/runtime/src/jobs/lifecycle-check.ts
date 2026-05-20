import {
  getDb,
  outcomeChecks,
  campaignRuns,
} from "../../../../packages/db/src/index.js";
import {
  getDueChecks,
  synthesizeCampaign,
  transitionCampaign,
} from "../../../../packages/agent/src/index.js";
import { createHttpLootiClient } from "../../../../packages/sdk/src/index.js";
import { and, eq } from "drizzle-orm";

export async function runLifecycleCheck(): Promise<void> {
  const db = getDb();
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

function readRewardSetLimit(): 3 | 10 {
  const value = process.env.ATLAS_REWARD_SET_LIMIT || "10";
  if (value === "3") return 3;
  if (value === "10") return 10;
  throw new Error("ATLAS_REWARD_SET_LIMIT must be 3 or 10");
}
