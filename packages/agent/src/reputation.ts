import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "../../db/src/index.js";
import {
  contributorReputation,
  contributors,
  outcomes,
  answers,
  auditLog,
  createId,
} from "../../db/src/index.js";

interface ReputationUpdate {
  fid: number;
  domain: string;
  delta: number; // score change
  reason: string;
}

export interface RankedCampaignOutcomeInput {
  questionId: string;
  answerId: string;
  campaignRunId?: string;
  campaignId?: string;
  fid: number;
  displayName?: string;
  rank: number;
  score?: number;
  castHash?: string | null;
  answerText?: string;
}

export async function recordRankedCampaignOutcome(
  db: Db,
  input: RankedCampaignOutcomeInput,
): Promise<void> {
  if (!input.fid || !Number.isFinite(input.fid)) return;

  const entityId = `${input.fid}:${input.questionId}`;
  const alreadyRecorded = await db.query.auditLog.findFirst({
    where: and(
      eq(auditLog.entityType, "contributor_campaign_rank"),
      eq(auditLog.entityId, entityId),
      eq(auditLog.action, "recorded"),
    ),
  });
  if (alreadyRecorded) return;

  await db
    .insert(contributors)
    .values({
      fid: input.fid,
      displayName: input.displayName,
      totalAnswers: 1,
      firstSeenAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: contributors.fid,
      set: {
        displayName: input.displayName ? input.displayName : sql`${contributors.displayName}`,
        totalAnswers: sql`${contributors.totalAnswers} + 1`,
        updatedAt: new Date(),
      },
    });

  const rankScore = scoreRankedOutcome(input.rank);
  const [outcome] = await db
    .insert(outcomes)
    .values({
      id: createId(),
      questionId: input.questionId,
      answerId: input.answerId,
      tier: "behavioral",
      verdict: "correct",
      score: rankScore,
      confidence: 0.65,
      evidence: `Looti ranked this answer #${input.rank} in the campaign top 10. This is an immediate ranked-usefulness outcome, not a ground-truth correctness claim.`,
      resolver: "system",
      resolvedAt: new Date(),
    })
    .returning();

  await updateReputation(db, {
    fid: input.fid,
    domain: "campaign_ranked",
    delta: rankScore,
    reason: `Looti top-10 ranked outcome for question ${input.questionId} (rank #${input.rank})`,
  });

  await db.insert(auditLog).values({
    id: createId(),
    entityType: "outcome",
    entityId: outcome.id,
    action: "reputation_applied",
    newValue: { responderFid: input.fid, delta: rankScore, domain: "campaign_ranked" },
    actor: "atlas_agent",
    reason: `Immediate ranked campaign outcome for question ${input.questionId}`,
  });

  await db.insert(auditLog).values({
    id: createId(),
    entityType: "contributor_campaign_rank",
    entityId,
    action: "recorded",
    newValue: {
      fid: input.fid,
      displayName: input.displayName,
      questionId: input.questionId,
      campaignRunId: input.campaignRunId,
      campaignId: input.campaignId,
      answerId: input.answerId,
      castHash: input.castHash,
      rank: input.rank,
      lootiScore: input.score,
      rankScore,
      answerPreview: input.answerText?.slice(0, 280),
    },
    actor: "atlas_agent",
    reason: "Contributor produced a top-10 ranked campaign answer",
  });

  await upsertContributorCampaignMemory(db, input, rankScore);

  await queueContributorKgRefresh(db, {
    fid: input.fid,
    reason: "top-10 campaign contributor",
  });
}

