import { mkdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  LootiCampaignBudget,
  LootiClient,
  PrepareLootiCampaignInput,
  PrepareLootiCampaignResult,
} from "../../sdk/src/index.js";
import { renderCampaignThread, type CampaignBrief, type CampaignThread } from "./campaign-brief.js";

export interface AtlasCampaignDryRunInput {
  atlasRunId: string;
  idempotencyKey: string;
  brief: CampaignBrief;
  promptCastHash: string;
  promptCastUrl?: string;
  creatorFid: number;
  creatorAddress: string;
  treasuryWalletAddress: string;
  budget: LootiCampaignBudget;
  expiresAt: string;
  timezone: string;
  chainId: number;
  maxSpendAmount: number;
  worldDir?: string;
  callLootiPrepare?: boolean;
  lootiClient?: LootiClient;
}

export interface AtlasCampaignDryRunResult {
  atlasRunId: string;
  idempotencyKey: string;
  dryRun: true;
  preparedAt: string;
  thread: CampaignThread;
  preparePayload: PrepareLootiCampaignInput;
  lootiPrepareResult?: PrepareLootiCampaignResult;
  artifactPath: string;
}

export function buildPrepareCampaignInput(input: AtlasCampaignDryRunInput): PrepareLootiCampaignInput {
  return {
    idempotencyKey: input.idempotencyKey,
    atlasRunId: input.atlasRunId,
    promptCastHash: input.promptCastHash,
    promptCastUrl: input.promptCastUrl,
    creatorFid: input.creatorFid,
    creatorAddress: input.creatorAddress,
    budget: input.budget,
    funding: {
      mode: "atlas_treasury_splits_v2",
      treasuryWalletAddress: input.treasuryWalletAddress,
      maxSpendAmount: input.maxSpendAmount,
      chainId: input.chainId,
    },
    rewardMode: input.brief.rewardMode,
    expiresAt: input.expiresAt,
    timezone: input.timezone,
    metadata: {
      source: "atlas",
      dryRun: true,
      problem: input.brief.problem,
      question: input.brief.question,
    },
  };
}

export async function runCampaignDryRun(input: AtlasCampaignDryRunInput): Promise<AtlasCampaignDryRunResult> {
  const thread = renderCampaignThread(input.brief);
  const preparePayload = buildPrepareCampaignInput(input);
  const lootiPrepareResult =
    input.callLootiPrepare === true
      ? await requireLootiClient(input.lootiClient).prepareCampaign(preparePayload)
      : undefined;

  const worldDir = input.worldDir || process.env.ATLAS_WORLD_DIR || "world";
  const campaignsDir = resolve(process.cwd(), worldDir, "campaigns");
  await mkdir(campaignsDir, { recursive: true });

  const artifactPath = resolve(campaignsDir, `${input.atlasRunId}.dry-run.json`);
  const result: AtlasCampaignDryRunResult = {
    atlasRunId: input.atlasRunId,
    idempotencyKey: input.idempotencyKey,
    dryRun: true,
    preparedAt: new Date().toISOString(),
    thread,
    preparePayload,
    lootiPrepareResult,
    artifactPath,
  };

  const tmpPath = `${artifactPath}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await rename(tmpPath, artifactPath);

  return result;
}

function requireLootiClient(lootiClient: LootiClient | undefined): LootiClient {
  if (!lootiClient) {
    throw new Error("callLootiPrepare requires a Looti client");
  }

  return lootiClient;
}
