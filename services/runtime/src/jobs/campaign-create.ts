/**
 * Autonomous campaign creation — Atlas decides what to research,
 * casts a question to Farcaster, creates a Looti campaign, and
 * initializes the lifecycle.
 *
 * Flow:
 *   1. Atlas (via Claude Code) decides it needs to learn something
 *   2. Drafts a CampaignProposal (question, problem, belief, etc.)
 *   3. Casts the question to Farcaster via Neynar
 *   4. Creates a Looti campaign targeting that cast
 *   5. Funds the split from treasury
 *   6. Initializes the DB lifecycle (question + campaign_run + outcome_checks)
 *
 * Safety gates:
 *   ATLAS_CAMPAIGN_CREATE_ENABLED=true  — must be set
 *   ATLAS_LIVE_FUNDING_ENABLED=true     — for on-chain funding
 *   ATLAS_LIVE_ACTIVATION_ENABLED=true  — for Looti activation
 *
 * This module exposes proposeCampaign() for the brain to call,
 * and runCampaignCreationCheck() for scheduled autonomous proposals.
 */

import { execFile } from "child_process";
import { getDb, questions, campaignRuns, createId } from "../../../../packages/db/src/index.js";
import { initCampaignRun } from "../../../../packages/agent/src/index.js";
import type { CampaignBrief } from "../../../../packages/agent/src/index.js";
import { invokeClaudeCode } from "../claude.js";
import { and, eq, gte, isNotNull } from "drizzle-orm";

const ATLAS_DIR = process.env.ATLAS_DIR || "/opt/atlas";
const NEYNAR_API_BASE = "https://api.neynar.com/v2";

export interface CampaignProposal {
  problem: string;
  currentBelief: string;
  question: string;
  successTest: string;
  expectedAction: "none" | "memory_update" | "follow_up_question" | "build_skill" | "build_tool" | "run_experiment";
  questionType: "prediction" | "decision" | "diagnostic" | "procedural" | "evaluation" | "question_generation";
  evidenceRequested: string[];
  rewardMode: "top_3" | "top_10";
  budgetAmount: number;
}

interface CampaignCreationResult {
  ok: boolean;
  castHash?: string;
  campaignId?: string;
  campaignRunId?: string;
  error?: string;
}

