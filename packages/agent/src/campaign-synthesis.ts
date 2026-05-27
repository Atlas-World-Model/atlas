import { and, desc, eq, or } from "drizzle-orm";
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
import { recordRankedCampaignOutcome } from "./reputation.js";

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
    run.id,
    run.campaignId,
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
  campaignRunId: string,
  campaignId: string,
  rewardSet: LootiRewardSet,
): Promise<{ inserted: number; skipped: number }> {
  let inserted = 0;
  let skipped = 0;
  const conversationByFid = await loadCampaignConversationContext(db, campaignRunId, campaignId);

  for (const entry of rewardSet.entries) {
    const quote = entry.topQuotes[0];
    const baseAnswerText = quote?.text || summarizeEntry(entry);
    const answerText = appendConversationContext(
      baseAnswerText,
      conversationByFid.get(entry.fid),
    );
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
      if (answerText !== existing.text && !existing.text.includes("Follow-up thread:")) {
        await db
          .update(answers)
          .set({ text: answerText })
          .where(eq(answers.id, existing.id));
      }
      await recordRankedCampaignOutcome(db, {
        questionId,
        answerId: existing.id,
        campaignRunId,
        campaignId,
        fid: entry.fid,
        displayName: entry.displayName || entry.username,
        rank: entry.rank,
        score: quote?.lootiScore ?? entry.totalLootiScore,
        castHash: quote?.hash || null,
        answerText,
      });
      skipped += 1;
      continue;
    }

    const [answer] = await db
      .insert(answers)
      .values({
        id: createId(),
        questionId,
        farcasterCastHash: quote?.hash || null,
        responderFid: entry.fid,
        text: answerText,
        lootiRank: entry.rank,
        lootiScore: String(quote?.lootiScore ?? entry.totalLootiScore),
        claims: [],
      })
      .returning();
    await recordRankedCampaignOutcome(db, {
      questionId,
      answerId: answer.id,
      campaignRunId,
      campaignId,
      fid: entry.fid,
      displayName: entry.displayName || entry.username,
      rank: entry.rank,
      score: quote?.lootiScore ?? entry.totalLootiScore,
      castHash: quote?.hash || null,
      answerText,
    });
    inserted += 1;
  }

  return { inserted, skipped };
}

async function loadCampaignConversationContext(
  db: Db,
  campaignRunId: string,
  campaignId: string,
): Promise<Map<number, string[]>> {
  const rows = await db
    .select({ newValue: auditLog.newValue })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entityType, "campaign_contributor_snapshot"),
        or(
          eq(auditLog.entityId, campaignRunId),
          eq(auditLog.reason, campaignId),
        ),
      ),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(5);

  const conversations = new Map<number, string[]>();
  for (const row of rows.reverse()) {
    const snapshot = row.newValue && typeof row.newValue === "object"
      ? row.newValue as Record<string, unknown>
      : {};
    const contributors = Array.isArray(snapshot.contributors) ? snapshot.contributors : [];
    for (const rawContributor of contributors) {
      if (!rawContributor || typeof rawContributor !== "object") continue;
      const contributor = rawContributor as Record<string, unknown>;
      const fid = typeof contributor.fid === "number"
        ? contributor.fid
        : Number(contributor.fid);
      if (!Number.isFinite(fid)) continue;

      const conversation = Array.isArray(contributor.conversation)
        ? contributor.conversation
            .filter((line): line is string => typeof line === "string" && line.trim().length > 0)
            .slice(-6)
        : [];
      if (conversation.length > 0) {
        conversations.set(fid, conversation);
      }
    }
  }

  return conversations;
}

function appendConversationContext(answerText: string, conversation?: string[]): string {
  const cleanAnswer = answerText.trim();
  if (!conversation || conversation.length === 0) return cleanAnswer;

  const uniqueLines: string[] = [];
  const seen = new Set<string>();
  for (const line of conversation) {
    const clean = line.replace(/\s+/g, " ").trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    uniqueLines.push(clean);
  }
  if (uniqueLines.length === 0) return cleanAnswer;

  return [
    cleanAnswer,
    "",
    "Follow-up thread:",
    ...uniqueLines.map((line) => `- ${line}`),
  ].join("\n").slice(0, 6000);
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
