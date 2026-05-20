import { createHttpLootiClient } from "../../../packages/sdk/src/index.js";
import { getDb } from "../../../packages/db/src/index.js";
import { ingestRewardSet, synthesizeCampaign } from "../../../packages/agent/src/index.js";

const campaignId = requireEnv("ATLAS_CAMPAIGN_ID");
const rewardSetLimit = readRewardSetLimit();
const atlasRunId =
  process.env.ATLAS_RUN_ID ||
  `ingest-${campaignId}-${new Date().toISOString().replace(/[:.]/g, "-")}`;

const lootiClient = createHttpLootiClient({
  baseUrl: requireEnv("ATLAS_LOOTI_API_BASE_URL"),
  apiKey: requireEnv("ATLAS_LOOTI_API_KEY"),
});

if (process.env.ATLAS_CAMPAIGN_RUN_ID) {
  const result = await synthesizeCampaign({
    db: getDb(),
    campaignRunId: process.env.ATLAS_CAMPAIGN_RUN_ID,
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
        rewardSetLimit: result.rewardSet.rewardSetLimit,
        entries: result.rewardSet.entries.length,
        answersInserted: result.answersInserted,
        answersSkipped: result.answersSkipped,
        synthesisResult: result.synthesisResult,
        nextStage: result.nextStage,
        snapshotId: result.rewardSet.snapshotId,
        artifactPaths: result.artifactPaths,
      },
      null,
      2
    )
  );

  process.exit(0);
}

const result = await ingestRewardSet({
  atlasRunId,
  campaignId,
  rewardSetLimit,
  lootiClient,
  recordAllocations: process.env.ATLAS_RECORD_ALLOCATIONS === "true",
});

console.log(
  JSON.stringify(
    {
      event: "atlas.campaign.ingest_reward_set",
      atlasRunId: result.atlasRunId,
      campaignId: result.campaignId,
      rewardSetLimit: result.rewardSetLimit,
      entries: result.rewardSet.entries.length,
      snapshotId: result.rewardSet.snapshotId,
      recordedAllocations: result.recordedAllocations,
      artifactPaths: result.artifactPaths,
    },
    null,
    2
  )
);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}

function readRewardSetLimit(): 3 | 10 {
  const value = process.env.ATLAS_REWARD_SET_LIMIT || "10";
  if (value === "3") return 3;
  if (value === "10") return 10;

  throw new Error("ATLAS_REWARD_SET_LIMIT must be 3 or 10");
}