export async function proposeCampaign(
  proposal: CampaignProposal,
): Promise<CampaignCreationResult> {
  if (process.env.ATLAS_CAMPAIGN_CREATE_ENABLED !== "true") {
    return { ok: false, error: "Campaign creation not enabled (ATLAS_CAMPAIGN_CREATE_ENABLED)" };
  }

  const apiKey = process.env.NEYNAR_API_KEY;
  const signerUuid = process.env.SIGNER_UUID;
  if (!apiKey || !signerUuid) {
    return { ok: false, error: "NEYNAR_API_KEY and SIGNER_UUID required" };
  }

  console.log(`[campaign-create] Proposing: "${proposal.question}"`);

  const db = getDb();

  // Guard: check for any campaign created in the last hour (prevents duplicates from retries)
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const recentCampaigns = await db
    .select({ id: campaignRuns.id, campaignId: campaignRuns.campaignId })
    .from(campaignRuns)
    .where(
      and(
        eq(campaignRuns.status, "active"),
        isNotNull(campaignRuns.atlasRunId),
        gte(campaignRuns.createdAt, oneHourAgo),
      ),
    );

  if (recentCampaigns.length > 0) {
    console.log(`[campaign-create] Skipping — ${recentCampaigns.length} campaign(s) created in the last hour`);
    return {
      ok: false,
      error: `a campaign was created recently (${recentCampaigns[0].campaignId}). wait before creating another.`,
    };
  }

  const runId = `atlas-auto-${Date.now()}`;
  const castText = renderCastText(proposal);

  // Step 1: Launch the campaign FIRST (prepare → fund → activate)
  // Only cast to Farcaster if the launch succeeds.
  // This prevents orphaned casts and double splits.
  let launchResult: { ok: boolean; campaignId?: string; error?: string };

  // Use a placeholder cast hash for prepare — we'll update after casting
  const placeholderCastHash = `0x${runId.replace(/[^a-f0-9]/g, "").slice(0, 40).padEnd(40, "0")}`;

  try {
    launchResult = await runLaunchPipeline({
      runId,
      castHash: placeholderCastHash,
      question: proposal.question,
      budgetAmount: proposal.budgetAmount,
      rewardMode: proposal.rewardMode,
      brief: {
        problem: proposal.problem,
        currentBelief: proposal.currentBelief,
        question: proposal.question,
        evidenceRequested: proposal.evidenceRequested,
        useOfResults: `Atlas will review the top ${proposal.rewardMode === "top_3" ? 3 : 10} responses and ${proposal.expectedAction.replace(/_/g, " ")}.`,
        rewardMode: proposal.rewardMode,
      },
    });
  } catch (err: any) {
    return { ok: false, error: `Launch error: ${err.message}` };
  }

  if (!launchResult.ok) {
    console.error(`[campaign-create] Launch failed: ${launchResult.error}`);
    return { ok: false, error: `Launch failed: ${launchResult.error}` };
  }

  // Step 2: Launch succeeded — now cast to Farcaster with campaign embed
  const campaignUrl = `https://looti.club/campaigns/${launchResult.campaignId}`;
  let castHash: string;
  try {
    castHash = await publishCastWithEmbed(apiKey, signerUuid, castText, campaignUrl);
    console.log(`[campaign-create] Cast published: ${castHash} (embed: ${campaignUrl})`);
  } catch (err: any) {
    // Campaign is funded but cast failed — still track it
    console.error(`[campaign-create] Cast failed after funding: ${err.message}`);
    castHash = placeholderCastHash;
  }

  // Step 3: Create question record in DB
  const [question] = await db
    .insert(questions)
    .values({
      id: createId(),
      farcasterCastHash: castHash,
      askerFid: parseInt(process.env.AGENT_FID || "12193"),
      text: proposal.question,
      problem: proposal.problem,
      currentBelief: proposal.currentBelief,
      successTest: proposal.successTest,
      questionType: proposal.questionType,
      expectedAction: proposal.expectedAction,
    })
    .returning();

  // Step 4: Init the DB lifecycle
  const run = await initCampaignRun(db, {
    questionId: question.id,
    campaignId: launchResult.campaignId!,
    atlasRunId: runId,
    expectedAction: proposal.expectedAction,
  });

  // Step 5: Start the Cloudflare Workflow for durable lifecycle
  await startLifecycleWorkflow({
    campaignRunId: run.id,
    campaignId: launchResult.campaignId!,
    questionId: question.id,
    expectedAction: proposal.expectedAction,
  });

  console.log(`[campaign-create] Campaign live: ${launchResult.campaignId}`);
  console.log(`[campaign-create] Lifecycle workflow started: ${run.id}`);

  return {
    ok: true,
    castHash,
    campaignId: launchResult.campaignId,
    campaignRunId: run.id,
  };
}

export async function runCampaignCreationCheck(): Promise<void> {
  if (process.env.ATLAS_CAMPAIGN_CREATE_ENABLED !== "true") {
    return;
  }

  console.log("[campaign-create] Running autonomous proposal check...");

  const prompt = `You are Atlas. Review your world state in world/ and campaign history
in world/campaigns/. Decide if you should run a new campaign.

Consider:
- What do you need to learn next?
- Is there a gap in your world model?
- Did a previous campaign's results suggest a follow-up question?
- Is there something the working group should weigh in on?

If you should NOT run a new campaign right now, respond with: NO_CAMPAIGN

If you SHOULD, respond with a JSON block:
\`\`\`json
{
  "problem": "what you're trying to understand",
  "currentBelief": "what you think now",
  "question": "the specific question to ask",
  "successTest": "how you'll know if the answers were useful",
  "expectedAction": "memory_update",
  "questionType": "decision",
  "evidenceRequested": ["examples", "counterexamples", "data"],
  "rewardMode": "top_10",
  "budgetAmount": 5
}
\`\`\`

expectedAction options: none, memory_update, follow_up_question, build_skill, build_tool, run_experiment
questionType options: prediction, decision, diagnostic, procedural, evaluation, question_generation
rewardMode: top_3 or top_10
budgetAmount: in ATL tokens (default 5)

Be conservative. Only propose a campaign when you have a genuine question.`;

  const result = await invokeClaudeCode(prompt);

  if (result.includes("NO_CAMPAIGN")) {
    console.log("[campaign-create] No campaign needed right now");
    return;
  }

  const jsonMatch = result.match(/```json\s*([\s\S]*?)```/);
  if (!jsonMatch) {
    console.log("[campaign-create] No valid proposal in response");
    return;
  }

  let proposal: CampaignProposal;
  try {
    proposal = JSON.parse(jsonMatch[1]);
  } catch {
    console.log("[campaign-create] Failed to parse proposal JSON");
    return;
  }

  const createResult = await proposeCampaign(proposal);
  if (createResult.ok) {
    console.log(`[campaign-create] ✓ Campaign created: ${createResult.campaignId}`);
  } else {
    console.error(`[campaign-create] ✗ ${createResult.error}`);
  }
}

