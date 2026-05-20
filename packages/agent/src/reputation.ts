import { and, eq } from "drizzle-orm";
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

function clampReputationScore(score: number): number {
  return Math.max(-1, Math.min(1, score));
}
