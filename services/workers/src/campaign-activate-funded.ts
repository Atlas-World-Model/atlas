import { mkdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHttpLootiClient } from "../../../packages/sdk/src/index.js";
import type {
  AtlasFundedSplit,
  CreateLootiCampaignInput,
  LootiCampaignBudget,
} from "../../../packages/sdk/src/index.js";

const atlasRunId = requireEnv("ATLAS_RUN_ID");
const idempotencyKey = requireEnv("ATLAS_IDEMPOTENCY_KEY");

const budget: LootiCampaignBudget = {
  amount: readNumberEnv("ATLAS_CAMPAIGN_BUDGET_AMOUNT", 50),
  token: process.env.ATLAS_CAMPAIGN_TOKEN || "USDC",
  tokenAddress: requireEnv("ATLAS_CAMPAIGN_TOKEN_ADDRESS"),
  tokenDecimals: readNumberEnv("ATLAS_CAMPAIGN_TOKEN_DECIMALS", 6),
  usdValueAtCreation: readOptionalNumberEnv("ATLAS_CAMPAIGN_USD_VALUE"),
};

const fundedSplit: AtlasFundedSplit = {
  mode: "atlas_treasury_splits_v2",
  splitAddress: requireEnv("ATLAS_FUNDED_SPLIT_ADDRESS"),
  splitCreationTxHash: requireEnv("ATLAS_SPLIT_CREATION_TX_HASH"),
  fundingTxHash: requireEnv("ATLAS_FUNDING_TX_HASH"),
  splitType: "pull",
  controller: requireEnv("ATLAS_SPLIT_CONTROLLER_ADDRESS"),
};

const lootiClient = createHttpLootiClient({
  baseUrl: requireEnv("ATLAS_LOOTI_API_BASE_URL"),
  apiKey: requireEnv("ATLAS_LOOTI_API_KEY"),
});

const createPayload: CreateLootiCampaignInput = {
  idempotencyKey,
  atlasRunId,
  promptCastHash: requireEnv("ATLAS_PROMPT_CAST_HASH"),
  promptCastUrl: process.env.ATLAS_PROMPT_CAST_URL,
  creatorFid: readNumberEnv("ATLAS_CREATOR_FID", 0),
  creatorAddress: requireEnv("ATLAS_CREATOR_ADDRESS"),
  budget,
  funding: {
    mode: "atlas_treasury_splits_v2",
    treasuryWalletAddress: requireEnv("ATLAS_TREASURY_WALLET_ADDRESS"),
    maxSpendAmount: readNumberEnv("ATLAS_CAMPAIGN_MAX_SPEND_AMOUNT", budget.amount),
    chainId: readNumberEnv("ATLAS_CHAIN_ID", 8453),
  },
  rewardMode: process.env.ATLAS_REWARD_MODE === "top_3" ? "top_3" : "top_10",
  expiresAt: process.env.ATLAS_CAMPAIGN_EXPIRES_AT || defaultExpiresAt(),
  timezone: process.env.ATLAS_TIMEZONE || "America/New_York",
  metadata: {
    source: "atlas",
    recoveredActivation: true,
  },
  fundedSplit,
};

const lootiCreateResult = await lootiClient.createCampaign(createPayload);

const worldDir = process.env.ATLAS_WORLD_DIR || "world";
const campaignsDir = resolve(process.cwd(), worldDir, "campaigns");
await mkdir(campaignsDir, { recursive: true });

const artifactPath = resolve(campaignsDir, `${atlasRunId}.activate-funded.json`);
const artifact = {
  atlasRunId,
  idempotencyKey,
  activatedAt: new Date().toISOString(),
  createPayload,
  lootiCreateResult,
  artifactPath,
};

const tmpPath = `${artifactPath}.tmp`;
await writeFile(tmpPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
await rename(tmpPath, artifactPath);

console.log(
  JSON.stringify(
    {
      event: "atlas.campaign.activate_funded",
      atlasRunId,
      idempotencyKey,
      campaignId: lootiCreateResult.campaignId,
      lootiStatus: lootiCreateResult.status,
      splitAddress: fundedSplit.splitAddress,
      fundingTxHash: fundedSplit.fundingTxHash,
      artifactPath,
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

function readNumberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number`);
  }

  return parsed;
}

function readOptionalNumberEnv(name: string): number | undefined {
  const value = process.env[name];
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number`);
  }

  return parsed;
}

function defaultExpiresAt(): string {
  const expiresAt = new Date();
  expiresAt.setUTCDate(expiresAt.getUTCDate() + 3);
  return expiresAt.toISOString();
}
