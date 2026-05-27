import { readWorldState } from "../../memory/src/index.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface AtlasTickResult {
  ok: true;
  worldStatePath: string;
  worldStateBytes: number;
  configPath: string;
  configBytes: number;
  heartbeat: AtlasHeartbeat;
  observedAt: string;
}

export interface AtlasHeartbeat {
  status: "ok";
  checks: Array<{
    name: string;
    status: "ok" | "warning" | "failed";
    detail: string;
  }>;
}

export { renderCampaignThread, type CampaignBrief, type CampaignThread } from "./campaign-brief.js";
export {
  buildPrepareCampaignInput,
  runCampaignDryRun,
  type AtlasCampaignDryRunInput,
  type AtlasCampaignDryRunResult,
} from "./campaign-runner.js";
export {
  runCampaignLaunch,
  type AtlasCampaignLaunchInput,
  type AtlasCampaignLaunchResult,
} from "./campaign-launcher.js";
export {
  buildAtlasAllocations,
  ingestRewardSet,
  type IngestRewardSetInput,
  type IngestRewardSetResult,
} from "./reward-set-ingestion.js";
export {
  synthesizeCampaign,
  type SynthesizeCampaignInput,
  type SynthesizeCampaignResult,
} from "./campaign-synthesis.js";

export {
  transitionCampaign,
  initCampaignRun,
  getDueChecks,
} from "./campaign-lifecycle.js";

export {
  updateReputation,
  recordRankedCampaignOutcome,
  applyTimeDecay,
  computeReputationFromOutcomes,
} from "./reputation.js";

export {
  closeReviewLoop,
  type CloseReviewLoopInput,
  type CloseReviewLoopResult,
} from "./close-review-loop.js";

async function readRuntimeConfig(): Promise<{ path: string; content: string }> {
  const path = resolve(process.cwd(), "atlas.yml");
  const content = await readFile(path, "utf8");
  return { path, content };
}

export function buildHeartbeat(input: {
  worldStateBytes: number;
  configBytes: number;
}): AtlasHeartbeat {
  return {
    status: "ok",
    checks: [
      {
        name: "world-state",
        status: input.worldStateBytes > 0 ? "ok" : "failed",
        detail: `${input.worldStateBytes} bytes`,
      },
      {
        name: "runtime-config",
        status: input.configBytes > 0 ? "ok" : "failed",
        detail: `${input.configBytes} bytes`,
      },
      {
        name: "canonical-input-boundary",
        status: "ok",
        detail: "Looti reward sets are the only canonical public input path in V0",
      },
    ],
  };
}

export async function runAtlasTick(): Promise<AtlasTickResult> {
  const [world, config] = await Promise.all([
    readWorldState(process.env.ATLAS_WORLD_DIR || "world"),
    readRuntimeConfig(),
  ]);
  const heartbeat = buildHeartbeat({
    worldStateBytes: world.content.length,
    configBytes: config.content.length,
  });

  return {
    ok: true,
    worldStatePath: world.path,
    worldStateBytes: world.content.length,
    configPath: config.path,
    configBytes: config.content.length,
    heartbeat,
    observedAt: new Date().toISOString(),
  };
}
