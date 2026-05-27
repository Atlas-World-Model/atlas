/**
 * Farcaster publishing job — checks for campaigns ready to publish
 * and posts prompts/results.
 *
 * Requires NEYNAR_API_KEY and SIGNER_UUID in env.
 * Currently a stub — will be wired to Neynar SDK for posting.
 */

import { getDb, campaignRuns, questions } from "../../../../packages/db/src/index.js";
import { eq, and, isNull, inArray } from "drizzle-orm";
import { transitionCampaign } from "../../../../packages/agent/src/index.js";

const NEYNAR_API_BASE = "https://api.neynar.com/v2";

interface PublishableItem {
  type: "campaign_prompt" | "campaign_result" | "memory_update";
  campaignRunId: string;
  text: string;
}

export async function runFarcasterPublish(): Promise<void> {
  if (process.env.ATLAS_FARCASTER_PUBLISH_ENABLED !== "true") {
    return;
  }

  const apiKey = process.env.NEYNAR_API_KEY;
  const signerUuid = process.env.SIGNER_UUID;

  if (!apiKey || !signerUuid) {
    // Silently skip if not configured
    return;
  }

  const db = getDb();

  // Find campaign prompts that have not been cast yet. Existing launch flows
  // may already open the lifecycle into collect, so include ask and collect.
  const unpublished = await db
    .select({
      runId: campaignRuns.id,
      questionId: campaignRuns.questionId,
      questionText: questions.text,
      problem: questions.problem,
      currentBelief: questions.currentBelief,
      successTest: questions.successTest,
      lifecycleStage: campaignRuns.lifecycleStage,
    })
    .from(campaignRuns)
    .innerJoin(questions, eq(campaignRuns.questionId, questions.id))
    .where(
      and(
        inArray(campaignRuns.lifecycleStage, ["ask", "collect"]),
        isNull(questions.farcasterCastHash),
      ),
    );

  for (const item of unpublished) {
    if (!item.questionText) continue;

    try {
      const castHash = await publishCast(apiKey, signerUuid, renderCampaignPrompt(item));

      // Update question with cast hash
      if (item.questionId) {
        await db
          .update(questions)
          .set({ farcasterCastHash: castHash })
          .where(eq(questions.id, item.questionId));
      }
      if (item.lifecycleStage === "ask") {
        await transitionCampaign(
          db,
          item.runId,
          "collect",
          "Campaign prompt published to Farcaster",
        );
      }

      console.log(`[farcaster] Published campaign prompt: ${castHash}`);
    } catch (err: any) {
      console.error(`[farcaster] Failed to publish: ${err.message}`);
    }
  }
}

function renderCampaignPrompt(item: {
  questionText: string;
  problem: string | null;
  currentBelief: string | null;
  successTest: string | null;
}): string {
  const lines = [
    item.problem ? `Problem: ${item.problem}` : null,
    item.currentBelief ? `Current belief: ${item.currentBelief}` : null,
    `Question: ${item.questionText}`,
    item.successTest ? `Success test: ${item.successTest}` : null,
    "",
    "@looti rewards are for the most useful answers.",
  ].filter((line): line is string => line !== null);

  return lines.join("\n");
}

async function publishCast(
  apiKey: string,
  signerUuid: string,
  text: string,
): Promise<string> {
  const res = await fetch(`${NEYNAR_API_BASE}/farcaster/cast`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      signer_uuid: signerUuid,
      text,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Neynar cast failed: ${res.status} ${body}`);
  }

  const data = await res.json();
  return data.cast?.hash || "unknown";
}
