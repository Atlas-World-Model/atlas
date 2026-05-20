import { and, eq } from "drizzle-orm";
import {
  answers,
  auditLog,
  campaignRuns,
  createId,
  type CampaignRun,
  type Db,
} from "../../db/src/index.js";
import type { LootiClient, LootiRewardSet, LootiRewardSetEntry } from "../../sdk/src/index.js";
import { ingestRewardSet } from "./reward-set-ingestion.js";
import { transitionCampaign } from "./campaign-lifecycle.js";

export interface SynthesizeCampaignInput {
  db: Db;
  campaignRunId: string;
  lootiClient: LootiClient;
  rewardSetLimit: 3 | 10;
  worldDir?: string;
  recordAllocations?: boolean;
}

export interface SynthesizeCampaignResult {
  campaignRunId: string;
  campaignId: string;
  rewardSet: LootiRewardSet;
  answersInserted: number;
  answersSkipped: number;
  synthesisResult: string;
  nextStage: CampaignRun["lifecycleStage"];
  artifactPaths: {
    rewardSet: string;
    evidence: string;
    memoryCandidate: string;
    review: string;
    allocations: string;
  };
}

export async function synthesizeCampaign(
  input: SynthesizeCampaignInput,
): Promise<SynthesizeCampaignResult> {
  const run = await input.db.query.campaignRuns.findFirst({
    where: eq(campaignRuns.id, input.campaignRunId),
  });

  if (!run) throw new Error(`Campaign run ${input.campaignRunId} not found`);
  if (!run.campaignId) throw new Error("Campaign run has no campaignId");
  if (!run.questionId) throw new Error("Campaign run has no questionId");

  if (run.lifecycleStage === "ask") {
    await transitionCampaign(
      input.db,
      run.id,
      "collect",
      "Synthesis requested; opening collection first",
    );
  }

  const currentRun = await input.db.query.campaignRuns.findFirst({
    where: eq(campaignRuns.id, input.campaignRunId),
  });

  if (!currentRun) throw new Error(`Campaign run ${input.campaignRunId} not found`);

  if (currentRun.lifecycleStage === "collect") {
    await transitionCampaign(
      input.db,
      run.id,
      "synthesize",
      "Reward set synthesis started",
    );
  } else if (
    currentRun.lifecycleStage !== "synthesize" &&
    currentRun.lifecycleStage !== "build_test" &&
    currentRun.lifecycleStage !== "evaluate" &&
    currentRun.lifecycleStage !== "iterate" &&
    currentRun.lifecycleStage !== "remember" &&
    currentRun.lifecycleStage !== "closed"
  ) {
    throw new Error(`Cannot synthesize campaign from stage ${currentRun.lifecycleStage}`);
  }

  const ingestion = await ingestRewardSet({
    atlasRunId: run.atlasRunId || run.id,
    campaignId: run.campaignId,
    rewardSetLimit: input.rewardSetLimit,
    worldDir: input.worldDir,
    lootiClient: input.lootiClient,
    recordAllocations: input.recordAllocations,
  });

  const { inserted, skipped } = await ingestAnswersToDb(
    input.db,
    run.questionId,
    ingestion.rewardSet,
  );

  const synthesisResult = determineSynthesisResult(run, ingestion.rewardSet);
  const nextStage = nextStageForSynthesis(run, synthesisResult);

  await input.db
    .update(campaignRuns)
    .set({ synthesisResult, updatedAt: new Date() })
    .where(eq(campaignRuns.id, run.id));

  const latestRun = await input.db.query.campaignRuns.findFirst({
    where: eq(campaignRuns.id, run.id),
  });

  if (
    latestRun &&
    latestRun.lifecycleStage === "synthesize" &&
    nextStage !== "synthesize"
  ) {
    await transitionCampaign(
      input.db,
      run.id,
      nextStage,
      `Synthesis result: ${synthesisResult}`,
    );
  }

  await input.db.insert(auditLog).values({
    id: createId(),
    entityType: "campaign_run",
    entityId: run.id,
    action: "synthesized",
    newValue: {
      campaignId: run.campaignId,
      rewardSetSnapshotId: ingestion.rewardSet.snapshotId,
      entries: ingestion.rewardSet.entries.length,
      answersInserted: inserted,
      answersSkipped: skipped,
      synthesisResult,
      artifactPaths: ingestion.artifactPaths,
    },
    actor: "atlas_agent",
    reason: "Campaign reward set ingested and synthesized",
  });

  return {
    campaignRunId: run.id,
    campaignId: run.campaignId,
    rewardSet: ingestion.rewardSet,
    answersInserted: inserted,
    answersSkipped: skipped,
    synthesisResult,
    nextStage,
    artifactPaths: ingestion.artifactPaths,
  };
}

async function ingestAnswersToDb(
  db: Db,
  questionId: string,
  rewardSet: LootiRewardSet,
): Promise<{ inserted: number; skipped: number }> {
  let inserted = 0;
  let skipped = 0;

  for (const entry of rewardSet.entries) {
    const quote = entry.topQuotes[0];
    const existing = quote?.hash
      ? await db.query.answers.findFirst({
          where: and(
            eq(answers.questionId, questionId),
            eq(answers.farcasterCastHash, quote.hash),
          ),
        })
      : await db.query.answers.findFirst({
          where: and(
            eq(answers.questionId, questionId),
            eq(answers.responderFid, entry.fid),
            eq(answers.lootiRank, entry.rank),
          ),
        });

    if (existing) {
      skipped += 1;
      continue;
    }

    await db.insert(answers).values({
      id: createId(),
      questionId,
      farcasterCastHash: quote?.hash || null,
      responderFid: entry.fid,
      text: quote?.text || summarizeEntry(entry),
      lootiRank: entry.rank,
      lootiScore: String(quote?.lootiScore ?? entry.totalLootiScore),
      claims: [],
    });
    inserted += 1;
  }

  return { inserted, skipped };
}

function determineSynthesisResult(run: CampaignRun, rewardSet: LootiRewardSet): string {
  if (rewardSet.entries.length === 0) return "no_action";

  if (
    run.expectedAction === "build_skill" ||
    run.expectedAction === "build_tool" ||
    run.expectedAction === "run_experiment"
  ) {
    return "build";
  }

  if (run.expectedAction === "follow_up_question") return "follow_up";
  if (run.expectedAction === "memory_update") return "memory_only";
  return "manual_review";
}

function nextStageForSynthesis(
  run: CampaignRun,
  synthesisResult: string,
): CampaignRun["lifecycleStage"] {
  if (synthesisResult === "build") return "build_test";
  if (run.lifecycleStage === "closed" || run.lifecycleStage === "remember") {
    return run.lifecycleStage;
  }
  return "evaluate";
}

function summarizeEntry(entry: LootiRewardSetEntry): string {
  const quote = entry.topQuotes[0];
  const text = quote?.text?.replace(/\s+/g, " ").trim();
  if (!text) return `Looti rank ${entry.rank} entry from @${entry.username}`;
  return text;
}