function renderCastText(proposal: CampaignProposal): string {
  const topN = proposal.rewardMode === "top_3" ? 3 : 10;

  // Keep it short and scannable — question + CTA
  const lines = [
    proposal.question,
    "",
    "quote this cast with your answer.",
    "",
    `@looti will rank responses and i will update my world model from the top ${topN}.`,
  ];

  return lines.join("\n").slice(0, 320);
}

async function publishCastWithEmbed(
  apiKey: string,
  signerUuid: string,
  text: string,
  embedUrl: string,
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
      embeds: [{ url: embedUrl }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Neynar cast failed: ${res.status} ${body}`);
  }

  const data = await res.json();
  return data.cast?.hash || "unknown";
}

async function runLaunchPipeline(opts: {
  runId: string;
  castHash: string;
  question: string;
  budgetAmount: number;
  rewardMode: "top_3" | "top_10";
  brief: CampaignBrief;
}): Promise<{ ok: boolean; campaignId?: string; error?: string }> {
  // Use the existing launch worker via CLI to keep the funding/activation logic centralized
  return new Promise((resolve) => {
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      ATLAS_RUN_ID: opts.runId,
      ATLAS_IDEMPOTENCY_KEY: opts.runId,
      ATLAS_PROMPT_CAST_HASH: opts.castHash,
      ATLAS_PROMPT_CAST_URL: `https://farcaster.xyz/atlas/${opts.castHash.slice(0, 10)}`,
      ATLAS_CAMPAIGN_BUDGET_AMOUNT: opts.budgetAmount.toString(),
      ATLAS_REWARD_MODE: opts.rewardMode,
      ATLAS_CAMPAIGN_PROBLEM: opts.brief.problem,
      ATLAS_CAMPAIGN_BELIEF: opts.brief.currentBelief,
      ATLAS_CAMPAIGN_QUESTION: opts.brief.question,
      ATLAS_CAMPAIGN_EVIDENCE: opts.brief.evidenceRequested.join(", "),
      ATLAS_CAMPAIGN_USE: opts.brief.useOfResults,
      PATH: `/root/.bun/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH}`,
    };

    execFile(
      "bun",
      ["services/workers/src/campaign-launch.ts"],
      {
        cwd: ATLAS_DIR,
        timeout: 120_000,
        env,
      },
      (err: Error | null, stdout: string, stderr: string) => {
        if (err) {
          resolve({ ok: false, error: err.message });
          return;
        }

        // Try to extract campaign ID from output
        const idMatch = stdout.match(/"campaignId"\s*:\s*"([^"]+)"/);
        resolve({
          ok: true,
          campaignId: idMatch?.[1] || `auto-${opts.runId}`,
        });
      },
    );
  });
}

async function startLifecycleWorkflow(params: {
  campaignRunId: string;
  campaignId: string;
  questionId: string;
  expectedAction: string;
}): Promise<void> {
  const workerUrl = process.env.ATLAS_CF_WORKER_URL || "https://atlas-worker.jacob-247.workers.dev";
  const token = process.env.NEYNAR_WEBHOOK_SECRET || "";

  try {
    const res = await fetch(`${workerUrl}/workflow/campaign`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        ...params,
        collectDays: 1, // V0: tight feedback loop
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`[campaign-create] Workflow start failed: ${res.status} ${body}`);
      return;
    }

    const data = await res.json() as { workflowId: string };
    console.log(`[campaign-create] Workflow started: ${data.workflowId}`);
  } catch (err: any) {
    console.error(`[campaign-create] Workflow start error: ${err.message}`);
  }
}
