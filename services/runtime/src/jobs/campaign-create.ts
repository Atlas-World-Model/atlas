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
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getDb, questions, campaignRuns, createId } from "../../../../packages/db/src/index.js";
import { initCampaignRun } from "../../../../packages/agent/src/index.js";
import type { CampaignBrief } from "../../../../packages/agent/src/index.js";
import { invokeClaudeCode } from "../claude.js";
import { and, count, eq, inArray, isNotNull, ne } from "drizzle-orm";

const ATLAS_DIR = process.env.ATLAS_DIR || "/opt/atlas";
const NEYNAR_API_BASE = "https://api.neynar.com/v2";
const LIVE_CAMPAIGN_STAGES = ["ask", "collect", "synthesize", "build_test", "iterate"] as const;
const DEFAULT_COLLECT_DAYS = 1;

export interface CampaignProposal {
  problem: string;
  currentBelief: string;
  question: string;
  successTest: string;
  expectedAction: "none" | "memory_update" | "follow_up_question" | "build_skill" | "build_tool" | "run_experiment";
  questionType: "prediction" | "decision" | "diagnostic" | "procedural" | "evaluation" | "question_generation";
  evidenceRequested: string[];
  rewardMode: "top_3" | "top_10";
  lootiDistributionAlgorithm?: "the_well" | "the_ladder";
  budgetAmount: number;
}

interface CampaignCreationResult {
  ok: boolean;
  castHash?: string;
  campaignId?: string;
  campaignRunId?: string;
  error?: string;
}

interface CampaignLaunchSummary {
  ok: boolean;
  campaignId?: string;
  targetCastHash?: string;
  splitAddress?: string;
  splitCreationTxHash?: string;
  fundingTxHash?: string;
  budget?: Record<string, unknown>;
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

  // Guard: Atlas runs one active campaign at a time.
  const activeCampaigns = await db
    .select({ id: campaignRuns.id, campaignId: campaignRuns.campaignId })
    .from(campaignRuns)
    .where(
      and(
        eq(campaignRuns.status, "active"),
        inArray(campaignRuns.lifecycleStage, LIVE_CAMPAIGN_STAGES),
      ),
    );

  if (activeCampaigns.length > 0) {
    console.log(`[campaign-create] Skipping — active campaign exists (${activeCampaigns[0].campaignId})`);
    return {
      ok: false,
      error: `active campaign exists (${activeCampaigns[0].campaignId}). finish it before creating another.`,
    };
  }

  // Close any lingering active campaigns that have left LIVE stages.
  // This prevents stale campaign context from leaking into posts.
  const staleCampaigns = await db
    .select({ id: campaignRuns.id, campaignId: campaignRuns.campaignId })
    .from(campaignRuns)
    .where(
      and(
        eq(campaignRuns.status, "active"),
        ne(campaignRuns.lifecycleStage, "ask"),
        ne(campaignRuns.lifecycleStage, "collect"),
        ne(campaignRuns.lifecycleStage, "synthesize"),
        ne(campaignRuns.lifecycleStage, "build_test"),
        ne(campaignRuns.lifecycleStage, "iterate"),
      ),
    );
  for (const stale of staleCampaigns) {
    await db
      .update(campaignRuns)
      .set({ status: "completed" })
      .where(eq(campaignRuns.id, stale.id));
    console.log(`[campaign-create] Closed stale campaign ${stale.campaignId}`);
  }

  const runId = `atlas-auto-${Date.now()}`;
  const distributionAlgorithm = proposal.lootiDistributionAlgorithm || rewardModeToAlgorithm(proposal.rewardMode);
  const budgetAmount = readCampaignBudgetAmount();
  const usdValueAtCreation = readCampaignUsdValue();
  const questionNumber = await getNextQuestionNumber(db);
  const castText = renderCastText(proposal, questionNumber, budgetAmount);