async function upsertContributorCampaignMemory(
  db: Db,
  input: RankedCampaignOutcomeInput,
  rankScore: number,
): Promise<void> {
  const entityId = `${input.fid}:${input.questionId}`;
  const existing = await db.query.auditLog.findFirst({
    where: and(
      eq(auditLog.entityType, "contributor_campaign_memory"),
      eq(auditLog.entityId, entityId),
    ),
  });

  const payload = {
    fid: input.fid,
    displayName: input.displayName,
    questionId: input.questionId,
    campaignRunId: input.campaignRunId,
    campaignId: input.campaignId,
    answerId: input.answerId,
    castHash: input.castHash,
    rank: input.rank,
    lootiScore: input.score,
    rankScore,
    text: input.answerText,
    hasFollowUpThread: input.answerText?.includes("Follow-up thread:") === true,
  };

  if (existing) {
    await db
      .update(auditLog)
      .set({
        previousValue: existing.newValue,
        newValue: payload,
        reason: "Latest ranked answer memory for contributor/campaign",
      })
      .where(eq(auditLog.id, existing.id));
    return;
  }

  await db.insert(auditLog).values({
    id: createId(),
    entityType: "contributor_campaign_memory",
    entityId,
    action: "upserted",
    newValue: payload,
    actor: "atlas_agent",
    reason: "Ranked campaign contribution memory including follow-up context when available",
  });
}

export async function updateReputation(
  db: Db,
  update: ReputationUpdate,
): Promise<void> {
  // Ensure contributor exists
  const existing = await db.query.contributors.findFirst({
    where: eq(contributors.fid, update.fid),
  });
  if (!existing) {
    await db.insert(contributors).values({
      fid: update.fid,
      firstSeenAt: new Date(),
    });
  }

  // Find or create reputation record
  const repId = `${update.fid}:${update.domain}`;
  const existingRep = await db.query.contributorReputation.findFirst({
    where: eq(contributorReputation.id, repId),
  });

  if (existingRep) {
    const newScore = clampReputationScore(existingRep.score + update.delta);
    const newSampleSize = existingRep.sampleSize + 1;
    const newConfidence = Math.min(1, newSampleSize / 20); // saturates at 20 samples

    await db
      .update(contributorReputation)
      .set({
        score: newScore,
        sampleSize: newSampleSize,
        confidence: newConfidence,
        lastUpdatedAt: new Date(),
      })
      .where(eq(contributorReputation.id, repId));

    await db.insert(auditLog).values({
      id: createId(),
      entityType: "reputation",
      entityId: repId,
      action: "updated",
      previousValue: { score: existingRep.score },
      newValue: { score: newScore, delta: update.delta },
      actor: "atlas_agent",
      reason: update.reason,
    });
  } else {
    const confidence = Math.min(1, 1 / 20);
    await db.insert(contributorReputation).values({
      id: repId,
      fid: update.fid,
      domain: update.domain,
      score: clampReputationScore(update.delta),
      sampleSize: 1,
      confidence,
    });
  }
}

export async function applyTimeDecay(db: Db): Promise<number> {
  // Apply exponential decay to all reputation scores
  // halfLife = 180 days → daily decay factor = 2^(-1/180) ≈ 0.99615
  const dailyDecay = Math.pow(2, -1 / 180);

  const allReps = await db.select().from(contributorReputation);
  let updated = 0;

  for (const rep of allReps) {
    const daysSinceUpdate = Math.floor(
      (Date.now() - new Date(rep.lastUpdatedAt).getTime()) / (1000 * 60 * 60 * 24),
    );

    if (daysSinceUpdate < 1) continue;

    const decayFactor = Math.pow(dailyDecay, daysSinceUpdate);
    const decayed = rep.score * decayFactor;

    await db
      .update(contributorReputation)
      .set({ score: decayed, lastUpdatedAt: new Date() })
      .where(eq(contributorReputation.id, rep.id));

    updated++;
  }

  return updated;
}

