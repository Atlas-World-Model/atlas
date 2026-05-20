import { createHttpLootiClient } from "../../../packages/sdk/src/index.js";
import { initCampaignRun, runCampaignLaunch } from "../../../packages/agent/src/index.js";
import { createId, getDb, questions } from "../../../packages/db/src/index.js";
import type { CampaignBrief } from "../../../packages/agent/src/index.js";
import type { LootiCampaignBudget } from "../../../packages/sdk/src/index.js";
import type { Hex } from "viem";
import { eq } from "drizzle-orm";

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
  tokenAddress: requireEnv("ATLAS_CAMPAIGN_TOKEN_ADDRESS"),
  tokenDecimals: readNumberEnv("ATLAS_CAMPAIGN_TOKEN_DECIMALS", 6),
  usdValueAtCreation: readOptionalNumberEnv("ATLAS_CAMPAIGN_USD_VALUE"),
};

requireLiveLaunchEnv();

const lootiClient = createHttpLootiClient({
  baseUrl: requireEnv("ATLAS_LOOTI_API_BASE_URL"),
  apiKey: requireEnv("ATLAS_LOOTI_API_KEY"),
});

const result = await runCampaignLaunch({
  atlasRunId,
  idempotencyKey,
  brief,
  promptCastHash: requireEnv("ATLAS_PROMPT_CAST_HASH"),
  promptCastUrl: process.env.ATLAS_PROMPT_CAST_URL,
  creatorFid: readNumberEnv("ATLAS_CREATOR_FID", 0),
  creatorAddress: requireEnv("ATLAS_CREATOR_ADDRESS"),
  treasuryWalletAddress: requireEnv("ATLAS_TREASURY_WALLET_ADDRESS"),
  treasuryPrivateKey: requireHexEnv("ATLAS_TREASURY_PRIVATE_KEY"),
  budget,
  expiresAt: process.env.ATLAS_CAMPAIGN_EXPIRES_AT || defaultExpiresAt(),
  timezone: process.env.ATLAS_TIMEZONE || "America/New_York",
  chainId: readNumberEnv("ATLAS_CHAIN_ID", 8453),
  maxSpendAmount: readNumberEnv("ATLAS_CAMPAIGN_MAX_SPEND_AMOUNT", budget.amount),
  callLootiPrepare: true,
  lootiClient,
  liveFundingEnabled: process.env.ATLAS_LIVE_FUNDING_ENABLED === "true",
  liveActivationEnabled: process.env.ATLAS_LIVE_ACTIVATION_ENABLED === "true",
  rpcUrl: process.env.ATLAS_BASE_RPC_URL,
  allowReuseDeployedSplit: process.env.ATLAS_ALLOW_REUSE_DEPLOYED_SPLIT === "true",
  allowAdditionalFunding: process.env.ATLAS_ALLOW_ADDITIONAL_FUNDING === "true",
});

let campaignRunId: string | undefined;
if (process.env.DATABASE_URL) {
  const db = getDb();
  const existingQuestion = await db.query.questions.findFirst({
    where: eq(questions.campaignId, result.lootiCreateResult.campaignId),
  });
  const question =
    existingQuestion ||
    (
      await db
        .insert(questions)
        .values({
          id: createId(),
          campaignId: result.lootiCreateResult.campaignId,
          farcasterCastHash: result.lootiCreateResult.targetCastHash,
          askerFid: result.preparePayload.creatorFid,
          text: brief.question,
          problem: brief.problem,
          currentBelief: brief.currentBelief,
          successTest: process.env.ATLAS_CAMPAIGN_SUCCESS_TEST || null,
          questionType: (process.env.ATLAS_QUESTION_TYPE as any) || "decision",
          resolvability: (process.env.ATLAS_RESOLVABILITY as any) || "unknown",
          expectedAction: (process.env.ATLAS_EXPECTED_ACTION as any) || "none",
          resolutionTargetAt: process.env.ATLAS_RESOLUTION_TARGET_AT
            ? new Date(process.env.ATLAS_RESOLUTION_TARGET_AT)
            : null,
        })
        .returning()
    )[0];

  const run = await initCampaignRun(db, {
    questionId: question.id,
    campaignId: result.lootiCreateResult.campaignId,
    atlasRunId,
    expectedAction: process.env.ATLAS_EXPECTED_ACTION || "none",
    collectDays: readNumberEnv("ATLAS_COLLECT_DAYS", 7),
  });
  campaignRunId = run.id;
}

console.log(
  JSON.stringify(
    {
      event: "atlas.campaign.launch",
      atlasRunId: result.atlasRunId,
      idempotencyKey: result.idempotencyKey,
      artifactPath: result.artifactPath,
      recoveryArtifactPath: result.recoveryArtifactPath,
      lootiStatus: result.lootiCreateResult.status,
      campaignId: result.lootiCreateResult.campaignId,
      campaignRunId,
      splitAddress: result.fundedSplit.splitAddress,
      fundingTxHash: result.fundedSplit.fundingTxHash,
    },
    null,
    2
  )
);

function requireLiveLaunchEnv(): void {
  const required = [
    "ATLAS_LOOTI_API_BASE_URL",
    "ATLAS_LOOTI_API_KEY",
    "ATLAS_PROMPT_CAST_HASH",
    "ATLAS_CREATOR_FID",
    "ATLAS_CREATOR_ADDRESS",
    "ATLAS_TREASURY_WALLET_ADDRESS",
    "ATLAS_TREASURY_PRIVATE_KEY",
    "ATLAS_CAMPAIGN_TOKEN_ADDRESS",
  ];

  for (const name of required) {
    const value = process.env[name];
    if (!value || value === "0x0000000000000000000000000000000000000000") {
      throw new Error(`${name} must be set before live campaign launch`);
    }
  }

  if (process.env.ATLAS_LIVE_FUNDING_ENABLED !== "true") {
    throw new Error("Set ATLAS_LIVE_FUNDING_ENABLED=true to allow onchain funding");
  }

  if (process.env.ATLAS_LIVE_ACTIVATION_ENABLED !== "true") {
    throw new Error("Set ATLAS_LIVE_ACTIVATION_ENABLED=true to allow Looti activation");
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}

function requireHexEnv(name: string): Hex {
  const value = requireEnv(name);
  const normalized = value.startsWith("0x") ? value : `0x${value}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error(`${name} must be a 32-byte private key`);
  }

  return normalized as Hex;
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