  // Step 1: Cast the question first. Looti campaigns must target a real cast.
  let castHash: string;
  try {
    castHash = await publishCast(apiKey, signerUuid, castText);
    console.log(`[campaign-create] Cast published: ${castHash}`);
  } catch (err: any) {
    return { ok: false, error: `Cast failed: ${err.message}` };
  }

  // Step 2: Launch the Looti campaign against the real cast (prepare → fund → activate).
  let launchResult: CampaignLaunchSummary;

  try {
    launchResult = await runLaunchPipeline({
      runId,
      castHash,
      question: proposal.question,
      budgetAmount,
      usdValueAtCreation,
      rewardMode: proposal.rewardMode,
      expectedAction: proposal.expectedAction,
      brief: {
        problem: proposal.problem,
        currentBelief: proposal.currentBelief,
        question: proposal.question,
        evidenceRequested: proposal.evidenceRequested,
        useOfResults: distributionAlgorithm === "the_ladder"
          ? `Atlas will review the Podium leaderboard, recommend 1st/2nd/3rd picks if moderation is needed, and ${proposal.expectedAction.replace(/_/g, " ")}.`
          : `Atlas will review the Well reward set and ${proposal.expectedAction.replace(/_/g, " ")}.`,
        rewardMode: proposal.rewardMode,
      },
    });
  } catch (err: any) {
    return { ok: false, error: `Launch error: ${err.message}` };
  }

  if (!launchResult.ok) {
    console.error(`[campaign-create] Launch failed: ${launchResult.error}`);
    return { ok: false, castHash, error: `Launch failed after cast ${castHash}: ${launchResult.error}` };
  }

  // Step 3: Campaign is live — reply to the question with the campaign URL.
  const campaignUrl = buildLootiCampaignUrl(launchResult.campaignId!);
  await publishCampaignLinkReply(apiKey, signerUuid, castHash, campaignUrl).catch((err) => {
    console.error(`[campaign-create] Campaign link reply failed: ${err.message}`);
  });

