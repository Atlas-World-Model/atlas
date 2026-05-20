import { mkdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Address, Hex } from "viem";
import {
  buildFundingInputFromPrepare,
  fundPreparedLootiSplit,
  type AtlasFundedSplit,
  type CreateLootiCampaignResult,
  type LootiClient,
  type PrepareLootiCampaignInput,
  type PrepareLootiCampaignResult,
} from "../../sdk/src/index.js";
import {
  buildPrepareCampaignInput,
  type AtlasCampaignDryRunInput,
} from "./campaign-runner.js";
import { renderCampaignThread, type CampaignThread } from "./campaign-brief.js";

export interface AtlasCampaignLaunchInput extends AtlasCampaignDryRunInput {
  liveFundingEnabled: boolean;
  liveActivationEnabled: boolean;
  treasuryPrivateKey: Hex;
  rpcUrl?: string;
  allowReuseDeployedSplit?: boolean;
  allowAdditionalFunding?: boolean;
}

export interface AtlasCampaignLaunchResult {
  atlasRunId: string;
  idempotencyKey: string;
  live: true;
  launchedAt: string;
  thread: CampaignThread;
  preparePayload: PrepareLootiCampaignInput;
  lootiPrepareResult: PrepareLootiCampaignResult;
  fundedSplit: AtlasFundedSplit;
  lootiCreateResult: CreateLootiCampaignResult;
  artifactPath: string;
  recoveryArtifactPath: string;
}

export async function runCampaignLaunch(
  input: AtlasCampaignLaunchInput
): Promise<AtlasCampaignLaunchResult> {
  if (!input.liveFundingEnabled) {
    throw new Error("Live funding requires ATLAS_LIVE_FUNDING_ENABLED=true");
  }

  if (!input.liveActivationEnabled) {
    throw new Error("Live activation requires ATLAS_LIVE_ACTIVATION_ENABLED=true");
  }

  const lootiClient = requireLootiClient(input.lootiClient);
  const thread = renderCampaignThread(input.brief);
  const preparePayload = buildPrepareCampaignInput(input);
  const worldDir = input.worldDir || process.env.ATLAS_WORLD_DIR || "world";
  const campaignsDir = resolve(process.cwd(), worldDir, "campaigns");
  await mkdir(campaignsDir, { recursive: true });
  const artifactPath = resolve(campaignsDir, `${input.atlasRunId}.launch.json`);
  const recoveryArtifactPath = resolve(campaignsDir, `${input.atlasRunId}.funding-recovery.json`);

  const lootiPrepareResult = await lootiClient.prepareCampaign(preparePayload);

  const fundingResult = await fundPreparedLootiSplit(
    buildFundingInputFromPrepare({
      idempotencyKey: input.idempotencyKey,
      treasuryPrivateKey: input.treasuryPrivateKey,
      expectedTreasuryAddress: input.treasuryWalletAddress as Address,
      prepareResult: lootiPrepareResult,
      rpcUrl: input.rpcUrl,
      allowReuseDeployedSplit: input.allowReuseDeployedSplit,
      allowAdditionalFunding: input.allowAdditionalFunding,
    })
  );

  await writeJsonAtomic(recoveryArtifactPath, {
    atlasRunId: input.atlasRunId,
    idempotencyKey: input.idempotencyKey,
    writtenAt: new Date().toISOString(),
    status: "funded_not_activated",
    preparePayload,
    lootiPrepareResult,
    fundedSplit: fundingResult.fundedSplit,
    amountInBaseUnits: fundingResult.amountInBaseUnits,
    treasuryWalletAddress: fundingResult.treasuryWalletAddress,
  });

  const createPayload = {
    ...preparePayload,
    preparedRequestId: lootiPrepareResult.requestId,
    fundedSplit: fundingResult.fundedSplit,
  };
  const lootiCreateResult = await lootiClient.createCampaign(createPayload);

  const result: AtlasCampaignLaunchResult = {
    atlasRunId: input.atlasRunId,
    idempotencyKey: input.idempotencyKey,
    live: true,
    launchedAt: new Date().toISOString(),
    thread,
    preparePayload,
    lootiPrepareResult,
    fundedSplit: fundingResult.fundedSplit,
    lootiCreateResult,
    artifactPath,
    recoveryArtifactPath,
  };

  await writeJsonAtomic(artifactPath, result);

  return result;
}

function requireLootiClient(lootiClient: LootiClient | undefined): LootiClient {
  if (!lootiClient) {
    throw new Error("Campaign launch requires a Looti client");
  }

  return lootiClient;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmpPath, path);
}
