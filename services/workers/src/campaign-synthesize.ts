/**
 * Day 7 synthesis worker: writes reward-set artifacts, ingests answers into DB,
 * and advances the campaign lifecycle.
 */
import { getDb } from "../../../packages/db/src/index.js";
import { createHttpLootiClient } from "../../../packages/sdk/src/index.js";
import { synthesizeCampaign } from "../../../packages/agent/src/index.js";

async function main() {
  const db = getDb();
  const campaignRunId = requireEnv("ATLAS_CAMPAIGN_RUN_ID");
  const rewardSetLimit = readRewardSetLimit();

  const lootiClient = createHttpLootiClient({
    baseUrl: requireEnv("ATLAS_LOOTI_API_BASE_URL"),
    apiKey: requireEnv("ATLAS_LOOTI_API_KEY"),
  });

  const result = await synthesizeCampaign({
    db,
    campaignRunId,
    lootiClient,
    rewardSetLimit,
    recordAllocations: process.env.ATLAS_RECORD_ALLOCATIONS === "true",
  });

  console.log(
    JSON.stringify(
      {
        event: "atlas.campaign.synthesize",
        campaignRunId: result.campaignRunId,
        campaignId: result.campaignId,
        rewardSetLimit,
        entries: result.rewardSet.entries.length,
        answersInserted: result.answersInserted,
        answersSkipped: result.answersSkipped,
        synthesisResult: result.synthesisResult,
        nextStage: result.nextStage,
        snapshotId: result.rewardSet.snapshotId,
        artifactPaths: result.artifactPaths,
      },
      null,
      2,
    ),
  );

  process.exit(0);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function readRewardSetLimit(): 3 | 10 {
  const value = process.env.ATLAS_REWARD_SET_LIMIT || "10";
  if (value === "3") return 3;
  if (value === "10") return 10;
  throw new Error("ATLAS_REWARD_SET_LIMIT must be 3 or 10");
}

main().catch((err) => {
  console.error("[synthesize] Fatal:", err);
  process.exit(1);
});