  // Step 4: Create question record in DB
  const [question] = await db
    .insert(questions)
    .values({
      id: createId(),
      campaignId: launchResult.campaignId!,
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

  // Step 5: Init the DB lifecycle
  const run = await initCampaignRun(db, {
    questionId: question.id,
    campaignId: launchResult.campaignId!,
    atlasRunId: runId,
    expectedAction: proposal.expectedAction,
    collectDays: readCollectDays(),
  });
  await db
    .update(campaignRuns)
    .set({
      splitAddress: launchResult.splitAddress,
      fundingTxHash: launchResult.fundingTxHash,
      metadata: {
        lootiCampaignUrl: campaignUrl,
        lootiCampaignId: launchResult.campaignId!,
        lootiDistributionAlgorithm: distributionAlgorithm,
        lootiProduct: distributionAlgorithm === "the_ladder" ? "the_podium" : "the_well",
        targetCastHash: launchResult.targetCastHash || castHash,
        splitCreationTxHash: launchResult.splitCreationTxHash,
        budget: launchResult.budget,
      },
    })
    .where(eq(campaignRuns.id, run.id));

  // Step 6: Start the Cloudflare Workflow for durable lifecycle
  await startLifecycleWorkflow({
    campaignRunId: run.id,
    campaignId: launchResult.campaignId!,
    questionId: question.id,
    expectedAction: proposal.expectedAction,
    castHash,
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

export async function runCampaignCreationCheck(): Promise<CampaignCreationResult | null> {
  if (process.env.ATLAS_CAMPAIGN_CREATE_ENABLED !== "true") {
    return { ok: false, error: "Campaign creation not enabled (ATLAS_CAMPAIGN_CREATE_ENABLED)" };
  }

  console.log("[campaign-create] Running autonomous proposal check...");

  const prompt = `You are Atlas. You currently have no active live collection campaign.
Your default job is to continue the campaign learning loop by launching the next
campaign, unless there is a strong concrete reason to wait.

This must be a true follow-up, not a random new topic.

Before proposing, review:
- the latest synthesized campaign under world/campaigns/
- its reward-set evidence, memory-candidate, and review notes
- world/world-state.md and world/timeline.md

Your next campaign must explicitly follow from the latest synthesized campaign:
1. State what that campaign taught you.
2. State the most important thing it did NOT answer.
3. Ask the next question that would reduce that uncertainty.

Question quality is part of the research task. A campaign question must be easy
for a person to answer in one quote cast:
- one question mark maximum
- 14 words maximum
- ask for exactly one thing
- stand alone for a reader who has not seen any previous Atlas campaign
- no "and what", "and how", "or", multi-part clauses, or nested conditions
- no "given the previous", "based on", "for the ambitious thing", or other context-dependent setup
- no abstract framing when a concrete ask will do
- prefer "What is the one..." or "Which..." over long explanatory prompts

Put nuance in problem/currentBelief/successTest, not in the public question.

For example, if the latest campaign asked what people would build with infinite
compute and the evidence showed that people named ambitious projects but often
skipped the non-compute blocker, the next campaign should probe those remaining
constraints: human attention, coordination, trust, data access, institutions,
taste, willingness to contribute, or other bottlenecks that compute cannot solve.

Reject questions that jump to unrelated topics such as generic working-group
failure modes unless the latest reward-set evidence directly supports that jump.

Only respond with NO_CAMPAIGN if launching now would be actively harmful, duplicate
a live/recent question, or require operator input you do not have.

Otherwise respond with a JSON block:
\`\`\`json
{
  "problem": "what the previous campaign left unresolved",
  "currentBelief": "what the previous campaign taught you and what you still do not know",
  "question": "one short, standalone, single-ask follow-up question",
  "successTest": "how the answers would resolve the remaining uncertainty",
  "expectedAction": "memory_update",
  "questionType": "decision",
  "evidenceRequested": ["examples", "counterexamples", "data"],
  "rewardMode": "top_10",
  "lootiDistributionAlgorithm": "the_well",
  "budgetAmount": ${readCampaignBudgetAmount()}
}
\`\`\`

expectedAction options: none, memory_update, follow_up_question, build_skill, build_tool, run_experiment
questionType options: prediction, decision, diagnostic, procedural, evaluation, question_generation
lootiDistributionAlgorithm options:
- the_well: The Well, broad quote distribution where many contributors can receive rewards.
- the_ladder: The Podium, top-3 60/30/10 campaign with moderation through podium picks and flagged FIDs.
rewardMode is the current Atlas API compatibility field: use top_10 with the_well and top_3 with the_ladder.
For The Podium, Atlas can recommend winning quotes; Jacob can moderate/select them on Atlas's behalf.
budgetAmount: must be ${readCampaignBudgetAmount()} ATL unless the operator changes ATLAS_CAMPAIGN_BUDGET_AMOUNT.

Be conservative. Only propose a campaign when you have a genuine follow-up question
anchored in the latest campaign evidence.`;

  const result = await invokeClaudeCode(prompt);

  if (result.includes("NO_CAMPAIGN")) {
    console.log("[campaign-create] No campaign needed right now");
    return null;
  }

  const jsonMatch = result.match(/```json\s*([\s\S]*?)```/);
  if (!jsonMatch) {
    console.log("[campaign-create] No valid proposal in response");
    return { ok: false, error: "No valid campaign proposal JSON" };
  }

  let proposal: CampaignProposal;
  try {
    proposal = JSON.parse(jsonMatch[1]);
  } catch {
    console.log("[campaign-create] Failed to parse proposal JSON");
    return { ok: false, error: "Failed to parse campaign proposal JSON" };
  }

  const qualityError = validateCampaignQuestion(proposal.question);
  if (qualityError) {
    console.log(`[campaign-create] Rejected proposal question: ${qualityError}`);
    return { ok: false, error: `Campaign question failed quality gate: ${qualityError}` };
  }

  const createResult = await proposeCampaign(proposal);
  if (createResult.ok) {
    console.log(`[campaign-create] ✓ Campaign created: ${createResult.campaignId}`);
  } else {
    console.error(`[campaign-create] ✗ ${createResult.error}`);
  }
  return createResult;
}

function validateCampaignQuestion(question: string): string | null {
  const normalized = question.replace(/\s+/g, " ").trim();
  if (!normalized) return "question is empty";
  const words = normalized.split(" ").filter(Boolean);
  if (words.length > 14) return `question has ${words.length} words; maximum is 14`;
  const questionMarks = (normalized.match(/\?/g) || []).length;
  if (questionMarks > 1) return "question has more than one question mark";
  if (/\b(and what|and how|and why|or)\b/i.test(normalized)) {
    return "question is compound";
  }
  if (/\b(previous|prior|above|this campaign|last campaign|based on|given|for the ambitious thing)\b/i.test(normalized)) {
    return "question depends on outside context";
  }
  if (normalized.includes(",") && words.length > 12) return "question has a long comma clause";
  return null;
}

async function getNextQuestionNumber(db: ReturnType<typeof getDb>): Promise<number> {
  const [result] = await db
    .select({ n: count() })
    .from(campaignRuns)
    .where(and(isNotNull(campaignRuns.campaignId), ne(campaignRuns.status, "retired")));
  return (result?.n || 0) + 1;
}

function renderCastText(proposal: CampaignProposal, questionNumber: number, budgetAmount: number): string {
  const lines = [
    `WORLD MODEL | Q. No. ${questionNumber}`,
    "",
    proposal.question,
    "",
    `quote this cast with your answer to win up to ${formatAtlAmount(budgetAmount)} $ATL on @looti`,
  ];

  return lines.join("\n");
}

function formatAtlAmount(amount: number): string {
  if (amount >= 1_000_000) return `${formatCompact(amount / 1_000_000)}M`;
  if (amount >= 1_000) return `${formatCompact(amount / 1_000)}K`;
  return `${amount}`;
}

function formatCompact(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}

function buildLootiCampaignUrl(campaignId: string): string {
  const baseUrl = (process.env.ATLAS_LOOTI_PUBLIC_BASE_URL || process.env.ATLAS_LOOTI_API_BASE_URL || "https://looti.club").replace(/\/$/, "");
  return `${baseUrl}/campaigns/${encodeURIComponent(campaignId)}`;
}

function rewardModeToAlgorithm(rewardMode: "top_3" | "top_10"): "the_well" | "the_ladder" {
  return rewardMode === "top_3" ? "the_ladder" : "the_well";
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

async function publishCampaignLinkReply(
  apiKey: string,
  signerUuid: string,
  parentHash: string,
  campaignUrl: string,
): Promise<string> {
  const res = await fetch(`${NEYNAR_API_BASE}/farcaster/cast`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      signer_uuid: signerUuid,
      parent: parentHash,
      text: "Looti campaign is live:",
      embeds: [{ url: campaignUrl }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Neynar campaign link reply failed: ${res.status} ${body}`);
  }

  const data = await res.json();
  return data.cast?.hash || "unknown";
}

async function runLaunchPipeline(opts: {
  runId: string;
  castHash: string;
  question: string;
  budgetAmount: number;
  usdValueAtCreation?: number;
  rewardMode: "top_3" | "top_10";
  expectedAction: CampaignProposal["expectedAction"];
  brief: CampaignBrief;
}): Promise<CampaignLaunchSummary> {
  // Use the existing launch worker via CLI to keep the funding/activation logic centralized
  return new Promise((resolve) => {
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      ATLAS_RUN_ID: opts.runId,
      ATLAS_IDEMPOTENCY_KEY: opts.runId,
      ATLAS_PROMPT_CAST_HASH: opts.castHash,
      ATLAS_PROMPT_CAST_URL: `https://farcaster.xyz/atlas/${opts.castHash.slice(0, 10)}`,
      ATLAS_CAMPAIGN_BUDGET_AMOUNT: opts.budgetAmount.toString(),
      ...(opts.usdValueAtCreation ? { ATLAS_CAMPAIGN_USD_VALUE: opts.usdValueAtCreation.toString() } : {}),
      ATLAS_REWARD_MODE: opts.rewardMode,
      ATLAS_EXPECTED_ACTION: opts.expectedAction,
      ATLAS_COLLECT_DAYS: String(readCollectDays()),
      ATLAS_CAMPAIGN_PROBLEM: opts.brief.problem,
      ATLAS_CAMPAIGN_BELIEF: opts.brief.currentBelief,
      ATLAS_CAMPAIGN_QUESTION: opts.brief.question,
      ATLAS_CAMPAIGN_EVIDENCE: opts.brief.evidenceRequested.join(", "),
      ATLAS_CAMPAIGN_USE: opts.brief.useOfResults,
      PATH: `/root/.bun/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH}`,
    };
    delete env.DATABASE_URL;

    execFile(
      "bun",
      ["services/workers/src/campaign-launch.ts"],
      {
        cwd: ATLAS_DIR,
        timeout: readLaunchTimeoutMs(),
        env,
      },
      async (err: Error | null, stdout: string, stderr: string) => {
        const artifactSummary = await readLaunchArtifactSummary(opts.runId);
        if (artifactSummary?.campaignId) {
          resolve({ ok: true, ...artifactSummary });
          return;
        }

        if (err) {
          const detail = [err.message, stderr.trim(), stdout.trim()]
            .filter(Boolean)
            .join("\n")
            .slice(0, 1200);
          resolve({ ok: false, error: detail });
          return;
        }

        resolve({
          ok: true,
          campaignId: `auto-${opts.runId}`,
        });
      },
    );
  });
}

async function readLaunchArtifactSummary(runId: string): Promise<Omit<CampaignLaunchSummary, "ok"> | null> {
  const worldDir = process.env.ATLAS_WORLD_DIR || "world";
  const artifactPath = resolve(ATLAS_DIR, worldDir, "campaigns", `${runId}.launch.json`);
  try {
    const data = JSON.parse(await readFile(artifactPath, "utf8"));
    return {
      campaignId: data.lootiCreateResult?.campaignId,
      targetCastHash: data.lootiCreateResult?.targetCastHash,
      splitAddress: data.fundedSplit?.splitAddress,
      splitCreationTxHash: data.fundedSplit?.splitCreationTxHash,
      fundingTxHash: data.fundedSplit?.fundingTxHash,
      budget: data.preparePayload?.budget,
    };
  } catch {
    return null;
  }
}

function readCollectDays(): number {
  const value = Number.parseInt(process.env.ATLAS_COLLECT_DAYS || "", 10);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_COLLECT_DAYS;
}

function readCampaignBudgetAmount(): number {
  const value = Number.parseFloat(process.env.ATLAS_CAMPAIGN_BUDGET_AMOUNT || "");
  return Number.isFinite(value) && value > 0 ? value : 30_000_000;
}

function readCampaignUsdValue(): number | undefined {
  const value = Number.parseFloat(process.env.ATLAS_CAMPAIGN_USD_VALUE || "");
  if (Number.isFinite(value) && value > 0) return value;
  return 50;
}

function readLaunchTimeoutMs(): number {
  const value = Number.parseInt(process.env.ATLAS_CAMPAIGN_LAUNCH_TIMEOUT_MS || "", 10);
  return Number.isFinite(value) && value > 0 ? value : 360_000;
}

async function startLifecycleWorkflow(params: {
  campaignRunId: string;
  campaignId: string;
  questionId: string;
  expectedAction: string;
  castHash: string;
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
      throw new Error(`Workflow start failed: ${res.status} ${body}`);
    }

    const data = await res.json() as { workflowId: string };
    console.log(`[campaign-create] Workflow started: ${data.workflowId}`);
  } catch (err: any) {
    console.error(`[campaign-create] Workflow start error: ${err.message}`);
    throw err;
  }
}
