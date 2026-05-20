/**
 * Initialize a campaign lifecycle in the database after a campaign is launched.
 *
 * Usage: bun services/workers/src/campaign-init-lifecycle.ts
 *
 * Env:
 *   DATABASE_URL — Postgres connection string
 *   ATLAS_CAMPAIGN_ID — Looti campaign ID
 *   ATLAS_RUN_ID — Atlas run ID
 *   ATLAS_CAMPAIGN_QUESTION — The question text
 *   ATLAS_CAMPAIGN_PROBLEM — The problem statement
 *   ATLAS_CAMPAIGN_BELIEF — Current belief
 *   ATLAS_CAMPAIGN_SUCCESS_TEST — How to evaluate success
 *   ATLAS_EXPECTED_ACTION — Expected action (none, memory_update, follow_up_question, build_skill, build_tool, run_experiment)
 *   ATLAS_QUESTION_TYPE — Question type (prediction, decision, diagnostic, procedural, evaluation, question_generation)
 *   ATLAS_CREATOR_FID — Farcaster ID of asker
 *   ATLAS_PROMPT_CAST_HASH — Cast hash
 *   ATLAS_COLLECT_DAYS — Days for collection (default 7)
 */
import { getDb, questions, createId } from "../../../packages/db/src/index.js";
import { initCampaignRun } from "../../../packages/agent/src/index.js";
import { eq } from "drizzle-orm";

async function main() {
  const db = getDb();

  const campaignId = process.env.ATLAS_CAMPAIGN_ID;
  const runId = process.env.ATLAS_RUN_ID;
  const questionText = process.env.ATLAS_CAMPAIGN_QUESTION;
  const expectedAction = process.env.ATLAS_EXPECTED_ACTION || "none";

  if (!campaignId || !runId || !questionText) {
    throw new Error(
      "Required: ATLAS_CAMPAIGN_ID, ATLAS_RUN_ID, ATLAS_CAMPAIGN_QUESTION",
    );
  }

  const existingQuestion = await db.query.questions.findFirst({
    where: eq(questions.campaignId, campaignId),
  });

  const question =
    existingQuestion ||
    (
      await db
        .insert(questions)
        .values({
          id: createId(),
          campaignId,
          farcasterCastHash: process.env.ATLAS_PROMPT_CAST_HASH || null,
          askerFid: process.env.ATLAS_CREATOR_FID
            ? parseInt(process.env.ATLAS_CREATOR_FID)
            : null,
          text: questionText,
          problem: process.env.ATLAS_CAMPAIGN_PROBLEM || null,
          currentBelief: process.env.ATLAS_CAMPAIGN_BELIEF || null,
          successTest: process.env.ATLAS_CAMPAIGN_SUCCESS_TEST || null,
          questionType: (process.env.ATLAS_QUESTION_TYPE as any) || "decision",
          resolvability: (process.env.ATLAS_RESOLVABILITY as any) || "unknown",
          expectedAction: expectedAction as any,
          resolutionTargetAt: process.env.ATLAS_RESOLUTION_TARGET_AT
            ? new Date(process.env.ATLAS_RESOLUTION_TARGET_AT)
            : null,
        })
        .returning()
    )[0];

  console.log(
    `[campaign-init] ${existingQuestion ? "Using existing" : "Created"} question ${question.id}`,
  );

  // Initialize the campaign lifecycle
  const run = await initCampaignRun(db, {
    questionId: question.id,
    campaignId,
    atlasRunId: runId,
    expectedAction,
    collectDays: process.env.ATLAS_COLLECT_DAYS
      ? parseInt(process.env.ATLAS_COLLECT_DAYS)
      : 7,
  });

  console.log(`[campaign-init] Campaign run ${run.id}`);
  console.log(`[campaign-init] Lifecycle stage: ${run.lifecycleStage}`);
  console.log(`[campaign-init] Collect ends: ${run.collectEndsAt?.toISOString()}`);
  console.log(`[campaign-init] Outcome checks scheduled at day 7, 30, 90`);

  process.exit(0);
}

main().catch((err) => {
  console.error("[campaign-init] Fatal:", err);
  process.exit(1);
});