export async function computeReputationFromOutcomes(
  db: Db,
  questionId: string,
): Promise<void> {
  // Get all behavioral and ground_truth outcomes for this question's answers
  const questionOutcomes = await db
    .select({
      answerId: outcomes.answerId,
      outcomeId: outcomes.id,
      tier: outcomes.tier,
      verdict: outcomes.verdict,
      score: outcomes.score,
      responderFid: answers.responderFid,
    })
    .from(outcomes)
    .innerJoin(answers, eq(outcomes.answerId, answers.id))
    .where(eq(outcomes.questionId, questionId));

  for (const o of questionOutcomes) {
    // Skip engagement-tier outcomes — they don't affect reputation
    if (o.tier === "engagement") continue;
    if (!o.responderFid) continue;
    const alreadyApplied = await db.query.auditLog.findFirst({
      where: and(
        eq(auditLog.entityType, "outcome"),
        eq(auditLog.entityId, o.outcomeId),
        eq(auditLog.action, "reputation_applied"),
      ),
    });
    if (alreadyApplied) continue;

    let delta = 0;
    const weight = o.tier === "ground_truth" ? 2 : 1;

    switch (o.verdict) {
      case "correct":
        delta = 1 * weight;
        break;
      case "partially_correct":
        delta = 0.5 * weight;
        break;
      case "incorrect":
        delta = -1 * weight;
        break;
      case "unverifiable":
        delta = -0.1 * weight;
        break;
      default:
        continue; // pending — skip
    }

    await updateReputation(db, {
      fid: o.responderFid,
      domain: "global",
      delta,
      reason: `Outcome verdict "${o.verdict}" (${o.tier}) for question ${questionId}`,
    });

    await db.insert(auditLog).values({
      id: createId(),
      entityType: "outcome",
      entityId: o.outcomeId,
      action: "reputation_applied",
      newValue: { responderFid: o.responderFid, delta },
      actor: "atlas_agent",
      reason: `Reputation update applied for question ${questionId}`,
    });
  }
}

function scoreRankedOutcome(rank: number): number {
  if (!Number.isFinite(rank) || rank < 1) return 0.01;
  return Math.max(0.01, Math.min(0.1, (11 - Math.min(rank, 10)) / 100));
}

async function queueContributorKgRefresh(
  db: Db,
  input: { fid: number; reason: string; forceRefresh?: boolean },
): Promise<void> {
  const kgUrl = process.env.ATLAS_KG_PIPELINE_URL?.replace(/\/$/, "");
  const apiKey = process.env.ATLAS_KG_PIPELINE_API_KEY;
  if (!kgUrl || !apiKey || !input.fid) return;

  const since = new Date(Date.now() - readKgRefreshCooldownHours() * 60 * 60 * 1000);
  const recent = await db.query.auditLog.findFirst({
    where: and(
      eq(auditLog.entityType, "contributor_kg_profile"),
      eq(auditLog.entityId, String(input.fid)),
      eq(auditLog.action, "queued"),
      gte(auditLog.createdAt, since),
    ),
  });
  if (recent && !input.forceRefresh) return;

  try {
    const res = await fetch(`${kgUrl}/api/v1/graphs/generate/async`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify({
        fid: input.fid,
        force_refresh: input.forceRefresh === true,
        cast_limit: readKgCastLimit(),
      }),
      signal: AbortSignal.timeout(8000),
    });

    await db.insert(auditLog).values({
      id: createId(),
      entityType: "contributor_kg_profile",
      entityId: String(input.fid),
      action: res.ok ? "queued" : "queue_failed",
      newValue: {
        status: res.status,
        reason: input.reason,
        forceRefresh: input.forceRefresh === true,
      },
      actor: "atlas_agent",
      reason: "KG profile generation for campaign contributor",
    });
  } catch (err: any) {
    await db.insert(auditLog).values({
      id: createId(),
      entityType: "contributor_kg_profile",
      entityId: String(input.fid),
      action: "queue_failed",
      newValue: { error: err?.message || String(err), reason: input.reason },
      actor: "atlas_agent",
      reason: "KG profile generation request failed",
    });
  }
}

function readKgRefreshCooldownHours(): number {
  const value = Number.parseInt(process.env.ATLAS_KG_REFRESH_COOLDOWN_HOURS || "24", 10);
  return Number.isFinite(value) && value > 0 ? value : 24;
}

function readKgCastLimit(): number | undefined {
  const value = Number.parseInt(process.env.ATLAS_KG_CAST_LIMIT || "", 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function clampReputationScore(score: number): number {
  return Math.max(-1, Math.min(1, score));
}
