/**
 * Reputation update worker — processes outcome-based reputation changes.
 *
 * Usage: bun services/workers/src/reputation-update.ts
 *
 * Env:
 *   DATABASE_URL — Postgres connection string
 *   ATLAS_QUESTION_ID — (optional) process specific question, or process all pending
 */
import { getDb, outcomes } from "../../../packages/db/src/index.js";
import { computeReputationFromOutcomes, applyTimeDecay } from "../../../packages/agent/src/index.js";
import { and, isNotNull } from "drizzle-orm";

async function main() {
  const db = getDb();
  const specificQuestionId = process.env.ATLAS_QUESTION_ID;

  if (specificQuestionId) {
    console.log(
      `[reputation-update] Computing reputation for question ${specificQuestionId}`,
    );
    await computeReputationFromOutcomes(db, specificQuestionId);
  } else {
    // Find all questions with resolved outcomes that haven't been reputation-processed
    // For now, process all questions that have non-pending outcomes
    const questionsWithOutcomes = await db
      .selectDistinct({ questionId: outcomes.questionId })
      .from(outcomes)
      .where(
        and(
          isNotNull(outcomes.resolvedAt),
        ),
      );

    console.log(
      `[reputation-update] Processing ${questionsWithOutcomes.length} questions with resolved outcomes`,
    );

    for (const { questionId } of questionsWithOutcomes) {
      await computeReputationFromOutcomes(db, questionId);
    }
  }

  // Apply time decay
  const decayed = await applyTimeDecay(db);
  console.log(`[reputation-update] Applied time decay to ${decayed} reputation records`);

  console.log("[reputation-update] Done.");
  process.exit(0);
}

main().catch((err) => {
  console.error("[reputation-update] Fatal:", err);
  process.exit(1);
});
