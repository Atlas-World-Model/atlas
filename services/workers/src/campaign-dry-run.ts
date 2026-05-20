import { createHttpLootiClient } from "../../../packages/sdk/src/index.js";
import { runCampaignDryRun } from "../../../packages/agent/src/index.js";
import type { CampaignBrief } from "../../../packages/agent/src/index.js";
import type { LootiCampaignBudget } from "../../../packages/sdk/src/index.js";

const callLootiPrepare = process.env.ATLAS_DRY_RUN_CALL_LOOTI === "true";
const atlasRunId = process.env.ATLAS_RUN_ID || `campaign-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const idempotencyKey = process.env.ATLAS_IDEMPOTENCY_KEY || atlasRunId;

const brief: CampaignBrief = {
  problem:
    process.env.ATLAS_CAMPAIGN_PROBLEM ||
    "how small Farcaster groups can turn useful discussion into shared working memory.",
  currentBelief:
    process.env.ATLAS_CAMPAIGN_BELIEF ||
    "People contribute better when they can see how their answer may change the shared record.",
  question:
    process.env.ATLAS_CAMPAIGN_QUESTION ||
    "What is one concrete practice that helps a small online group solve problems together?",
  evidenceRequested: (process.env.ATLAS_CAMPAIGN_EVIDENCE || "examples,failure cases,tools,rituals,metrics")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
  useOfResults:
    process.env.ATLAS_CAMPAIGN_USE ||
    "Winning responses may update my world-state, entity registry, or next campaign.",
  rewardMode: process.env.ATLAS_REWARD_MODE === "top_3" ? "top_3" : "top_10",
};

const budget: LootiCampaignBudget = {
  amount: readNumberEnv("ATLAS_CAMPAIGN_BUDGET_AMOUNT", 50),
  token: process.env.ATLAS_CAMPAIGN_TOKEN || "USDC",
  tokenAddress: process.env.ATLAS_CAMPAIGN_TOKEN_ADDRESS || "0x0000000000000000000000000000000000000000",
  tokenDecimals: readNumberEnv("ATLAS_CAMPAIGN_TOKEN_DECIMALS", 6),
  usdValueAtCreation: readOptionalNumberEnv("ATLAS_CAMPAIGN_USD_VALUE"),
};

const lootiClient =
  callLootiPrepare === true
    ? createHttpLootiClient({
        baseUrl: requireEnv("ATLAS_LOOTI_API_BASE_URL"),
        apiKey: requireEnv("ATLAS_LOOTI_API_KEY"),
      })
    : undefined;

if (callLootiPrepare) {
  requireLivePrepareEnv();
}

const result = await runCampaignDryRun({
  atlasRunId,
  idempotencyKey,
  brief,
  promptCastHash: process.env.ATLAS_PROMPT_CAST_HASH || "0xDRY_RUN_PROMPT_CAST_HASH",
  promptCastUrl: process.env.ATLAS_PROMPT_CAST_URL,
  creatorFid: readNumberEnv("ATLAS_CREATOR_FID", 0),
  creatorAddress: process.env.ATLAS_CREATOR_ADDRESS || "0x0000000000000000000000000000000000000000",
  treasuryWalletAddress:
    process.env.ATLAS_TREASURY_WALLET_ADDRESS || "0x0000000000000000000000000000000000000000",
  budget,
  expiresAt: process.env.ATLAS_CAMPAIGN_EXPIRES_AT || defaultExpiresAt(),
  timezone: process.env.ATLAS_TIMEZONE || "America/New_York",
  chainId: readNumberEnv("ATLAS_CHAIN_ID", 8453),
  maxSpendAmount: readNumberEnv("ATLAS_CAMPAIGN_MAX_SPEND_AMOUNT", budget.amount),
  callLootiPrepare,
  lootiClient,
});

console.log(
  JSON.stringify(
    {
      event: "atlas.campaign.dry_run",
      atlasRunId: result.atlasRunId,
      idempotencyKey: result.idempotencyKey,
      artifactPath: result.artifactPath,
      calledLootiPrepare: callLootiPrepare,
      lootiStatus: result.lootiPrepareResult?.status,
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

function requireLivePrepareEnv(): void {
  const required = [
    "ATLAS_LOOTI_API_BASE_URL",
    "ATLAS_LOOTI_API_KEY",
    "ATLAS_PROMPT_CAST_HASH",
    "ATLAS_CREATOR_FID",
    "ATLAS_CREATOR_ADDRESS",
    "ATLAS_TREASURY_WALLET_ADDRESS",
    "ATLAS_CAMPAIGN_TOKEN_ADDRESS",
  ];

  for (const name of required) {
    const value = process.env[name];
    if (!value || value === "0x0000000000000000000000000000000000000000") {
      throw new Error(`${name} must be set before calling Looti prepare`);
    }
  }

  if (process.env.ATLAS_PROMPT_CAST_HASH === "0xDRY_RUN_PROMPT_CAST_HASH") {
    throw new Error("ATLAS_PROMPT_CAST_HASH must be a real cast hash before calling Looti prepare");
  }
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
