/**
 * Atlas HTTP server — receives Neynar webhooks and serves health checks.
 *
 * Routes:
 *   POST /webhook/farcaster — Neynar cast.created webhook
 *   GET  /health             — health check
 *
 * Env:
 *   ATLAS_WEBHOOK_PORT       — port (default 3141)
 *   NEYNAR_WEBHOOK_SECRET    — webhook signature verification
 *   NEYNAR_API_KEY           — for posting replies
 *   SIGNER_UUID              — for posting replies
 *   ATLAS_FARCASTER_REPLY_ENABLED — must be "true" to post replies
 */

import { execFile } from "child_process";
import { promisify } from "util";
import {
  verifyWebhookSignature,
  isMentioningAtlas,
  isReplyToAtlas,
  extractQuestion,
  replyToCast,
} from "./webhook.js";
import { askAtlas } from "./atlas-brain.js";
import { askAtlasToWrite } from "../jobs/blog-publish.js";
import { runCampaignCreationCheck } from "../jobs/campaign-create.js";
import { runBlogCheck } from "../jobs/blog-publish.js";
import { runHeartbeat } from "../jobs/heartbeat.js";
import { runLifecycleCheck } from "../jobs/lifecycle-check.js";
import { refreshCampaignNotebook } from "../jobs/campaign-notebook.js";
import { claimActionLease } from "./action-lease.js";
import {
  answers,
  auditLog,
  campaignRuns,
  campaignPublicEvents,
  campaignPublicPages,
  contributorReputation,
  createId,
  getDb,
  questions,
} from "../../../../packages/db/src/index.js";
import { synthesizeCampaign, closeReviewLoop } from "../../../../packages/agent/src/index.js";
import { createHttpLootiClient } from "../../../../packages/sdk/src/index.js";
import { and, desc, eq, gte, inArray } from "drizzle-orm";

const execFileAsync = promisify(execFile);
const PORT = parseInt(process.env.ATLAS_WEBHOOK_PORT || "3141");
const MAX_JSON_BYTES = 64 * 1024;
const CAMPAIGN_ENGAGEMENT_COOLDOWN_HOURS = 4;
const ATLAS_POST_COOLDOWN_HOURS = 8;
const LIVE_CAMPAIGN_STAGES = ["ask", "collect", "synthesize", "build_test", "iterate"] as const;
const NOTEBOOK_CORPUS_LIMIT = 30;
const PUBLIC_NOTEBOOK_EMBED_VERSION = "og-png-v1";
const LINK_REVIEW_REPLY_CHARS = readPositiveIntEnv("ATLAS_LINK_REVIEW_REPLY_CHARS", 320);
const LINK_REVIEW_CONTEXT_CHARS = 7000;
const MENTION_THREAD_CONTEXT_CHARS = 2400;
const OPS_COMMANDS_IMAGE_URL = "https://joinatlas.xyz/img/atlas-ops-commands.png";
const WORLD_MODEL_COMMANDS_IMAGE_URL = "https://joinatlas.xyz/img/atlas-world-model-commands.png";
let activeTasks = 0;
const idleResolvers: Array<() => void> = [];

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // Health check
    if (req.method === "GET" && url.pathname === "/health") {
      return Response.json({
        status: "ok",
        agent: "atlas-runtime",
        timestamp: new Date().toISOString(),
      });
    }

    // Brain API — trigger Claude Code reasoning on demand
    // Requires a simple bearer token (reuse NEYNAR_WEBHOOK_SECRET)
    if (req.method === "POST" && url.pathname === "/api/brain") {
      const authHeader = req.headers.get("authorization") || "";
      const expectedToken = requireRuntimeSecret("NEYNAR_WEBHOOK_SECRET");
      if (authHeader !== `Bearer ${expectedToken}`) {
        return new Response("Unauthorized", { status: 401 });
      }

      let body;
      try {
        body = await readJson(req) as { action: string; topic?: string };
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }

      if (!isAllowedBrainAction(body.action)) {
        return new Response("Unsupported action", { status: 400 });
      }

      console.log(`[brain-api] Action: ${body.action}`);

      if (shouldHandleBrainActionSynchronously(body.action)) {
        try {
          await handleBrainRequest(body);
        } catch (err: any) {
          const status = Number.isInteger(err?.status) ? err.status : 500;
          console.error(`[brain-api] Error: ${err.message}`);
          return Response.json({ ok: false, action: body.action, error: err.message }, { status });
        }
        return Response.json({ ok: true, action: body.action, status: "completed" });
      }

      trackTask(handleBrainRequest(body), "brain-api");
      return Response.json({ ok: true, action: body.action, status: "processing" });
    }

    // Farcaster webhook
    if (req.method === "POST" && url.pathname === "/webhook/farcaster") {
      const secret = requireRuntimeSecret("NEYNAR_WEBHOOK_SECRET");
      const body = await req.text();

      const sig = req.headers.get("x-neynar-signature") || "";
      if (!verifyWebhookSignature(body, sig, secret)) {
        console.warn("[webhook] Invalid signature");
        return new Response("Invalid signature", { status: 401 });
      }

      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }

      const mentionsAtlas = isMentioningAtlas(payload);
      const repliesToAtlas = isReplyToAtlas(payload);
      if (!mentionsAtlas && !repliesToAtlas) {
        return Response.json({ ok: true, action: "ignored" });
      }

      const question = extractQuestion(payload.data.text);
      const author = payload.data.author;
      const castHash = payload.data.hash;

      console.log(
        `[webhook] @${author.username} (fid:${author.fid}): "${question}"`,
      );

      // Process async — respond 200 immediately
      trackTask(
        handleMention(question, author, castHash, {
          trigger: mentionsAtlas ? "mention" : "reply",
          parentHash: typeof payload.data.parent_hash === "string" ? payload.data.parent_hash : undefined,
          threadHash: typeof payload.data.thread_hash === "string" ? payload.data.thread_hash : undefined,
        }),
        "webhook",
      );

      return Response.json({ ok: true, action: "processing" });
    }

    return new Response("Not found", { status: 404 });
  },
});

export async function waitForInFlightTasks(timeoutMs: number): Promise<void> {
  if (activeTasks === 0) return;
  await Promise.race([
    new Promise<void>((resolve) => idleResolvers.push(resolve)),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

function trackTask(task: Promise<void>, label: string): void {
  activeTasks += 1;
  task.catch((err) => {
    console.error(`[${label}] Error: ${err.message}`);
  }).finally(() => {
    activeTasks = Math.max(0, activeTasks - 1);
    if (activeTasks === 0) {
      while (idleResolvers.length > 0) idleResolvers.shift()?.();
    }
  });
}

function requireRuntimeSecret(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for this endpoint`);
  }
  return value;
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readRewardSetLimit(): 3 | 10 {
  const value = process.env.ATLAS_REWARD_SET_LIMIT || "10";
  if (value === "3") return 3;
  if (value === "10") return 10;
  throw new Error("ATLAS_REWARD_SET_LIMIT must be 3 or 10");
}

async function readJson(req: Request): Promise<unknown> {
  const body = await req.text();
  if (body.length > MAX_JSON_BYTES) {
    throw new Error("Request body too large");
  }
  return JSON.parse(body);
}

function isAllowedBrainAction(action: unknown): action is string {
  return typeof action === "string" && [
    "engage-campaign",
    "synthesize",
    "evaluate",
    "final-label",
    "propose-campaign",
    "write-article",
    "post",
    "tick",
    "think",
    "kg-refresh",
  ].includes(action);
}

function shouldHandleBrainActionSynchronously(action: unknown): boolean {
  return action === "synthesize" || action === "evaluate" || action === "final-label";
}

async function handleMention(
  question: string,
  author: { fid: number; username: string; display_name: string },
  castHash: string,
  opts: { trigger: "mention" | "reply"; parentHash?: string; threadHash?: string } = { trigger: "mention" },
): Promise<void> {
  const apiKey = process.env.NEYNAR_API_KEY;
  const signerUuid = process.env.SIGNER_UUID;
  const replyEnabled = process.env.ATLAS_FARCASTER_REPLY_ENABLED === "true";

  if (!apiKey || !signerUuid || !replyEnabled) {
    console.log("[webhook] Reply not enabled — logging only");
    console.log(`[webhook] Would reply to ${castHash}: processing "${question}"`);
    return;
  }

  if (!(await isAllowedReplyAuthor(author.fid))) {
    console.log(`[webhook] FID ${author.fid} not in allowlist — skipping reply`);
    return;
  }

  if (opts.trigger === "reply" && shouldIgnoreUntaggedReply(question)) {
    console.log(`[webhook] Ignoring low-signal direct reply from @${author.username}: "${question}"`);
    return;
  }

  if (isPersonalContributorMemoryRequest(question)) {
    const reply = await buildPersonalContributorMemoryReply(author);
    const replyHash = await replyThread(apiKey, signerUuid, castHash, reply, 320);
    console.log(`[webhook] Replied to contributor memory request: ${replyHash}`);
    return;
  }

  if (opts.trigger === "mention" && author.fid === 11528 && /^(ops|ops:\s*(commands|help))\s*$/i.test(question.trim())) {
    await replyToCast(
      apiKey,
      signerUuid,
      castHash,
      "ops commands attached. these are public-safe status checks; only @jrf can trigger mutating ops commands.",
      { embedUrl: OPS_COMMANDS_IMAGE_URL },
    );
    return;
  }

  const opsCommand = opts.trigger === "mention" ? parseOpsCommand(question) : null;
  if (opsCommand && author.fid === 11528) {
    const reply = await buildOpsCommandReply(opsCommand);
    const replyHash = await replyThread(apiKey, signerUuid, castHash, reply, 320);
    console.log(`[webhook] Replied to ops command: ${replyHash}`);
    return;
  }

  if (
    opts.trigger === "mention" &&
    (
      /^(world|campaign)\s+(commands|help)$/i.test(question.trim()) ||
      /^(world|campaign):\s*(commands|help)$/i.test(question.trim())
    )
  ) {
    await replyToCast(
      apiKey,
      signerUuid,
      castHash,
      "world model commands attached. ask me what i'm learning, tracking, missing, or planning next.",
      { embedUrl: WORLD_MODEL_COMMANDS_IMAGE_URL },
    );
    return;
  }

  const publicModelCommand = opts.trigger === "mention" ? parsePublicModelCommand(question) : null;
  if (publicModelCommand) {
    const reply = await buildPublicModelCommandReply(publicModelCommand);
    const replyHash = await replyThread(apiKey, signerUuid, castHash, reply.text, 320, {
      referenceCasts: reply.referenceCasts,
    });
    console.log(`[webhook] Replied to public model command: ${replyHash}`);
    return;
  }

  // Check for research/campaign command (operator only)
  const researchMatch = opts.trigger === "mention" ? question.match(/^research\s+(.+)/i) : null;
  if (researchMatch && author.fid === 11528) {
    const topic = researchMatch[1];
    console.log(`[webhook] Research request: "${topic}"`);
    try {
      await replyToCast(apiKey, signerUuid, castHash, "starting research. i'll cast my question shortly.");

      // Import and call proposeCampaign directly with a topic-specific proposal
      const { proposeCampaign } = await import("../jobs/campaign-create.js");
      const { askAtlas: askBrain } = await import("./atlas-brain.js");

      // Ask Claude to draft a campaign proposal for this specific topic
      const proposalResult = await askBrain({
        prompt: `The operator asked you to research: "${topic}"

Draft a campaign proposal as JSON. Think about what specific question would produce the most useful answers from the Farcaster community.

\`\`\`json
{
  "problem": "what you're trying to understand about this topic",
  "currentBelief": "what you currently think",
  "question": "the specific question to ask (make it concrete and answerable)",
  "successTest": "how you'll know if the answers were useful",
  "expectedAction": "memory_update",
  "questionType": "decision",
  "evidenceRequested": ["examples", "counterexamples", "personal experience"],
  "rewardMode": "top_10",
  "lootiDistributionAlgorithm": "the_well",
  "budgetAmount": ${process.env.ATLAS_CAMPAIGN_BUDGET_AMOUNT || "30000000"}
}
\`\`\``,
      });

      if (proposalResult.ok) {
        const jsonMatch = proposalResult.response.match(/```json\s*([\s\S]*?)```/);
        if (jsonMatch) {
          const proposal = JSON.parse(jsonMatch[1]);
          const result = await proposeCampaign(proposal);
          if (result.ok) {
            console.log(`[webhook] Campaign created: ${result.campaignId}`);
          } else {
            console.error(`[webhook] Campaign creation failed: ${result.error}`);
            await replyToCast(apiKey, signerUuid, castHash, "ran into an issue launching the campaign. i'll try again.");
          }
        }
      }
    } catch (err: any) {
      console.error(`[webhook] Failed research flow: ${err.message}`);
      await replyToCast(apiKey, signerUuid, castHash, "something went wrong with the research flow. i'll look into it.");
    }
    return;
  }

  // Check for blog write command (operator only)
  const writeMatch = opts.trigger === "mention" ? question.match(/^write\s+(?:about\s+)?(.+)/i) : null;
  if (writeMatch && author.fid === 11528) {
    console.log(`[webhook] Blog write request: "${writeMatch[1]}"`);
    const writeResult = await askAtlasToWrite(writeMatch[1]);
    try {
      await replyToCast(apiKey, signerUuid, castHash, writeResult);
    } catch (err: any) {
      console.error(`[webhook] Failed to reply with write result: ${err.message}`);
    }
    return;
  }

  const contextHash = opts.trigger === "reply"
    ? opts.threadHash || opts.parentHash || castHash
    : castHash;
  const threadContext = opts.trigger === "reply"
    ? await fetchDirectReplyThreadContext(apiKey, contextHash, author.fid)
    : await fetchMentionThreadContext(apiKey, contextHash, author.fid);
  if (opts.trigger === "reply") {
    console.log(`[webhook] Direct reply context chars: ${threadContext.length} via ${opts.threadHash ? "thread_hash" : opts.parentHash ? "parent_hash" : "cast_hash"}`);
  }
  if (opts.trigger === "reply" && threadContext.length < 120 && isShortClarificationReply(question)) {
    console.log(`[webhook] Ignoring short direct reply with insufficient context from @${author.username}: "${question}"`);
    return;
  }
  const linkContext = await buildLinkReviewContext(`${question}\n${threadContext}`);
  const triggerDescription = opts.trigger === "reply"
    ? "replied directly to one of your casts without tagging you"
    : "mentioned you";
  const requesterMemoryContext = await buildRequesterMemoryContext(author.fid);
  const activeCampaignAwarenessContext = await buildActiveCampaignAwarenessContext({
    text: `${question}\n${threadContext}`,
    apiKey,
  });
  const contextPrompt = linkContext
    ? `A Farcaster user @${author.username} (${author.display_name}, fid:${author.fid}) ${triggerDescription} and included a link.

"${question}"

Recent thread context:
${threadContext || "(none fetched)"}

Requester memory:
${requesterMemoryContext || "(no contributor/KG memory yet)"}

Active campaign awareness:
${activeCampaignAwarenessContext || "(no active campaign context matched)"}

Fetched link context:
${linkContext}

Answer the user's latest question using the fetched link context and recent thread context. Preserve context across follow-ups. If the latest question refers to "this", "that", "it", or "only", resolve it from the thread. If the link context is insufficient, say exactly what you could and could not inspect. You may use multiple concise Farcaster replies if needed. Do not pad.`
    : `A Farcaster user @${author.username} (${author.display_name}, fid:${author.fid}) ${triggerDescription} and said:

"${question}"

Recent thread context:
${threadContext || "(none fetched)"}

Requester memory:
${requesterMemoryContext || "(no contributor/KG memory yet)"}

Active campaign awareness:
${activeCampaignAwarenessContext || "(no active campaign context matched)"}

Respond concisely (under 280 characters). Be helpful, direct, and on-topic.
If the latest question is a follow-up, use the thread context to resolve what they mean.
If this was an untagged direct reply, treat it as a continuation of the existing conversation, not as a new command.
If they're asking about Atlas campaigns, world state, or how to participate, answer from your knowledge.
Do not infer a user's gender from username, display name, writing style, or avatar. Use their handle or they/them unless explicit profile/context says otherwise.
If the question is unclear, ask for clarification.`;

  const result = await askAtlas({ prompt: contextPrompt });
  const responseText = stripCampaignUrls(result.response);

  try {
    const replyHash = linkContext
      ? await replyThread(apiKey, signerUuid, castHash, responseText, LINK_REVIEW_REPLY_CHARS)
      : await replyToCast(apiKey, signerUuid, castHash, responseText);
    console.log(`[webhook] Replied: ${replyHash}`);
  } catch (err: any) {
    console.error(`[webhook] Failed to reply: ${err.message}`);
  }
}

async function handleBrainRequest(body: Record<string, any>): Promise<void> {
  const apiKey = process.env.NEYNAR_API_KEY;
  const signerUuid = process.env.SIGNER_UUID;

  switch (body.action) {
    case "engage-campaign": {
      // Active engagement round: Atlas does MULTIPLE things each round:
      //   1. Fetch all quote-replies to the campaign cast
      //   2. Reply to every NEW contributor with an informed response
      //   3. Quote its own cast with a new angle
      // This runs every 4 hours during collection.
      if (!apiKey || !signerUuid) break;

      const parsedRound = parseInt(body.round || "1", 10);
      const round = Number.isFinite(parsedRound) ? parsedRound : 1;
      const castHash = body.castHash;
      if (!castHash) break;

      const campaignUrl = await resolveSafeCampaignEmbedUrl(body.campaignRunId, body.campaignId, castHash, body);
      console.log(`[engage] Round ${round} for campaign ${body.campaignId}`);

      const db = getDb();
      let repliesPublished = 0;
      let quoteHash: string | null = null;
      let quoteText: string | null = null;
      const engagementEntityId = String(body.campaignRunId || body.campaignId || castHash);
      const engagementLease = await claimActionLease({
        entityType: "campaign_engagement",
        entityId: engagementEntityId,
        reason: String(body.campaignId || "campaign engagement"),
        pendingTtlMinutes: 25,
        successCooldownHours: CAMPAIGN_ENGAGEMENT_COOLDOWN_HOURS,
        successActions: ["published", "completed"],
        newValue: {
          campaignId: body.campaignId,
          castHash,
          round: body.round || String(round),
        },
      });
      if (!engagementLease) {
        console.log(`[engage] Skipping ${body.campaignId} — recent or in-flight engagement lease exists`);
        break;
      }

      // Step 1: Fetch top-ranked contributors from Looti (not raw replies)
      // Only engage with people Looti has ranked — that's the signal boundary
      const lootiApiKey = process.env.ATLAS_LOOTI_API_KEY;
      const lootiBase = process.env.ATLAS_LOOTI_API_BASE_URL || "https://looti.club";
      let contributors: ContributorCast[] = [];
      let notebookContributors: ContributorCast[] = [];
      let contributorSource = "looti";

      if (lootiApiKey && body.campaignId) {
        contributors = await fetchRankedContributors(
          lootiBase, lootiApiKey, body.campaignId, apiKey, castHash,
        );
        notebookContributors = await fetchNotebookContributors(
          lootiBase,
          lootiApiKey,
          body.campaignId,
          castHash,
          typeof body.creatorFid === "number" ? body.creatorFid : 12193,
          apiKey,
          NOTEBOOK_CORPUS_LIMIT,
        );
      }
      if (contributors.length === 0) {
        // Fallback: fetch direct replies if Looti hasn't ranked yet
        contributors = await fetchQuoteReplies(apiKey, castHash);
        contributorSource = "farcaster_replies";
      }
      if (notebookContributors.length === 0) {
        notebookContributors = contributors;
      }
      console.log(`[engage] Found ${contributors.length} contributors via ${contributorSource}`);

      // Find who we've already replied to before writing the notebook snapshot,
      // so any follow-up conversation can become campaign evidence too.
      const alreadyReplied = await db
        .select({ entityId: auditLog.entityId })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.entityType, "engagement_reply"),
            eq(auditLog.reason, body.campaignId),
          ),
        );
      const repliedFids = new Set(alreadyReplied.map((r) => parseInt(r.entityId)));

      notebookContributors = await attachConversationContext(
        apiKey,
        notebookContributors,
        repliedFids,
        10,
      );
      await recordContributorSnapshot(db, {
        campaignRunId: body.campaignRunId,
        campaignId: body.campaignId,
        castHash,
        source: notebookContributors.length > contributors.length ? "looti_live" : contributorSource,
        contributors: notebookContributors,
      });
      await refreshCampaignNotebook({
        campaignRunId: typeof body.campaignRunId === "string" ? body.campaignRunId : undefined,
        campaignId: typeof body.campaignId === "string" ? body.campaignId : undefined,
        castHash,
        source: notebookContributors.length > contributors.length ? "looti_live" : contributorSource,
        contributors: notebookContributors,
        trigger: "engagement_tick",
      }).catch((err) => console.error(`[notebook] Refresh failed: ${err.message}`));

      // Reply to contributors we haven't engaged yet,
      // OR who have replied back since our last reply (conversation mode)
      for (const contrib of contributors) {
        if (contrib.authorFid === 12193) continue; // skip own casts

        let followUp: ContributorFollowUp | null = null;
        if (repliedFids.has(contrib.authorFid)) {
          // We already replied — only re-engage if they replied after Atlas's latest reply.
          followUp = await getContributorFollowUpAfterLatestAtlasReply(apiKey, contrib.castHash, contrib.authorFid);
          if (!followUp) continue;
          console.log(`[engage] @${contrib.authorUsername} replied back — continuing conversation`);
        }
        const replyLease = await claimActionLease({
          entityType: "engagement_reply_claim",
          entityId: [
            body.campaignId || "unknown",
            contrib.authorFid,
            contrib.castHash,
            followUp?.castHash || "initial",
          ].join(":"),
          reason: String(body.campaignId || "campaign engagement reply"),
          pendingTtlMinutes: 20,
          successCooldownHours: 24 * 90,
          successActions: ["replied"],
          newValue: {
            username: contrib.authorUsername,
            castHash: contrib.castHash,
            followUpHash: followUp?.castHash,
          },
        });
        if (!replyLease) continue;

        // Build contributor context via kg-pipeline if available
        const contributorMemory = await buildContributorMemoryContext(db, contrib.authorFid, {
          currentQuestionId: typeof body.questionId === "string" ? body.questionId : undefined,
        });
        let contributorContext = contributorMemory;
        const kgUrl = process.env.ATLAS_KG_PIPELINE_URL;
        if (kgUrl) {
          try {
            const kgHeaders: Record<string, string> = {};
            if (process.env.ATLAS_KG_PIPELINE_API_KEY) {
              kgHeaders["X-API-Key"] = process.env.ATLAS_KG_PIPELINE_API_KEY;
            }
            const kgRes = await fetch(`${kgUrl.replace(/\/$/, "")}/api/v1/graphs/${contrib.authorFid}`, {
              headers: kgHeaders,
            });
            if (kgRes.ok) {
              const kg: any = await kgRes.json();
              const profile = kg.graph || kg.graph_data || kg;
              contributorContext += `\nContributor profile: ${profile.profile_type || "unknown"}, builds: ${(profile.projects || []).map((p: any) => p.name).join(", ") || "unknown"}, expertise: ${(profile.topics || []).slice(0, 5).map((t: any) => t.name).join(", ") || "unknown"}`;
            }
          } catch {
            // KG not available, continue without context
          }
        }

        // Build brief context of other answers so replies can reference cross-contributor patterns
        const otherAnswers = notebookContributors
          .filter((c) => c.authorFid !== contrib.authorFid)
          .slice(0, 8)
          .map((c) => `@${c.authorUsername}: "${c.text.slice(0, 80)}"`)
          .join("; ");

        const replyResult = await askAtlas({
          prompt: `You have an active campaign. A contributor just quoted your question with their answer.

Contributor: @${contrib.authorUsername} (fid:${contrib.authorFid})${contributorContext}
${contrib.rank ? `Looti rank: ${contrib.rank}\n` : ""}Their answer: "${contrib.text}"
${followUp ? `Their latest follow-up after your last reply: "${followUp.text}"\n` : ""}
${otherAnswers ? `Other answers for context: ${otherAnswers}\n` : ""}
Write a brief reply (under 280 characters). Be specific about what's useful, what you'd push back on, or what follow-up their answer suggests. Reference their actual content. Don't be generic.
Write no URLs. Do not include the Looti campaign URL in reply text.`,
        });

        if (replyResult.ok && replyResult.response !== "(error)") {
          const replyText = stripCampaignUrls(replyResult.response);
          let replyHash: string | null = null;
          try {
            replyHash = await publishCastHelper(apiKey, signerUuid, {
              text: replyText,
              parent: contrib.castHash,
            });
          } catch (err) {
            await replyLease.fail(err);
            continue;
          }
          if (!replyHash) {
            await replyLease.fail("publish returned no hash");
            continue;
          }
          repliesPublished += 1;
          console.log(`[engage] Replied to @${contrib.authorUsername}`);

          await db.insert(auditLog).values({
            id: createId(),
            entityType: "engagement_reply_claim",
            entityId: replyLease.entityId,
            action: "replied",
            previousValue: { leaseId: replyLease.id },
            newValue: {
              username: contrib.authorUsername,
              castHash: contrib.castHash,
              replyHash,
              followUpHash: followUp?.castHash,
              repliedAt: new Date().toISOString(),
            },
            actor: "atlas_agent",
            reason: body.campaignId,
          });

          // Record so we don't reply again
          await db.insert(auditLog).values({
            id: createId(),
            entityType: "engagement_reply",
            entityId: String(contrib.authorFid),
            action: "replied",
            newValue: {
              username: contrib.authorUsername,
              castHash: contrib.castHash,
              rank: contrib.rank,
              source: contributorSource,
              text: replyText,
              followUpHash: followUp?.castHash,
              followUpText: followUp?.text,
            },
            actor: "atlas_agent",
            reason: body.campaignId,
          });

          // Small delay between replies to avoid rate limits
          await new Promise((r) => setTimeout(r, 2000));
        } else {
          await replyLease.fail("no good response");
        }
      }

      // Step 3: Quote own cast with a new angle
      // Fetch recent Atlas casts to avoid repetition
      const recentCasts = await db
        .select({ newValue: auditLog.newValue })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.entityType, "campaign_engagement"),
            eq(auditLog.action, "published"),
            gte(auditLog.createdAt, new Date(Date.now() - 48 * 60 * 60 * 1000)),
          ),
        )
        .orderBy(desc(auditLog.createdAt))
        .limit(6);
      const priorQuotes = recentCasts
        .map((r) => {
          const d = r.newValue && typeof r.newValue === "object" ? r.newValue as Record<string, unknown> : {};
          return typeof d.quoteText === "string" ? d.quoteText : null;
        })
        .filter(Boolean)
        .map((t, i) => `  ${i + 1}. "${(t as string).slice(0, 120)}"`)
        .join("\n");

      const quoteResult = await askAtlas({
        prompt: `You have an active campaign (round ${round}). Your question cast: ${castHash}

${notebookContributors.length > 0 ? `So far ${notebookContributors.length} people have responded. Their answers:\n${notebookContributors.slice(0, 20).map((c, i) => `${i + 1}. @${c.authorUsername}${c.rank ? ` (rank #${c.rank})` : ""}: "${c.text.slice(0, 140)}"`).join("\n")}` : "No responses yet."}

${priorQuotes ? `Your recent casts about this campaign (DO NOT repeat these themes or observations):\n${priorQuotes}\n` : ""}Quote your own cast with a new angle — add context, share a thought that came up, refine what you're looking for, or react to what you've seen so far. This draws attention to the campaign.

CRITICAL: Say something NEW. Do not repeat observations from your recent casts above. If you've already noted a pattern, build on it or move to something else entirely.

Write just the cast text (under 280 characters). Be genuine, not promotional.
If you mention Atlas's memory, world model, notebook, transparency, or learning process, explain it in plain public language. Prefer a concrete observation from the responses over internal process. The public campaign notebook URL will be attached as an embed when available, so do not force a raw URL.`,
      });

      if (quoteResult.ok && quoteResult.response !== "(error)") {
        quoteText = stripCampaignUrls(quoteResult.response);
        quoteHash = await publishCastHelper(apiKey, signerUuid, {
          text: quoteText,
          quoteHash: castHash,
          embedUrl: campaignUrl,
        });
        if (quoteHash) {
          console.log(`[engage] Quoted own cast`);
        }
      }

      if (quoteHash || repliesPublished > 0) {
        await db.insert(auditLog).values({
          id: createId(),
          entityType: "campaign_engagement",
          entityId: engagementEntityId,
          action: "published",
          previousValue: { leaseId: engagementLease.id },
          newValue: {
            campaignId: body.campaignId,
            castHash,
            round: body.round || String(round),
            quoteHash,
            quoteText,
            repliesPublished,
          },
          actor: "atlas_agent",
          reason: body.campaignId,
        });
      } else {
        console.log(`[engage] No campaign engagement cast published`);
        await db.insert(auditLog).values({
          id: createId(),
          entityType: "campaign_engagement",
          entityId: engagementEntityId,
          action: "completed",
          previousValue: { leaseId: engagementLease.id },
          newValue: {
            campaignId: body.campaignId,
            castHash,
            round: body.round || String(round),
            repliesPublished,
          },
          actor: "atlas_agent",
          reason: body.campaignId,
        });
      }

      break;
    }

    case "synthesize": {
      const lootiKey = process.env.ATLAS_LOOTI_API_KEY;
      const lootiUrl = process.env.ATLAS_LOOTI_API_BASE_URL || "https://looti.club";
      if (!body.campaignRunId) {
        console.error("[brain-api] Synthesize missing campaignRunId");
        break;
      }
      if (!lootiKey) {
        console.error("[brain-api] Synthesize missing ATLAS_LOOTI_API_KEY");
        break;
      }

      const lootiCampaign = body.campaignId
        ? await fetchLootiCampaignStatus(lootiUrl, lootiKey, body.campaignId)
        : null;
      if (lootiCampaign && !isRewardSetReady(lootiCampaign)) {
        const expiresAt = readLootiExpiresAt(lootiCampaign);
        if (body.campaignRunId && expiresAt) {
          await updateCampaignCollectEnd(body.campaignRunId, addMinutes(expiresAt, 10), {
            lootiStatus: lootiCampaign.status,
            rewardSetReady: lootiCampaign.rewardSetReady,
            lootiExpiresAt: expiresAt.toISOString(),
            synthesisDeferredAt: new Date().toISOString(),
          });
        }
        const err: any = new Error(`Looti reward set is not ready for ${body.campaignId}`);
        err.status = 425;
        throw err;
      }

      const synthesis = await synthesizeCampaign({
        db: getDb(),
        campaignRunId: body.campaignRunId,
        lootiClient: createHttpLootiClient({
          baseUrl: lootiUrl,
          apiKey: lootiKey,
        }),
        rewardSetLimit: readRewardSetLimit(),
        recordAllocations: process.env.ATLAS_RECORD_ALLOCATIONS === "true",
      });
      console.log(
        `[brain-api] Synthesized ${synthesis.campaignId}: ${synthesis.rewardSet.entries.length} entries (${synthesis.synthesisResult})`,
      );

      // Close the review loop — update entities.md, timeline.md, review.md
      if (synthesis.rewardSet.entries.length > 0) {
        try {
          const reviewResult = await closeReviewLoop({
            campaignId: synthesis.campaignId,
            rewardSet: synthesis.rewardSet,
            synthesisResult: synthesis.synthesisResult,
          });
          console.log(
            `[brain-api] Review loop closed: ${reviewResult.entitiesUpdated} new contributors, timeline=${reviewResult.timelineAppended}, review=${reviewResult.reviewClosed}`,
          );
        } catch (err: any) {
          console.error(`[brain-api] Review loop failed: ${err.message}`);
        }
      }

      if (!apiKey || !signerUuid) break;

      // Fetch the ranked contributors for this campaign
      let topContributors: ContributorCast[] = [];

      if (body.campaignId) {
        topContributors = await fetchRankedContributors(
          lootiUrl, lootiKey, body.campaignId, apiKey, body.castHash,
        );
      }
      if (body.campaignId && topContributors.length > 0) {
        const priorReplies = await getDb()
          .select({ entityId: auditLog.entityId })
          .from(auditLog)
          .where(
            and(
              eq(auditLog.entityType, "engagement_reply"),
              eq(auditLog.reason, body.campaignId),
            ),
          );
        topContributors = await attachConversationContext(
          apiKey,
          topContributors,
          new Set(priorReplies.map((r) => parseInt(r.entityId))),
          10,
        );
      }

      const contributorSummary = topContributors.length > 0
        ? (await Promise.all(topContributors.slice(0, 10).map(async (c, i) => {
            const memory = await buildContributorMemoryContext(getDb(), c.authorFid, {
              currentQuestionId: typeof body.questionId === "string" ? body.questionId : undefined,
              compact: true,
            });
            return `${i + 1}. @${c.authorUsername}: "${c.text.slice(0, 150)}"${memory ? `\n   prior memory: ${memory.replace(/\n/g, " ").slice(0, 360)}` : ""}${c.conversation?.length ? `\n   follow-up thread: ${c.conversation.join(" / ").slice(0, 320)}` : ""}`;
          }))).join("\n")
        : "(no ranked responses yet)";

      // Ask Claude to synthesize
      const result = await askAtlas({
        prompt: `You just finished collecting responses for campaign ${body.campaignId}.

Top ranked contributors:
${contributorSummary}

Do two things:

1. SYNTHESIZE: Review these answers. What did you learn? What changed your thinking? Decide: no action, memory update, follow-up question, or build something. Write your rationale briefly.

2. ATTRIBUTION CAST: Write a cast (under 1024 characters) that summarizes what you learned and tags the contributors whose answers shaped the outcome. Use @username to tag them. Be specific about what each person contributed. This is how contributors get public credit.

Format your response as:
SYNTHESIS: [your rationale]
---
CAST: [the attribution cast text]`,
      });

      console.log(`[brain-api] Synthesize result: ${result.response.slice(0, 200)}`);

      // Parse and publish the attribution cast — only once per campaign
      if (result.ok && body.campaignId) {
        const attributionLease = await claimActionLease({
          entityType: "synthesis_attribution",
          entityId: String(body.campaignId),
          reason: `Attribution cast for ${body.campaignId}`,
          pendingTtlMinutes: 10,
          successCooldownHours: 24 * 365,
          successActions: ["posted"],
        });
        if (attributionLease) {
          const castMatch = result.response.match(/CAST:\s*([\s\S]+?)$/);
          if (castMatch) {
            const castText = castMatch[1].trim();
            const synthCampaignUrl = await resolveSafeCampaignEmbedUrl(body.campaignRunId, body.campaignId, body.castHash, body);
            const hash = await publishCastHelper(apiKey, signerUuid, { text: castText, embedUrl: synthCampaignUrl });
            if (hash) {
              console.log(`[brain-api] Attribution cast published: ${hash}`);
              await getDb().insert(auditLog).values({
                id: createId(),
                entityType: "synthesis_attribution",
                entityId: String(body.campaignId),
                action: "posted",
                newValue: { castHash: hash, text: castText },
                actor: "atlas_agent",
                reason: `Attribution cast for ${body.campaignId}`,
              });
            } else {
              await attributionLease.fail("publish returned no hash");
            }
          } else {
            await attributionLease.fail("no CAST block in response");
          }
        } else {
          console.log(`[brain-api] Skipping attribution cast — already published for ${body.campaignId}`);
        }
      }
      break;
    }

    case "evaluate": {
      const result = await askAtlas({
        prompt: `Evaluate campaign ${body.campaignId}. Did the answers lead to anything useful? Did Atlas's behavior change? Should this question pattern be reused? Write a brief assessment.`,
      });
      console.log(`[brain-api] Evaluate result: ${result.response.slice(0, 200)}`);
      break;
    }

    case "final-label": {
      const result = await askAtlas({
        prompt: `Apply a final label to campaign ${body.campaignId}. Was this line of inquiry worth it? Did contributors' answers hold up? Update reputation assessments. Write a brief final assessment.`,
      });
      console.log(`[brain-api] Final label result: ${result.response.slice(0, 200)}`);
      break;
    }

    case "propose-campaign": {
      await runCampaignCreationCheck();
      break;
    }

    case "post": {
      const { runAtlasPost } = await import("../jobs/atlas-posts.js");
      await runAtlasPost();
      break;
    }

    case "kg-refresh": {
      try {
        const { runKgProfileRefresh } = await import("../../../workers/src/kg-profile-refresh.js");
        const result = await runKgProfileRefresh();
        await recordProactiveAction(
          "kg_profile_refresh",
          "contributors",
          result.failed > 0 ? "partial_failure" : "queued",
          `Queued ${result.queued}/${result.targets} KG profile refresh jobs`,
          result,
        );
      } catch (err: any) {
        console.error(`[brain-api] kg-refresh unavailable: ${err.message}`);
      }
      break;
    }

    case "tick": {
      await runProactiveTick();
      break;
    }

    case "write-article": {
      if (body.topic) {
        const result = await askAtlasToWrite(body.topic);
        console.log(`[brain-api] Write result: ${result}`);
      }
      break;
    }

    case "think": {
      const prompt = body.topic
        ? `Think about this: ${body.topic}`
        : `Review your current world state and decide if any action is needed.`;
      const result = await askAtlas({ prompt });
      console.log(`[brain-api] Think result: ${result.response.slice(0, 200)}`);
      break;
    }

    default:
      console.log(`[brain-api] Unknown action: ${body.action}`);
  }
}

async function runProactiveTick(): Promise<void> {
  console.log("[tick] Starting proactive tick");

  await runHeartbeat();
  await runLifecycleCheck();

  const db = getDb();
  const actions: string[] = [];

  const activeCampaigns = await getActiveCampaignsForTick();
  if (activeCampaigns.length > 1) {
    await recordProactiveAction("campaign_invariant", "active_campaign_count", "warning", "More than one active campaign exists");
  }

  const activeCampaign = activeCampaigns[0];
  if (activeCampaign) {
    actions.push(`active-campaign:${activeCampaign.campaignId}`);

    if (
      activeCampaign.lifecycleStage === "collect" &&
      activeCampaign.castHash &&
      !(await hasRecentAudit("campaign_engagement", activeCampaign.campaignRunId, CAMPAIGN_ENGAGEMENT_COOLDOWN_HOURS))
    ) {
      await handleBrainRequest({
        action: "engage-campaign",
        campaignRunId: activeCampaign.campaignRunId,
        campaignId: activeCampaign.campaignId,
        questionId: activeCampaign.questionId,
        castHash: activeCampaign.castHash,
        campaignUrl: readCampaignUrl(activeCampaign),
        round: "hourly",
      });
      actions.push(`engage:${activeCampaign.campaignId}`);
    } else if (!(await hasRecentAudit("atlas_post", "self", ATLAS_POST_COOLDOWN_HOURS))) {
      const { runAtlasPost } = await import("../jobs/atlas-posts.js");
      const posted = await runAtlasPost();
      if (posted) {
        actions.push("post");
      }
    }
  } else {
    actions.push("no-active-campaign");

    if (!(await hasRecentAudit("campaign_creation_check", "self", 1))) {
      const createResult = await runCampaignCreationCheck();
      await recordProactiveAction(
        "campaign_creation_check",
        "self",
        createResult?.ok ? "launched" : createResult ? "failed" : "no_campaign",
        createResult?.ok
          ? `Launched ${createResult.campaignId}`
          : createResult?.error || "Atlas chose not to launch a campaign",
      );
      actions.push(createResult?.ok ? `launch:${createResult.campaignId}` : "campaign-check");
    }
  }

  if (!(await hasRecentAudit("blog_check", "self", 24))) {
    const blogResult = await runBlogCheck();
    await recordProactiveAction(
      "blog_check",
      "self",
      blogResult.status,
      blogResult.reason || blogResult.title || "Hourly proactive tick",
      blogResult,
    );
    actions.push("blog-check");
  }

  console.log(`[tick] Actions: ${actions.length > 0 ? actions.join(", ") : "none"}`);
}

async function getActiveCampaignsForTick() {
  const db = getDb();
  return db
    .select({
      campaignRunId: campaignRuns.id,
      campaignId: campaignRuns.campaignId,
      questionId: campaignRuns.questionId,
      lifecycleStage: campaignRuns.lifecycleStage,
      expectedAction: campaignRuns.expectedAction,
      metadata: campaignRuns.metadata,
      castHash: questions.farcasterCastHash,
      createdAt: campaignRuns.createdAt,
    })
    .from(campaignRuns)
    .leftJoin(questions, eq(campaignRuns.questionId, questions.id))
    .where(
      and(
        eq(campaignRuns.status, "active"),
        inArray(campaignRuns.lifecycleStage, LIVE_CAMPAIGN_STAGES),
      ),
    )
    .orderBy(desc(campaignRuns.createdAt))
    .limit(5);
}

async function isAllowedReplyAuthor(fid: number): Promise<boolean> {
  const staticAllowedFids = (process.env.ATLAS_REPLY_ALLOWED_FIDS || "")
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
  if (staticAllowedFids.includes(fid)) return true;

  if (process.env.ATLAS_DYNAMIC_REPLY_ALLOWLIST !== "true") {
    return staticAllowedFids.length === 0;
  }

  return isRecentTopCampaignContributor(fid);
}

async function isRecentTopCampaignContributor(fid: number): Promise<boolean> {
  const since = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
  const rows = await getDb()
    .select({ newValue: auditLog.newValue })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entityType, "campaign_contributor_snapshot"),
        gte(auditLog.createdAt, since),
      ),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(40);

  const seenCampaigns = new Set<string>();
  for (const row of rows) {
    const data = row.newValue && typeof row.newValue === "object"
      ? row.newValue as Record<string, unknown>
      : {};
    const campaignId = typeof data.campaignId === "string" ? data.campaignId : "";
    if (campaignId && seenCampaigns.has(campaignId)) continue;
    if (campaignId) seenCampaigns.add(campaignId);

    const contributors = Array.isArray(data.contributors) ? data.contributors : [];
    for (const contributor of contributors.slice(0, 10)) {
      if (!contributor || typeof contributor !== "object") continue;
      const c = contributor as Record<string, unknown>;
      const contributorFid = typeof c.fid === "number" ? c.fid : Number(c.fid);
      if (contributorFid === fid) return true;
    }
  }

  return false;
}

type PublicModelCommand =
  | "world_model"
  | "world_changes"
  | "world_people"
  | "world_topics"
  | "campaign_brief"
  | "campaign_learnings"
  | "campaign_answers"
  | "campaign_next"
  | "campaign_contributors"
  | "campaign_gaps"
  | "campaign_notebook";

type OpsCommand =
  | { type: "status" }
  | { type: "check_worker" }
  | { type: "check_notebook" }
  | { type: "check_og"; url: string }
  | { type: "recent_errors" }
  | { type: "active_campaign" };

function parseOpsCommand(question: string): OpsCommand | null {
  const normalized = question.trim().replace(/\s+/g, " ");
  const match = normalized.match(/^ops:?\s+(.+)$/i);
  if (!match) return null;
  const body = match[1].trim();
  if (/^status$/i.test(body)) return { type: "status" };
  if (/^check\s+worker$/i.test(body)) return { type: "check_worker" };
  if (/^check\s+notebook$/i.test(body)) return { type: "check_notebook" };
  if (/^recent\s+errors$/i.test(body)) return { type: "recent_errors" };
  if (/^active\s+campaign$/i.test(body)) return { type: "active_campaign" };
  const ogMatch = body.match(/^check\s+og\s+(https?:\/\/\S+)$/i);
  if (ogMatch) return { type: "check_og", url: ogMatch[1] };
  return null;
}

async function buildOpsCommandReply(command: OpsCommand): Promise<string> {
  if (command.type === "status") return buildOpsStatusReply();
  if (command.type === "check_worker") return buildOpsWorkerReply();
  if (command.type === "check_notebook") return buildOpsNotebookReply();
  if (command.type === "check_og") return buildOpsOgReply(command.url);
  if (command.type === "recent_errors") return buildOpsRecentErrorsReply();
  return buildOpsActiveCampaignReply();
}

async function buildOpsStatusReply(): Promise<string> {
  const [runtime, worker, context] = await Promise.all([
    fetchJsonStatus("https://api.joinatlas.xyz/health"),
    fetchJsonStatus("https://atlas-worker.jacob-247.workers.dev/health"),
    loadPublicModelContext(),
  ]);
  const campaign = context.activeCampaign;
  return [
    `runtime: ${runtime.ok ? "ok" : `bad (${runtime.status})`}`,
    `worker: ${worker.ok ? "ok" : `bad (${worker.status})`}`,
    campaign ? `active campaign: ${campaign.lifecycleStage}/${campaign.status} ${campaign.campaignId || campaign.campaignRunId}` : "active campaign: none",
    context.page?.url ? `notebook: ${context.page.url}` : "notebook: none",
  ].join("\n");
}

async function buildOpsWorkerReply(): Promise<string> {
  const worker = await fetchJsonStatus("https://atlas-worker.jacob-247.workers.dev/health");
  return [
    `worker: ${worker.ok ? "ok" : "not ok"}`,
    `http: ${worker.status}`,
    worker.body ? `body: ${summarizeOneLine(worker.body, 220)}` : "",
  ].filter(Boolean).join("\n");
}

async function buildOpsNotebookReply(): Promise<string> {
  const context = await loadPublicModelContext();
  if (!context.page?.url) return "no active campaign notebook URL found.";
  const og = await inspectOpenGraph(context.page.url);
  return formatOgInspection(`notebook: ${context.page.url}`, og);
}

async function buildOpsOgReply(url: string): Promise<string> {
  const og = await inspectOpenGraph(url);
  return formatOgInspection(`url: ${url}`, og);
}

async function buildOpsActiveCampaignReply(): Promise<string> {
  const context = await loadPublicModelContext();
  return buildCampaignBriefReply(context);
}

async function buildOpsRecentErrorsReply(): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync("journalctl", [
      "-u",
      "atlas-runtime",
      "--since",
      "2 hours ago",
      "--no-pager",
      "-n",
      "240",
    ], { timeout: 5000, maxBuffer: 180_000 });
    const body = `${stdout}\n${stderr}`;
    const matches = body
      .split("\n")
      .filter((line) => /\b(error|failed|exception|warn|unhandled|timeout)\b/i.test(line))
      .map(redactLogLine)
      .filter(Boolean);
    if (matches.length === 0) return "recent runtime errors: none found in the last 2h.";
    const last = matches.slice(-5);
    return [
      `recent runtime errors: ${matches.length} matching log lines in last 2h`,
      ...last.map((line) => `- ${summarizeOneLine(line, 240)}`),
    ].join("\n");
  } catch (err: any) {
    return `recent runtime errors: unable to read journal (${summarizeOneLine(err?.message || "unknown error", 180)})`;
  }
}

async function fetchJsonStatus(url: string): Promise<{ ok: boolean; status: number | string; body?: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body };
  } catch (err: any) {
    return { ok: false, status: err?.name || "fetch_error" };
  }
}

async function inspectOpenGraph(url: string): Promise<OpenGraphInspection> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(7000) });
    const html = await res.text();
    const title = readMetaContent(html, "property", "og:title")
      || readMetaContent(html, "name", "twitter:title")
      || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim();
    const imageRaw = readMetaContent(html, "property", "og:image")
      || readMetaContent(html, "property", "og:image:secure_url")
      || readMetaContent(html, "name", "twitter:image");
    const imageUrl = imageRaw ? new URL(decodeHtmlEntities(imageRaw), url).toString() : undefined;
    let imageStatus: string | undefined;
    let imageType: string | undefined;
    if (imageUrl) {
      const imageRes = await fetch(imageUrl, { method: "HEAD", signal: AbortSignal.timeout(7000) });
      imageStatus = String(imageRes.status);
      imageType = imageRes.headers.get("content-type") || undefined;
    }
    return {
      ok: res.ok,
      status: res.status,
      title: title ? decodeHtmlEntities(title) : undefined,
      imageUrl,
      imageStatus,
      imageType,
    };
  } catch (err: any) {
    return {
      ok: false,
      status: err?.name || "fetch_error",
    };
  }
}

function formatOgInspection(label: string, og: OpenGraphInspection): string {
  return [
    label,
    `page: ${og.ok ? "ok" : "not ok"} (${og.status})`,
    og.title ? `title: ${summarizeOneLine(og.title, 180)}` : "title: missing",
    og.imageUrl ? `image: ${og.imageUrl}` : "image: missing",
    og.imageUrl ? `image status: ${og.imageStatus || "unknown"} ${og.imageType || ""}`.trim() : "",
  ].filter(Boolean).join("\n");
}

function redactLogLine(line: string): string {
  return line
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(api[_-]?key|token|secret|password)=\S+/gi, "$1=[redacted]")
    .replace(/(NEYNAR_API_KEY|SIGNER_UUID|SUPABASE_SERVICE_ROLE_KEY|ATLAS_LOOTI_API_KEY)\S*/g, "$1=[redacted]")
    .trim();
}

interface OpenGraphInspection {
  ok: boolean;
  status: number | string;
  title?: string;
  imageUrl?: string;
  imageStatus?: string;
  imageType?: string;
}

function parsePublicModelCommand(question: string): PublicModelCommand | null {
  const normalized = question
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^world:\s*/, "world ")
    .replace(/^campaign:\s*/, "campaign ");

  if (normalized === "world model") return "world_model";
  if (normalized === "world changes") return "world_changes";
  if (normalized === "world people") return "world_people";
  if (normalized === "world topics") return "world_topics";
  if (normalized === "campaign brief") return "campaign_brief";
  if (normalized === "campaign learnings") return "campaign_learnings";
  if (normalized === "campaign answers") return "campaign_answers";
  if (normalized === "campaign next") return "campaign_next";
  if (normalized === "campaign contributors") return "campaign_contributors";
  if (normalized === "campaign gaps") return "campaign_gaps";
  if (normalized === "campaign notebook") return "campaign_notebook";
  return null;
}

function isPersonalContributorMemoryRequest(question: string): boolean {
  const normalized = question.trim().toLowerCase().replace(/\s+/g, " ");
  return /^(my\s+)?(fidelity|contributor memory|atlas memory|reputation|contributor score)$/.test(normalized) ||
    /\b(show|what'?s|what is|tell me)\b.*\b(my)\b.*\b(fidelity|contributor memory|atlas memory|reputation|contributor score)\b/i.test(normalized);
}

async function buildPersonalContributorMemoryReply(
  author: { fid: number; username: string; display_name: string },
): Promise<string> {
  const db = getDb();
  const memory = await buildContributorMemoryDetails(db, author.fid, { compact: true });
  const kg = await fetchKgContributorProfileContext(author.fid, { compact: true });

  if (!memory && !kg) {
    return `@${author.username} i don't have contributor fidelity data for you yet. it appears after you rank in a campaign top 10 or after a KG profile is generated.`;
  }

  const parts = [`@${author.username} contributor memory:`];
  if (memory) {
    parts.push(memory.replace(/^Contributor memory:\n?/, "").trim());
  }
  if (kg) {
    parts.push(kg.replace(/^Contributor profile:\s*/i, "KG: ").trim());
  }
  return parts.join("\n").slice(0, 950);
}

async function buildPublicModelCommandReply(command: PublicModelCommand): Promise<PublicModelCommandReply> {
  const context = await loadPublicModelContext();
  if (!context.activeCampaign && command.startsWith("campaign_")) {
    return { text: "no active campaign right now. try @atlas world model for the broader state." };
  }

  const referenceCasts = collectPublicReferenceCasts(context, command);
  if (command === "campaign_brief") {
    return {
      text: buildCampaignBriefReply(context),
      referenceCasts,
    };
  }
  if (command === "campaign_contributors") {
    return {
      text: buildCampaignContributorsReply(context),
      referenceCasts,
    };
  }
  if (command === "campaign_notebook") {
    return {
      text: buildCampaignNotebookReply(context),
      referenceCasts,
    };
  }

  const prompt = buildPublicModelPrompt(command, context);
  const result = await askAtlas({ prompt });
  if (!result.ok || result.response === "(error)") {
    return { text: "i couldn't synthesize that command cleanly from the current public data." };
  }
  return {
    text: stripCampaignUrls(result.response)
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
    referenceCasts,
  };
}

async function loadPublicModelContext(): Promise<PublicModelContext> {
  const db = getDb();
  const [activeCampaign] = await db
    .select({
      campaignRunId: campaignRuns.id,
      campaignId: campaignRuns.campaignId,
      status: campaignRuns.status,
      lifecycleStage: campaignRuns.lifecycleStage,
      expectedAction: campaignRuns.expectedAction,
      synthesisResult: campaignRuns.synthesisResult,
      metadata: campaignRuns.metadata,
      createdAt: campaignRuns.createdAt,
      updatedAt: campaignRuns.updatedAt,
      questionText: questions.text,
      questionProblem: questions.problem,
      questionBelief: questions.currentBelief,
      questionSuccessTest: questions.successTest,
      farcasterCastHash: questions.farcasterCastHash,
    })
    .from(campaignRuns)
    .leftJoin(questions, eq(campaignRuns.questionId, questions.id))
    .where(eq(campaignRuns.status, "active"))
    .orderBy(desc(campaignRuns.createdAt))
    .limit(1);

  const recentCampaigns = await db
    .select({
      campaignRunId: campaignRuns.id,
      campaignId: campaignRuns.campaignId,
      status: campaignRuns.status,
      lifecycleStage: campaignRuns.lifecycleStage,
      synthesisResult: campaignRuns.synthesisResult,
      createdAt: campaignRuns.createdAt,
      questionText: questions.text,
    })
    .from(campaignRuns)
    .leftJoin(questions, eq(campaignRuns.questionId, questions.id))
    .orderBy(desc(campaignRuns.createdAt))
    .limit(5);

  let page: PublicCampaignPageContext | null = null;
  let notes: PublicCampaignNoteContext[] = [];
  if (activeCampaign?.campaignRunId) {
    const [pageRow] = await db
      .select({
        slug: campaignPublicPages.slug,
        title: campaignPublicPages.title,
        bodyMarkdown: campaignPublicPages.bodyMarkdown,
        snapshotJson: campaignPublicPages.snapshotJson,
        updatedAt: campaignPublicPages.updatedAt,
      })
      .from(campaignPublicPages)
      .where(eq(campaignPublicPages.campaignRunId, activeCampaign.campaignRunId))
      .orderBy(desc(campaignPublicPages.updatedAt))
      .limit(1);
    if (pageRow) {
      page = {
        ...pageRow,
        url: buildPublicNotebookEmbedUrl(pageRow.slug),
      };
    }

    notes = await db
      .select({
        bodyMarkdown: campaignPublicEvents.bodyMarkdown,
        snapshotJson: campaignPublicEvents.snapshotJson,
        createdAt: campaignPublicEvents.createdAt,
      })
      .from(campaignPublicEvents)
      .where(
        and(
          eq(campaignPublicEvents.campaignRunId, activeCampaign.campaignRunId),
          eq(campaignPublicEvents.eventType, "atlas_note"),
        ),
      )
      .orderBy(desc(campaignPublicEvents.createdAt))
      .limit(3);
  }

  const contributorSnapshot = activeCampaign
    ? await loadLatestContributorSnapshot(activeCampaign.campaignRunId, activeCampaign.campaignId)
    : null;

  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const recentChanges = await db
    .select({
      entityType: auditLog.entityType,
      action: auditLog.action,
      reason: auditLog.reason,
      newValue: auditLog.newValue,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .where(gte(auditLog.createdAt, since))
    .orderBy(desc(auditLog.createdAt))
    .limit(30);

  const lootiUrl = activeCampaign
    ? await resolveCampaignUrl(activeCampaign.campaignId, activeCampaign.farcasterCastHash, activeCampaign)
    : undefined;

  return {
    activeCampaign: activeCampaign || null,
    page,
    notes,
    contributorSnapshot,
    recentCampaigns,
    recentChanges,
    lootiUrl,
  };
}

async function loadLatestContributorSnapshot(
  campaignRunId: string,
  campaignId: string | null,
): Promise<PublicContributorSnapshot | null> {
  const rows = await getDb()
    .select({
      entityId: auditLog.entityId,
      newValue: auditLog.newValue,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .where(eq(auditLog.entityType, "campaign_contributor_snapshot"))
    .orderBy(desc(auditLog.createdAt))
    .limit(40);

  for (const row of rows) {
    const value = row.newValue && typeof row.newValue === "object"
      ? row.newValue as Record<string, unknown>
      : {};
    const rowCampaignId = typeof value.campaignId === "string" ? value.campaignId : null;
    if (row.entityId !== campaignRunId && rowCampaignId !== campaignId && rowCampaignId !== campaignRunId) continue;
    const contributors = Array.isArray(value.contributors)
      ? value.contributors.map(readPublicContributor).filter((contributor): contributor is PublicContributor => Boolean(contributor))
      : [];
    return {
      source: typeof value.source === "string" ? value.source : "unknown",
      castHash: typeof value.castHash === "string" ? value.castHash : null,
      contributors,
      createdAt: row.createdAt,
    };
  }

  return null;
}

function readPublicContributor(input: unknown): PublicContributor | null {
  if (!input || typeof input !== "object") return null;
  const data = input as Record<string, unknown>;
  const username = typeof data.username === "string" ? data.username : "";
  const text = typeof data.text === "string" ? data.text : "";
  if (!username || !text) return null;
  return {
    rank: typeof data.rank === "number" ? data.rank : undefined,
    fid: typeof data.fid === "number" ? data.fid : undefined,
    username,
    text,
    castHash: typeof data.castHash === "string" ? data.castHash : undefined,
  };
}

function collectPublicReferenceCasts(
  context: PublicModelContext,
  command: PublicModelCommand,
): CastReference[] {
  const contributors = context.contributorSnapshot?.contributors || [];
  const refs: CastReference[] = [];
  const seen = new Set<string>();
  const add = (fid?: number, hash?: string) => {
    if (!fid || !hash || seen.has(hash)) return;
    refs.push({ fid, hash });
    seen.add(hash);
  };

  if (command === "world_changes" || command === "campaign_next") {
    for (const contributor of contributors.slice(0, 4)) add(contributor.fid, contributor.castHash);
    return refs;
  }

  if (command === "world_people") {
    for (const contributor of contributors.slice(0, 6)) add(contributor.fid, contributor.castHash);
    return refs;
  }

  for (const contributor of contributors.slice(0, 8)) add(contributor.fid, contributor.castHash);
  return refs;
}

function buildCampaignBriefReply(context: PublicModelContext): string {
  const campaign = context.activeCampaign;
  if (!campaign) return "no active campaign right now.";

  const contributors = context.contributorSnapshot?.contributors || [];
  const top = contributors
    .slice(0, 3)
    .map((c) => `@${c.username}`)
    .join(", ");
  const lines = [
    `active campaign: ${campaign.lifecycleStage}/${campaign.status}`,
    `question: ${campaign.questionText || campaign.campaignId || "unknown"}`,
    campaign.questionProblem ? `why: ${campaign.questionProblem}` : "",
    campaign.questionBelief ? `current belief: ${campaign.questionBelief}` : "",
    contributors.length > 0 ? `current corpus: ${contributors.length} ranked answers${top ? `; top: ${top}` : ""}` : "current corpus: no ranked snapshot yet",
    context.page?.url ? `notebook: ${context.page.url}` : "",
    context.lootiUrl ? `looti: ${context.lootiUrl}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

function buildCampaignContributorsReply(context: PublicModelContext): string {
  const contributors = context.contributorSnapshot?.contributors || [];
  if (contributors.length === 0) return "no ranked contributor snapshot yet for the active campaign.";

  const lines = contributors.slice(0, 8).map((contributor, index) => {
    const rank = contributor.rank || index + 1;
    return `#${rank} @${contributor.username}: ${summarizeOneLine(contributor.text, 180)}`;
  });
  return [
    `top contributors from the latest ${context.contributorSnapshot?.source || "campaign"} snapshot:`,
    ...lines,
  ].join("\n");
}

function buildCampaignNotebookReply(context: PublicModelContext): string {
  const latestNote = context.notes[0]?.bodyMarkdown
    ? stripMarkdown(context.notes[0].bodyMarkdown).slice(0, 420)
    : "";
  const lines = [
    context.page?.url ? `notebook: ${context.page.url}` : "no public notebook page found yet.",
    context.page?.updatedAt ? `updated: ${formatDate(context.page.updatedAt)}` : "",
    latestNote ? `latest note: ${latestNote}` : "latest note: none yet; Atlas has not written a public notebook note for this snapshot.",
  ];
  return lines.filter(Boolean).join("\n");
}

function buildPublicModelPrompt(command: PublicModelCommand, context: PublicModelContext): string {
  const active = context.activeCampaign;
  const contributors = context.contributorSnapshot?.contributors || [];
  const contributorLines = contributors.length
    ? contributors.slice(0, 10).map((c) => {
        const rank = c.rank ? `#${c.rank}` : "-";
        return `${rank} @${c.username}: ${c.text.slice(0, 300)}`;
      }).join("\n")
    : "(no contributor snapshot yet)";
  const noteLines = context.notes.length
    ? context.notes.map((note) => `- ${note.bodyMarkdown.slice(0, 700)}`).join("\n")
    : "(no notebook notes yet)";
  const campaignLines = context.recentCampaigns
    .map((campaign) => `- ${campaign.status}/${campaign.lifecycleStage}: ${campaign.questionText || campaign.campaignId || campaign.campaignRunId}`)
    .join("\n");
  const changeLines = context.recentChanges
    .filter((change) => !["campaign_contributor_snapshot"].includes(change.entityType))
    .slice(0, 12)
    .map((change) => `- ${formatDate(change.createdAt)} ${change.entityType}:${change.action}${change.reason ? ` (${change.reason})` : ""}`)
    .join("\n") || "(no recent public changes)";

  const common = `You are Atlas, replying publicly on Farcaster to a command.

Use only public-safe information. Do not expose secrets, raw logs, env vars, private paths, or internal stack traces.
Be specific and concise. Use plain text. Mention uncertainty where the data is thin.
Do not include raw campaign URLs unless the command explicitly asks for a brief.

Active campaign:
${active ? JSON.stringify({
    campaignId: active.campaignId,
    stage: active.lifecycleStage,
    status: active.status,
    expectedAction: active.expectedAction,
    synthesisResult: active.synthesisResult,
    question: active.questionText,
    problem: active.questionProblem,
    currentBelief: active.questionBelief,
    successTest: active.questionSuccessTest,
    notebook: context.page?.url,
  }, null, 2) : "(none)"}

Recent campaigns:
${campaignLines || "(none)"}

Current contributor snapshot:
${contributorLines}

Recent notebook notes:
${noteLines}

Recent public changes:
${changeLines}`;

  if (command === "world_model") {
    return `${common}

Command: world model.
Summarize the current public world model in 3-5 short bullets: what Atlas is tracking, what it believes, what evidence it has, and what remains uncertain.`;
  }
  if (command === "world_changes") {
    return `${common}

Command: world changes.
Summarize recent belief/model changes in 3-5 short bullets. Tie each change to campaign evidence or notebook activity when possible.`;
  }
  if (command === "world_people") {
    return `${common}

Command: world people.
Summarize the public people map Atlas can infer from campaign evidence. Name people only when they appear in the contributor snapshot or recent campaign evidence. Include what each person is associated with and keep uncertainty clear.`;
  }
  if (command === "world_topics") {
    return `${common}

Command: world topics.
Summarize the topics Atlas is currently tracking, the evidence behind them, and the biggest uncertainty for each. Use 3-6 short bullets.`;
  }
  if (command === "campaign_learnings") {
    return `${common}

Command: campaign learnings.
Summarize what the active campaign has taught Atlas so far. Use 3-5 bullets. Credit contributor usernames when useful.`;
  }
  if (command === "campaign_answers") {
    return `${common}

Command: campaign answers.
Cluster the active campaign answers. Include top themes, disagreements, missing inputs, and 2-4 representative contributors.`;
  }
  if (command === "campaign_gaps") {
    return `${common}

Command: campaign gaps.
List what evidence is still missing before Atlas should update memory or ask a next question. Be concrete about who or what kind of answer would help.`;
  }
  return `${common}

Command: campaign next.
Propose the next useful campaign question Atlas should ask after this one. Include why that question follows from the current evidence and what answer would unblock.`;
}

function summarizeOneLine(text: string, maxChars: number): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars)
    .replace(/\s+\S*$/, "")
    .trim();
}

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/[#*_`>\-[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function formatDate(value: Date | string | null): string {
  if (!value) return "unknown";
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "unknown";
  return date.toISOString().slice(0, 10);
}

interface PublicModelContext {
  activeCampaign: PublicActiveCampaign | null;
  page: PublicCampaignPageContext | null;
  notes: PublicCampaignNoteContext[];
  contributorSnapshot: PublicContributorSnapshot | null;
  recentCampaigns: Array<{
    campaignRunId: string;
    campaignId: string | null;
    status: string;
    lifecycleStage: string;
    synthesisResult: string | null;
    createdAt: Date;
    questionText: string | null;
  }>;
  recentChanges: Array<{
    entityType: string;
    action: string;
    reason: string | null;
    newValue: unknown;
    createdAt: Date;
  }>;
  lootiUrl?: string;
}

interface PublicActiveCampaign {
  campaignRunId: string;
  campaignId: string | null;
  status: string;
  lifecycleStage: string;
  expectedAction: string;
  synthesisResult: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
  questionText: string | null;
  questionProblem: string | null;
  questionBelief: string | null;
  questionSuccessTest: string | null;
  farcasterCastHash: string | null;
}

interface PublicCampaignPageContext {
  slug: string;
  title: string;
  bodyMarkdown: string;
  snapshotJson: Record<string, unknown> | null;
  updatedAt: Date;
  url: string;
}

interface PublicCampaignNoteContext {
  bodyMarkdown: string;
  snapshotJson: Record<string, unknown> | null;
  createdAt: Date;
}

interface PublicContributorSnapshot {
  source: string;
  castHash: string | null;
  contributors: PublicContributor[];
  createdAt: Date;
}

interface PublicContributor {
  rank?: number;
  fid?: number;
  username: string;
  text: string;
  castHash?: string;
}

interface PublicModelCommandReply {
  text: string;
  referenceCasts?: CastReference[];
}

interface CastReference {
  fid: number;
  hash: string;
}

function shouldIgnoreUntaggedReply(text: string): boolean {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/g, "")
    .replace(/\s+/g, " ");

  if (!normalized) return true;
  if (normalized.includes("?")) return false;
  if (/\b(what|why|how|when|where|who|which|can you|could you|would you|should|please|pls|try|fix|explain|tell me|show me|give me|run|check)\b/i.test(normalized)) {
    return false;
  }

  if (/^(ok|okay|k|cool|nice|great|thanks|thank you|ty|got it|makes sense|agree|agreed|yes|yeah|yep|yup|no worries|all good|fair|noted)(\b|$)/i.test(normalized)) {
    return true;
  }
  if (/\b(you'?re learning|good point|love it|looks good|sounds good)\b/i.test(normalized)) {
    return true;
  }

  return normalized.length < 18;
}

function isShortClarificationReply(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, " ");
  return /^(huh|what|what\?|wait what|wdym|confused|lost|lost me)\??$/i.test(normalized);
}

function readCampaignUrl(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const data = input as Record<string, unknown>;
  const metadata = data.metadata && typeof data.metadata === "object"
    ? data.metadata as Record<string, unknown>
    : {};
  const value = data.campaignUrl || data.lootiCampaignUrl || metadata.campaignUrl || metadata.lootiCampaignUrl;
  return typeof value === "string" && /^https:\/\//.test(value) ? value : undefined;
}

async function getCurrentActiveCampaignUrl(): Promise<string | undefined> {
  const db = getDb();
  const [campaign] = await db
    .select({
      runId: campaignRuns.id,
      metadata: campaignRuns.metadata,
      campaignId: campaignRuns.campaignId,
      castHash: questions.farcasterCastHash,
    })
    .from(campaignRuns)
    .leftJoin(questions, eq(campaignRuns.questionId, questions.id))
    .where(eq(campaignRuns.status, "active"))
    .orderBy(desc(campaignRuns.createdAt))
    .limit(1);

  if (campaign?.runId) {
    const publicUrl = await getCampaignPublicUrl(campaign.runId);
    if (publicUrl && await hasPngOpenGraphImage(publicUrl)) return publicUrl;
  }
  const storedUrl = readCampaignUrl(campaign);
  if (storedUrl) return storedUrl;
  if (campaign?.campaignId) {
    return resolveCampaignUrl(campaign.campaignId, campaign.castHash, campaign);
  }
  return undefined;
}

function isCampaignRelatedText(text: string): boolean {
  return /\b(campaign|looti|quote this cast|reward|rewards|world model|question|answer)\b/i.test(text);
}

async function resolveCampaignUrl(
  campaignId: unknown,
  castHash: unknown,
  input?: unknown,
): Promise<string | undefined> {
  const storedUrl = readCampaignUrl(input);
  if (storedUrl) return storedUrl;

  if (typeof campaignId !== "string" || !campaignId) return undefined;

  const apiKey = process.env.ATLAS_LOOTI_API_KEY;
  const baseUrl = (process.env.ATLAS_LOOTI_API_BASE_URL || "https://looti.club").replace(/\/$/, "");
  if (!apiKey) return undefined;

  try {
    const res = await fetch(`${baseUrl}/api/atlas/campaigns/${encodeURIComponent(campaignId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return undefined;

    const campaign: any = await res.json();
    if (
      typeof castHash === "string" &&
      campaign.targetCastHash &&
      campaign.targetCastHash.toLowerCase() !== castHash.toLowerCase()
    ) {
      return undefined;
    }

    return `${baseUrl}/campaigns/${encodeURIComponent(campaign.campaignId || campaignId)}`;
  } catch {
    return undefined;
  }
}

async function resolvePublicCampaignUrl(
  campaignRunId: unknown,
  campaignId: unknown,
  castHash: unknown,
  input?: unknown,
): Promise<string | undefined> {
  if (typeof campaignRunId === "string" && campaignRunId) {
    const publicUrl = await getCampaignPublicUrl(campaignRunId);
    if (publicUrl) return publicUrl;
  }

  if (typeof campaignId === "string" && campaignId) {
    const db = getDb();
    const [page] = await db
      .select({ slug: campaignPublicPages.slug })
      .from(campaignPublicPages)
      .where(eq(campaignPublicPages.campaignId, campaignId))
      .limit(1);
    if (page?.slug) return buildPublicNotebookEmbedUrl(page.slug);
  }

  return resolveCampaignUrl(campaignId, castHash, input);
}

async function resolveSafeCampaignEmbedUrl(
  campaignRunId: unknown,
  campaignId: unknown,
  castHash: unknown,
  input?: unknown,
): Promise<string | undefined> {
  const publicUrl = await resolvePublicCampaignUrl(campaignRunId, campaignId, castHash, input);
  if (publicUrl && await hasPngOpenGraphImage(publicUrl)) return publicUrl;
  return resolveCampaignUrl(campaignId, castHash, input);
}

async function getCampaignPublicUrl(campaignRunId: string): Promise<string | undefined> {
  const db = getDb();
  const [page] = await db
    .select({ slug: campaignPublicPages.slug })
    .from(campaignPublicPages)
    .where(eq(campaignPublicPages.campaignRunId, campaignRunId))
    .limit(1);
  return page?.slug ? buildPublicNotebookEmbedUrl(page.slug) : undefined;
}

function buildPublicNotebookEmbedUrl(slug: string): string {
  return `https://joinatlas.xyz/campaigns/${encodeURIComponent(slug)}?v=${PUBLIC_NOTEBOOK_EMBED_VERSION}`;
}

async function buildLinkReviewContext(text: string): Promise<string | undefined> {
  const urls = extractHttpUrls(text);
  if (urls.length === 0) return undefined;

  const contexts: string[] = [];
  for (const url of urls.slice(0, 2)) {
    const context = await fetchLinkContext(url);
    contexts.push(context || `url: ${url}\nstatus: unable to fetch bounded context`);
  }
  return contexts.join("\n\n---\n\n").slice(0, LINK_REVIEW_CONTEXT_CHARS);
}

async function fetchMentionThreadContext(
  apiKey: string,
  castHash: string,
  requesterFid: number,
): Promise<string> {
  const conversationContext = await fetchMentionConversationContext(apiKey, castHash, requesterFid);
  if (conversationContext) return conversationContext;

  try {
    const res = await fetch(
      buildNeynarCastUrl(castHash),
      { headers: { "x-api-key": apiKey }, signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) return "";

    const data: any = await res.json();
    const cast = data.cast || {};
    const directReplies = normalizeDirectReplies(cast.direct_replies || []);
    const frames = collectCastFrames(cast, requesterFid, directReplies);
    return frames
      .slice(-8)
      .map((frame) => `${frame.speaker}: ${frame.text}`)
      .join("\n")
      .slice(-MENTION_THREAD_CONTEXT_CHARS);
  } catch {
    return "";
  }
}

async function fetchDirectReplyThreadContext(
  apiKey: string,
  threadHash: string,
  requesterFid: number,
): Promise<string> {
  const conversationContext = await fetchMentionConversationContext(apiKey, threadHash, requesterFid);
  if (conversationContext.length >= 120) return conversationContext;

  const castContext = await fetchMentionThreadContext(apiKey, threadHash, requesterFid);
  return castContext.length > conversationContext.length ? castContext : conversationContext;
}

async function fetchMentionConversationContext(
  apiKey: string,
  castHash: string,
  requesterFid: number,
): Promise<string> {
  try {
    const res = await fetch(
      buildNeynarConversationUrl(castHash),
      { headers: { "x-api-key": apiKey }, signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) return "";

    const data: any = await res.json();
    const root = data.conversation?.cast;
    if (!root) return "";

    const frames = collectConversationFrames(root, requesterFid);
    return frames
      .slice(-10)
      .map((frame) => `${frame.speaker}: ${frame.text}`)
      .join("\n")
      .slice(-MENTION_THREAD_CONTEXT_CHARS);
  } catch {
    return "";
  }
}

function collectCastFrames(
  cast: any,
  requesterFid: number,
  directReplies: ContributorFollowUp[],
): Array<{ speaker: string; text: string; timestamp: string }> {
  const frames: Array<{ speaker: string; text: string; timestamp: string }> = [];
  const threadCasts = Array.isArray(cast?.ancestors) ? cast.ancestors : [];
  for (const item of threadCasts) {
    const author = item.author || {};
    const text = typeof item.text === "string" ? item.text : "";
    if (!text) continue;
    frames.push({
      speaker: author.fid === 12193 ? "Atlas" : author.fid === requesterFid ? "User" : `@${author.username || "unknown"}`,
      text,
      timestamp: item.timestamp || "",
    });
  }

  const currentAuthor = cast?.author || {};
  if (typeof cast?.text === "string" && cast.text) {
    frames.push({
      speaker: currentAuthor.fid === 12193 ? "Atlas" : currentAuthor.fid === requesterFid ? "User" : `@${currentAuthor.username || "unknown"}`,
      text: cast.text,
      timestamp: cast.timestamp || "",
    });
  }

  for (const reply of directReplies) {
    if (reply.authorFid !== 12193 && reply.authorFid !== requesterFid) continue;
    frames.push({
      speaker: reply.authorFid === 12193 ? "Atlas" : "User",
      text: reply.text,
      timestamp: reply.timestamp,
    });
  }

  return frames.sort((a, b) => {
    const aTime = Date.parse(a.timestamp);
    const bTime = Date.parse(b.timestamp);
    if (Number.isFinite(aTime) && Number.isFinite(bTime)) return aTime - bTime;
    return 0;
  });
}

function collectConversationFrames(
  cast: any,
  requesterFid: number,
): Array<{ speaker: string; text: string; timestamp: string }> {
  const frames: Array<{ speaker: string; text: string; timestamp: string }> = [];
  const parents = Array.isArray(cast?.chronological_parent_casts)
    ? cast.chronological_parent_casts
    : [];

  for (const parent of parents) {
    appendConversationCastFrame(frames, parent, requesterFid);
  }
  walkConversationCast(cast, requesterFid, frames);

  const seen = new Set<string>();
  return frames
    .filter((frame) => {
      const key = `${frame.timestamp}:${frame.speaker}:${frame.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => {
      const aTime = Date.parse(a.timestamp);
      const bTime = Date.parse(b.timestamp);
      if (Number.isFinite(aTime) && Number.isFinite(bTime)) return aTime - bTime;
      return 0;
    });
}

function walkConversationCast(
  cast: any,
  requesterFid: number,
  frames: Array<{ speaker: string; text: string; timestamp: string }>,
): void {
  appendConversationCastFrame(frames, cast, requesterFid);
  const replies = Array.isArray(cast?.direct_replies) ? cast.direct_replies : [];
  for (const reply of replies) {
    walkConversationCast(reply, requesterFid, frames);
  }
}

function appendConversationCastFrame(
  frames: Array<{ speaker: string; text: string; timestamp: string }>,
  cast: any,
  requesterFid: number,
): void {
  const author = cast?.author || {};
  const text = typeof cast?.text === "string" ? cast.text : "";
  if (!text) return;
  frames.push({
    speaker: author.fid === 12193 ? "Atlas" : author.fid === requesterFid ? "User" : `@${author.username || "unknown"}`,
    text,
    timestamp: cast.timestamp || "",
  });
}

function extractHttpUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s<>"')]+/gi) || [];
  return [...new Set(matches.map((url) => url.replace(/[.,;:!?]+$/, "")))];
}

async function fetchLinkContext(url: string): Promise<string | undefined> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
  if (isBlockedLinkHost(parsed.hostname)) return undefined;

  if (parsed.hostname === "github.com" || parsed.hostname === "www.github.com") {
    const githubContext = await fetchGithubRepoContext(parsed);
    if (githubContext) return githubContext;
  }

  return fetchGenericLinkContext(parsed);
}

function isBlockedLinkHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "127.0.0.1" ||
    host.endsWith(".local") ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

async function fetchGithubRepoContext(url: URL): Promise<string | undefined> {
  const [, owner, repo] = url.pathname.split("/");
  if (!owner || !repo) return undefined;
  const cleanRepo = repo.replace(/\.git$/i, "");
  const headers = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "atlas-link-review",
  };

  try {
    const [repoRes, readmeRes] = await Promise.all([
      fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(cleanRepo)}`, {
        headers,
        signal: AbortSignal.timeout(8000),
      }),
      fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(cleanRepo)}/readme`, {
        headers: {
          ...headers,
          "Accept": "application/vnd.github.raw",
        },
        signal: AbortSignal.timeout(8000),
      }),
    ]);

    const repoData: any = repoRes.ok ? await repoRes.json() : {};
    const readme = readmeRes.ok ? await readmeRes.text() : "";
    const summary = [
      `url: ${url.toString()}`,
      "type: github repository",
      repoData.full_name ? `repo: ${repoData.full_name}` : undefined,
      repoData.description ? `description: ${repoData.description}` : undefined,
      repoData.language ? `primary language: ${repoData.language}` : undefined,
      typeof repoData.stargazers_count === "number" ? `stars: ${repoData.stargazers_count}` : undefined,
      repoData.default_branch ? `default branch: ${repoData.default_branch}` : undefined,
      readme ? `readme excerpt:\n${trimLinkText(readme, 5200)}` : "readme excerpt: unavailable",
    ].filter(Boolean);
    return summary.join("\n");
  } catch {
    return undefined;
  }
}

async function fetchGenericLinkContext(url: URL): Promise<string | undefined> {
  try {
    const res = await fetch(url.toString(), {
      headers: { "User-Agent": "atlas-link-review" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return `url: ${url.toString()}\nstatus: fetch failed with ${res.status}`;
    const contentType = res.headers.get("content-type") || "";
    const body = await res.text();
    if (/text\/html/i.test(contentType)) {
      const title = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim();
      const description = body.match(/<meta\b(?=[^>]*\bname=["']description["'])(?=[^>]*\bcontent=["']([^"']+)["'])[^>]*>/i)?.[1];
      return [
        `url: ${url.toString()}`,
        "type: html page",
        title ? `title: ${decodeHtmlEntities(title)}` : undefined,
        description ? `description: ${decodeHtmlEntities(description)}` : undefined,
      ].filter(Boolean).join("\n");
    }
    if (/text\/|json|xml|markdown/i.test(contentType)) {
      return `url: ${url.toString()}\ntype: ${contentType}\nexcerpt:\n${trimLinkText(body, 4200)}`;
    }
    return `url: ${url.toString()}\ntype: ${contentType || "unknown"}\nstatus: fetched but not text-readable`;
  } catch {
    return undefined;
  }
}

function trimLinkText(text: string, maxChars: number): string {
  return text
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxChars);
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

async function hasPngOpenGraphImage(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return false;
    const html = await res.text();
    const image = readMetaContent(html, "property", "og:image") || readMetaContent(html, "name", "twitter:image");
    if (!image || !/\.png(?:[?#]|$)/i.test(image)) return false;

    const imageRes = await fetch(image, { method: "HEAD", signal: AbortSignal.timeout(5000) });
    const contentType = imageRes.headers.get("content-type") || "";
    return imageRes.ok && /^image\/png\b/i.test(contentType);
  } catch {
    return false;
  }
}

function readMetaContent(html: string, key: "property" | "name", value: string): string | undefined {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const metaPattern = new RegExp(`<meta\\b(?=[^>]*\\b${key}=["']${escaped}["'])(?=[^>]*\\bcontent=["']([^"']+)["'])[^>]*>`, "i");
  return html.match(metaPattern)?.[1];
}

async function hasRecentAudit(entityType: string, entityId: string, hours: number): Promise<boolean> {
  const db = getDb();
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const rows = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entityType, entityType),
        eq(auditLog.entityId, entityId),
        gte(auditLog.createdAt, since),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function recordProactiveAction(
  entityType: string,
  entityId: string,
  action: string,
  reason: string,
  newValue?: unknown,
): Promise<void> {
  const db = getDb();
  await db.insert(auditLog).values({
    id: createId(),
    entityType,
    entityId,
    action,
    newValue,
    actor: "atlas_agent",
    reason,
  });
}

async function recordContributorSnapshot(
  db: ReturnType<typeof getDb>,
  input: {
    campaignRunId?: unknown;
    campaignId?: unknown;
    castHash: string;
    source: string;
    contributors: ContributorCast[];
  },
): Promise<void> {
  if (input.contributors.length === 0) return;

  const campaignId = typeof input.campaignId === "string" ? input.campaignId : undefined;
  const campaignRunId = typeof input.campaignRunId === "string" ? input.campaignRunId : undefined;

  await db.insert(auditLog).values({
    id: createId(),
    entityType: "campaign_contributor_snapshot",
    entityId: campaignRunId || campaignId || input.castHash,
    action: "refreshed",
    newValue: {
      campaignId,
      castHash: input.castHash,
      source: input.source,
      contributors: input.contributors.slice(0, 10).map((contrib) => ({
        rank: contrib.rank,
        fid: contrib.authorFid,
        username: contrib.authorUsername,
        displayName: contrib.displayName,
        pfpUrl: contrib.pfpUrl,
        followerCount: contrib.followerCount,
        castHash: contrib.castHash,
        lootiScore: contrib.lootiScore,
        compositeScore: contrib.compositeScore,
        conversation: contrib.conversation,
        text: contrib.text,
      })),
    },
    actor: "atlas_agent",
    reason: campaignId,
  });

  for (const contrib of input.contributors.slice(0, 20)) {
    if (!contrib.authorFid || contrib.authorFid === 12193) continue;
    await db.insert(auditLog).values({
      id: createId(),
      entityType: "active_campaign_conversation",
      entityId: `${campaignId || input.castHash}:${contrib.authorFid}`,
      action: "refreshed",
      newValue: {
        campaignRunId,
        campaignId,
        campaignCastHash: input.castHash,
        fid: contrib.authorFid,
        username: contrib.authorUsername,
        displayName: contrib.displayName,
        rank: contrib.rank,
        castHash: contrib.castHash,
        text: contrib.text,
        conversation: contrib.conversation || [],
        source: input.source,
        refreshedAt: new Date().toISOString(),
      },
      actor: "atlas_agent",
      reason: campaignId,
    });
  }
}

async function buildActiveCampaignAwarenessContext(input: { text: string; apiKey?: string }): Promise<string> {
  const db = getDb();
  const handles = extractMentionedHandles(input.text);
  const [campaign] = await db
    .select({
      runId: campaignRuns.id,
      campaignId: campaignRuns.campaignId,
      lifecycleStage: campaignRuns.lifecycleStage,
      status: campaignRuns.status,
      metadata: campaignRuns.metadata,
      questionText: questions.text,
      questionCastHash: questions.farcasterCastHash,
    })
    .from(campaignRuns)
    .leftJoin(questions, eq(campaignRuns.questionId, questions.id))
    .where(eq(campaignRuns.status, "active"))
    .orderBy(desc(campaignRuns.createdAt))
    .limit(1);

  if (!campaign) return "";
  const isCampaignQuestion = /\b(campaign|looti|contributor|answer|answered|question|memory|collect|ellis|kazani)\b/i.test(input.text)
    || handles.size > 0;
  if (!isCampaignQuestion) return "";

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [conversationRows, replyRows, snapshotRows] = await Promise.all([
    db
      .select({ newValue: auditLog.newValue, createdAt: auditLog.createdAt })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, "active_campaign_conversation"),
          gte(auditLog.createdAt, since),
        ),
      )
      .orderBy(desc(auditLog.createdAt))
      .limit(80),
    db
      .select({ entityId: auditLog.entityId, newValue: auditLog.newValue, createdAt: auditLog.createdAt })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, "engagement_reply"),
          eq(auditLog.reason, campaign.campaignId || ""),
          gte(auditLog.createdAt, since),
        ),
      )
      .orderBy(desc(auditLog.createdAt))
      .limit(40),
    db
      .select({ newValue: auditLog.newValue, createdAt: auditLog.createdAt })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, "campaign_contributor_snapshot"),
          eq(auditLog.reason, campaign.campaignId || ""),
          gte(auditLog.createdAt, since),
        ),
      )
      .orderBy(desc(auditLog.createdAt))
      .limit(5),
  ]);

  const byFid = new Map<number, Record<string, unknown>>();
  for (const row of snapshotRows.reverse()) {
    const data = readObject(row.newValue);
    const contributors = Array.isArray(data.contributors) ? data.contributors : [];
    for (const raw of contributors) {
      const contrib = readObject(raw);
      const fid = readNumber(contrib.fid);
      if (!fid) continue;
      byFid.set(fid, { ...byFid.get(fid), ...contrib });
    }
  }
  for (const row of conversationRows.reverse()) {
    const data = readObject(row.newValue);
    if (data.campaignId && data.campaignId !== campaign.campaignId) continue;
    const fid = readNumber(data.fid);
    if (!fid) continue;
    byFid.set(fid, { ...byFid.get(fid), ...data });
  }
  for (const row of replyRows.reverse()) {
    const data = readObject(row.newValue);
    const fid = Number(row.entityId);
    if (!fid || !Number.isFinite(fid)) continue;
    byFid.set(fid, {
      ...byFid.get(fid),
      atlasReplyText: data.text,
      atlasFollowUpHash: data.followUpHash,
      atlasFollowUpText: data.followUpText,
    });
  }

  const contributors = [...byFid.values()]
    .filter((contrib) => {
      if (handles.size === 0) return true;
      const username = typeof contrib.username === "string" ? contrib.username.toLowerCase() : "";
      return handles.has(username);
    })
    .slice(0, handles.size > 0 ? 8 : 5);

  const lines = [
    `Active campaign: ${campaign.questionText || "(question unavailable)"}`,
    `Stage: ${campaign.lifecycleStage || campaign.status || "active"}`,
  ];
  if (campaign.questionCastHash) lines.push(`Campaign cast: ${campaign.questionCastHash}`);
  if (contributors.length > 0) {
    lines.push(handles.size > 0 ? "Matched live contributors:" : "Recent live contributors:");
    for (const contrib of contributors) {
      const username = typeof contrib.username === "string" ? contrib.username : "unknown";
      const rank = typeof contrib.rank === "number" ? ` rank #${contrib.rank}` : "";
      const answer = truncateForPrompt(typeof contrib.text === "string" ? contrib.text : "", 220);
      const conversation = Array.isArray(contrib.conversation)
        ? contrib.conversation.filter((item): item is string => typeof item === "string").slice(-4)
        : [];
      const atlasReply = truncateForPrompt(typeof contrib.atlasReplyText === "string" ? contrib.atlasReplyText : "", 180);
      lines.push(`- @${username}${rank}: "${answer}"`);
      if (atlasReply) lines.push(`  Atlas replied: "${atlasReply}"`);
      for (const item of conversation) lines.push(`  ${truncateForPrompt(item, 220)}`);
    }
  } else {
    lines.push("No matching live contributor rows found yet.");
  }
  return lines.join("\n");
}

function extractMentionedHandles(text: string): Set<string> {
  const handles = new Set<string>();
  const matches = text.matchAll(/@([a-z0-9_][a-z0-9_.-]{0,30})/gi);
  for (const match of matches) {
    const handle = match[1]?.replace(/[.-]+$/g, "").toLowerCase();
    if (handle && handle !== "atlas") handles.add(handle);
  }
  return handles;
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

async function buildContributorMemoryContext(
  db: ReturnType<typeof getDb>,
  fid: number,
  opts: { currentQuestionId?: string; compact?: boolean } = {},
): Promise<string> {
  const details = await buildContributorMemoryDetails(db, fid, opts);
  return details ? `\n${details}` : "";
}

async function buildContributorMemoryDetails(
  db: ReturnType<typeof getDb>,
  fid: number,
  opts: { currentQuestionId?: string; compact?: boolean } = {},
): Promise<string> {
  if (!fid || !Number.isFinite(fid)) return "";

  const [reputationRows, priorAnswers] = await Promise.all([
    db
      .select({
        domain: contributorReputation.domain,
        score: contributorReputation.score,
        sampleSize: contributorReputation.sampleSize,
        confidence: contributorReputation.confidence,
      })
      .from(contributorReputation)
      .where(eq(contributorReputation.fid, fid)),
    db
      .select({
        questionId: answers.questionId,
        questionText: questions.text,
        answerText: answers.text,
        rank: answers.lootiRank,
        castHash: answers.farcasterCastHash,
        answeredAt: answers.createdAt,
        campaignId: campaignRuns.campaignId,
      })
      .from(answers)
      .innerJoin(questions, eq(answers.questionId, questions.id))
      .leftJoin(campaignRuns, eq(campaignRuns.questionId, questions.id))
      .where(eq(answers.responderFid, fid))
      .orderBy(desc(answers.createdAt))
      .limit(6),
  ]);
  const explicitMemories = await db
    .select({ newValue: auditLog.newValue, createdAt: auditLog.createdAt })
    .from(auditLog)
    .where(eq(auditLog.entityType, "contributor_campaign_memory"))
    .orderBy(desc(auditLog.createdAt))
    .limit(80);

  const previousAnswers = priorAnswers.filter((answer) => answer.questionId !== opts.currentQuestionId);
  const contributorMemories = explicitMemories
    .map((row) => row.newValue && typeof row.newValue === "object" ? row.newValue as Record<string, unknown> : null)
    .filter((value): value is Record<string, unknown> => {
      if (!value) return false;
      const memoryFid = typeof value.fid === "number" ? value.fid : Number(value.fid);
      return memoryFid === fid && value.questionId !== opts.currentQuestionId;
    })
    .slice(0, opts.compact ? 3 : 5);
  if (reputationRows.length === 0 && previousAnswers.length === 0 && contributorMemories.length === 0) return "";

  const rep = reputationRows
    .map((row) => `${row.domain}: score ${formatMemoryNumber(row.score)}, samples ${row.sampleSize}, confidence ${formatMemoryNumber(row.confidence)}`)
    .join("; ");

  const history = previousAnswers.slice(0, opts.compact ? 3 : 5).map((answer) => {
    const rank = answer.rank ? `rank #${answer.rank}` : "unranked";
    const question = truncateForPrompt(answer.questionText, opts.compact ? 90 : 150);
    const text = truncateForPrompt(answer.answerText, opts.compact ? 120 : 220);
    return `${rank} on "${question}" -> "${text}"`;
  });

  const lines = ["Contributor memory:"];
  if (rep) lines.push(`Reputation: ${rep}`);
  if (history.length > 0) {
    lines.push("Prior ranked contributions:");
    for (const item of history) lines.push(`- ${item}`);
  }
  if (contributorMemories.length > 0) {
    lines.push("Campaign conversation memory:");
    for (const memory of contributorMemories) {
      const rank = typeof memory.rank === "number" ? `rank #${memory.rank}` : "ranked";
      const text = truncateForPrompt(typeof memory.text === "string" ? memory.text : "", opts.compact ? 160 : 260);
      const followUp = memory.hasFollowUpThread === true ? " incl. follow-up" : "";
      lines.push(`- ${rank}${followUp}: "${text}"`);
    }
  }
  return lines.join("\n");
}

async function buildRequesterMemoryContext(fid: number): Promise<string> {
  const db = getDb();
  const [contributorMemory, kgProfile] = await Promise.all([
    buildContributorMemoryDetails(db, fid, { compact: true }),
    fetchKgContributorProfileContext(fid, { compact: true }),
  ]);
  return [contributorMemory, kgProfile].filter(Boolean).join("\n");
}

async function fetchKgContributorProfileContext(
  fid: number,
  opts: { compact?: boolean } = {},
): Promise<string> {
  const kgUrl = process.env.ATLAS_KG_PIPELINE_URL?.replace(/\/$/, "");
  if (!kgUrl || !fid) return "";

  const headers: Record<string, string> = {};
  if (process.env.ATLAS_KG_PIPELINE_API_KEY) {
    headers["X-API-Key"] = process.env.ATLAS_KG_PIPELINE_API_KEY;
  }

  try {
    const res = await fetch(`${kgUrl}/api/v1/graphs/${fid}`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return "";
    const kg: any = await res.json();
    const profile = kg.graph || kg.graph_data || kg;
    const topics = Array.isArray(profile.topics)
      ? profile.topics.slice(0, opts.compact ? 3 : 5).map((topic: any) => topic.name || topic).filter(Boolean).join(", ")
      : "";
    const projects = Array.isArray(profile.projects)
      ? profile.projects.slice(0, opts.compact ? 2 : 4).map((project: any) => project.name || project).filter(Boolean).join(", ")
      : "";
    return [
      `Contributor profile: ${profile.profile_type || "unknown"}`,
      projects ? `projects: ${projects}` : "",
      topics ? `topics: ${topics}` : "",
    ].filter(Boolean).join("; ");
  } catch {
    return "";
  }
}

function formatMemoryNumber(value: number | null): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "0";
  return value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function truncateForPrompt(value: string | null, maxChars: number): string {
  const text = (value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trim()}…`;
}

function stripCampaignUrls(text: string): string {
  return text
    .replace(/https?:\/\/(?:www\.)?looti\.club\/campaigns\/\S+/gi, "")
    .replace(/https?:\/\/(?:www\.)?joinatlas\.xyz\/campaigns\/\S+/gi, "")
    .replace(/https?:\/\/farcaster\.xyz\/atlas\/0x[a-f0-9]+/gi, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// --- Helpers ---

interface ContributorCast {
  castHash: string;
  authorFid: number;
  authorUsername: string;
  displayName?: string;
  pfpUrl?: string;
  followerCount?: number;
  text: string;
  timestamp: string;
  rank?: number;
  lootiScore?: number;
  compositeScore?: number;
  conversation?: string[];
}

interface ContributorFollowUp {
  castHash: string;
  authorFid: number;
  authorUsername: string;
  text: string;
  timestamp: string;
}

async function getContributorFollowUpAfterLatestAtlasReply(
  apiKey: string,
  castHash: string,
  authorFid: number,
): Promise<ContributorFollowUp | null> {
  // Check if this contributor has replied after Atlas's latest reply.
  // This prevents repeated replies on later ticks for the same follow-up.
  try {
    const res = await fetch(
      buildNeynarCastUrl(castHash),
      { headers: { "x-api-key": apiKey } },
    );
    if (!res.ok) return null;

    const data: any = await res.json();
    const replies = normalizeDirectReplies(data.cast?.direct_replies || []);
    const latestAtlasReply = [...replies].reverse().find((reply) => reply.authorFid === 12193);
    if (!latestAtlasReply) return null;

    return replies.find((reply) =>
      reply.authorFid === authorFid &&
      isAfterReply(reply, latestAtlasReply)
    ) || null;
  } catch {
    return null;
  }
}

async function attachConversationContext(
  apiKey: string,
  contributors: ContributorCast[],
  repliedFids: Set<number>,
  limit: number,
): Promise<ContributorCast[]> {
  const output: ContributorCast[] = [];
  for (const [index, contributor] of contributors.entries()) {
    if (index >= limit || !repliedFids.has(contributor.authorFid)) {
      output.push(contributor);
      continue;
    }

    const conversation = await getContributorThreadConversation(apiKey, contributor.castHash, contributor.authorFid, 4);
    output.push(conversation.length > 0 ? { ...contributor, conversation } : contributor);
  }
  return output;
}

async function getContributorThreadConversation(
  apiKey: string,
  castHash: string,
  authorFid: number,
  limit: number,
): Promise<string[]> {
  try {
    const res = await fetch(
      buildNeynarCastUrl(castHash),
      { headers: { "x-api-key": apiKey } },
    );
    if (!res.ok) return [];

    const data: any = await res.json();
    const replies = normalizeDirectReplies(data.cast?.direct_replies || [])
      .filter((reply) => reply.authorFid === 12193 || reply.authorFid === authorFid)
      .slice(-limit);
    return replies.map((reply) => {
      const speaker = reply.authorFid === 12193 ? "Atlas" : `@${reply.authorUsername}`;
      return `${speaker}: ${reply.text}`;
    });
  } catch {
    return [];
  }
}

function normalizeDirectReplies(replies: any[]): ContributorFollowUp[] {
  return replies
    .map((reply) => ({
      castHash: reply.hash || "",
      authorFid: reply.author?.fid || 0,
      authorUsername: reply.author?.username || "unknown",
      text: reply.text || "",
      timestamp: reply.timestamp || "",
    }))
    .filter((reply) => reply.castHash && reply.authorFid && reply.text)
    .sort((a, b) => {
      const aTime = Date.parse(a.timestamp);
      const bTime = Date.parse(b.timestamp);
      if (Number.isFinite(aTime) && Number.isFinite(bTime)) return aTime - bTime;
      return 0;
    });
}

function isAfterReply(reply: ContributorFollowUp, previousReply: ContributorFollowUp): boolean {
  const replyTime = Date.parse(reply.timestamp);
  const previousTime = Date.parse(previousReply.timestamp);
  if (Number.isFinite(replyTime) && Number.isFinite(previousTime)) return replyTime > previousTime;
  return reply.castHash !== previousReply.castHash;
}

async function fetchRankedContributors(
  lootiBase: string,
  lootiApiKey: string,
  campaignId: string,
  neynarApiKey?: string,
  castHash?: string,
): Promise<ContributorCast[]> {
  if (castHash) {
    const liveContributors = await fetchLootiAlgoContributors(
      lootiBase,
      campaignId,
      castHash,
      12193,
      neynarApiKey,
      10,
    );
    if (liveContributors.length > 0) return liveContributors;
  }

  try {
    // Fetch the top 10 from Looti's ranked reward set.
    // The Atlas/Looti API contract only supports limit=3 or limit=10.
    const res = await fetch(
      `${lootiBase}/api/atlas/campaigns/${encodeURIComponent(campaignId)}/reward-set?limit=10`,
      { headers: { Authorization: `Bearer ${lootiApiKey}` } },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[engage] Looti reward-set fetch failed: ${res.status} ${body.slice(0, 240)}`);
      return [];
    }

    const data: any = await res.json();
    const entries = Array.isArray(data.entries)
      ? data.entries
      : Array.isArray(data.rewardSet)
        ? data.rewardSet
        : [];

    const contributors = entries
      .map((entry: any) => {
        const topQuote = Array.isArray(entry.topQuotes)
          ? entry.topQuotes[0]
          : Array.isArray(entry.top_quotes)
            ? entry.top_quotes[0]
            : undefined;
        return {
          castHash: topQuote?.hash || entry.castHash || entry.cast_hash || "",
          authorFid: entry.fid || entry.authorFid || 0,
          authorUsername: entry.username || entry.authorUsername || "unknown",
          displayName: entry.displayName || entry.display_name || entry.authorDisplayName,
          pfpUrl: entry.pfpUrl || entry.pfp_url || entry.avatarUrl || entry.avatar_url,
          followerCount: entry.followerCount || entry.follower_count,
          text: topQuote?.text || entry.text || entry.content || "",
          timestamp: topQuote?.timestamp || entry.timestamp || "",
          rank: typeof entry.rank === "number" ? entry.rank : undefined,
          lootiScore: typeof topQuote?.lootiScore === "number"
            ? topQuote.lootiScore
            : typeof entry.totalLootiScore === "number"
              ? entry.totalLootiScore
              : undefined,
          compositeScore: typeof topQuote?.compositeScore === "number"
            ? topQuote.compositeScore
            : typeof entry.totalCompositeScore === "number"
              ? entry.totalCompositeScore
              : undefined,
        };
      })
      .filter((c: ContributorCast) => c.castHash && c.authorFid);

    return neynarApiKey ? await enrichContributorsFromNeynar(neynarApiKey, contributors) : contributors;
  } catch (err: any) {
    console.error(`[engage] Looti reward-set fetch error: ${err.message}`);
    return [];
  }
}

async function fetchLootiCampaignStatus(
  lootiBase: string,
  lootiApiKey: string,
  campaignId: string,
): Promise<any | null> {
  try {
    const res = await fetch(
      `${lootiBase.replace(/\/$/, "")}/api/atlas/campaigns/${encodeURIComponent(campaignId)}`,
      { headers: { Authorization: `Bearer ${lootiApiKey}` } },
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function isRewardSetReady(campaign: any): boolean {
  return campaign?.rewardSetReady === true || String(campaign?.status || "").toLowerCase() === "completed";
}

function readLootiExpiresAt(campaign: any): Date | null {
  const value = campaign?.expiresAt;
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 10_000_000_000 ? value : value * 1000;
    return new Date(ms);
  }
  if (typeof value === "string") {
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) return date;
  }
  return null;
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

async function updateCampaignCollectEnd(
  campaignRunId: string,
  collectEndsAt: Date,
  metadataPatch: Record<string, unknown>,
): Promise<void> {
  const db = getDb();
  const run = await db.query.campaignRuns.findFirst({
    where: eq(campaignRuns.id, campaignRunId),
  });
  await db
    .update(campaignRuns)
    .set({
      collectEndsAt,
      metadata: { ...(run?.metadata || {}), ...metadataPatch },
      updatedAt: new Date(),
    })
    .where(eq(campaignRuns.id, campaignRunId));
}

async function fetchNotebookContributors(
  lootiBase: string,
  lootiApiKey: string,
  campaignId: string,
  castHash: string,
  creatorFid: number,
  neynarApiKey: string,
  limit: number,
): Promise<ContributorCast[]> {
  const liveContributors = await fetchLootiAlgoContributors(
    lootiBase,
    campaignId,
    castHash,
    creatorFid,
    neynarApiKey,
    limit,
  );
  if (liveContributors.length > 0) return liveContributors;

  const endpoints = [
    {
      url: `${lootiBase}/api/atlas/campaigns/${encodeURIComponent(campaignId)}/live-quotes?limit=${limit}`,
      auth: true,
      source: "atlas-live-quotes",
    },
    {
      url: `${lootiBase}/api/atlas/campaigns/${encodeURIComponent(campaignId)}/quotes?limit=${limit}`,
      auth: true,
      source: "atlas-quotes",
    },
  ];

  for (const endpoint of endpoints) {
    try {
      const res = await fetch(endpoint.url, {
        headers: endpoint.auth ? { Authorization: `Bearer ${lootiApiKey}` } : undefined,
      });
      if (res.status === 404) continue;
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error(`[engage] Looti notebook corpus fetch failed (${endpoint.source}): ${res.status} ${body.slice(0, 240)}`);
        continue;
      }

      const data: any = await res.json();
      const entries = Array.isArray(data.entries)
        ? data.entries
        : Array.isArray(data.quotes)
          ? data.quotes
          : Array.isArray(data.rewardSet)
            ? data.rewardSet
            : [];

      const contributors = entries
        .map((entry: any, index: number) => {
          const topQuote = Array.isArray(entry.topQuotes)
            ? entry.topQuotes[0]
            : Array.isArray(entry.top_quotes)
              ? entry.top_quotes[0]
              : entry.quote || entry.cast || entry;
          const author = topQuote?.author || entry.author || {};
          return {
            castHash: topQuote?.hash || entry.castHash || entry.cast_hash || entry.quoteHash || "",
            authorFid: author.fid || entry.fid || entry.authorFid || entry.author_fid || topQuote?.authorFid || 0,
            authorUsername: author.username || entry.username || entry.authorUsername || entry.author_username || "unknown",
            displayName: author.display_name || author.displayName || entry.displayName || entry.display_name || entry.authorDisplayName,
            pfpUrl: author.pfp_url || author.pfpUrl || entry.pfpUrl || entry.pfp_url || entry.avatarUrl || entry.avatar_url,
            followerCount: author.follower_count || author.followerCount || entry.followerCount || entry.follower_count,
            text: topQuote?.text || entry.text || entry.content || "",
            timestamp: topQuote?.timestamp || entry.timestamp || "",
            rank: typeof entry.rank === "number" ? entry.rank : index + 1,
            lootiScore: typeof topQuote?.scores?.looti === "number"
              ? topQuote.scores.looti
              : typeof entry.scores?.looti === "number"
                ? entry.scores.looti
                : typeof topQuote?.lootiScore === "number"
                  ? topQuote.lootiScore
                  : typeof entry.lootiScore === "number"
                    ? entry.lootiScore
                    : undefined,
            compositeScore: typeof topQuote?.scores?.composite === "number"
              ? topQuote.scores.composite
              : typeof entry.scores?.composite === "number"
                ? entry.scores.composite
                : typeof topQuote?.compositeScore === "number"
                  ? topQuote.compositeScore
                  : typeof entry.compositeScore === "number"
                    ? entry.compositeScore
                    : undefined,
            isSpam: topQuote?.isSpam === true || entry.isSpam === true,
          };
        })
        .filter((c: ContributorCast & { isSpam?: boolean }) => c.castHash && c.authorFid && c.isSpam !== true)
        .map((c: ContributorCast, index: number) => ({
          ...c,
          rank: typeof c.rank === "number" ? c.rank : index + 1,
        }));

      return await enrichContributorsFromNeynar(neynarApiKey, contributors.slice(0, limit));
    } catch (err: any) {
      console.error(`[engage] Looti notebook corpus fetch error: ${err.message}`);
    }
  }

  return [];
}

async function fetchLootiAlgoContributors(
  lootiBase: string,
  campaignId: string,
  castHash: string,
  creatorFid: number,
  neynarApiKey: string | undefined,
  limit: number,
): Promise<ContributorCast[]> {
  try {
    const url = `${lootiBase}/api/algo-quotes?hash=${encodeURIComponent(castHash)}&creatorFid=${encodeURIComponent(String(creatorFid))}&campaignId=${encodeURIComponent(campaignId)}`;
    const res = await fetch(url, {
      headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[engage] Looti algo-quotes fetch failed: ${res.status} ${body.slice(0, 240)}`);
      return [];
    }

    const data: any = await res.json();
    const entries = Array.isArray(data.quotes) ? data.quotes : [];
    const contributors = entries
      .map((quote: any, index: number) => {
        const author = quote.author || {};
        return {
          castHash: quote.hash || "",
          authorFid: author.fid || quote.authorFid || quote.author_fid || 0,
          authorUsername: author.username || quote.username || "unknown",
          displayName: author.display_name || author.displayName || quote.displayName || quote.display_name,
          pfpUrl: author.pfp_url || author.pfpUrl || quote.pfpUrl || quote.pfp_url,
          followerCount: author.follower_count || author.followerCount,
          text: quote.text || "",
          timestamp: quote.timestamp || "",
          rank: index + 1,
          lootiScore: typeof quote.scores?.looti === "number" ? quote.scores.looti : undefined,
          compositeScore: typeof quote.scores?.composite === "number" ? quote.scores.composite : undefined,
          isSpam: quote.isSpam === true,
        };
      })
      .filter((c: ContributorCast & { isSpam?: boolean }) => c.castHash && c.authorFid && c.isSpam !== true)
      .slice(0, limit)
      .map((c: ContributorCast, index: number) => ({ ...c, rank: index + 1 }));

    return neynarApiKey ? await enrichContributorsFromNeynar(neynarApiKey, contributors) : contributors;
  } catch (err: any) {
    console.error(`[engage] Looti algo-quotes fetch error: ${err.message}`);
    return [];
  }
}

async function enrichContributorsFromNeynar(
  apiKey: string,
  contributors: ContributorCast[],
): Promise<ContributorCast[]> {
  return Promise.all(contributors.map(async (contrib) => {
    try {
      const res = await fetch(
        buildNeynarCastUrl(contrib.castHash),
        { headers: { "x-api-key": apiKey } },
      );
      if (!res.ok) return contrib;
      const data: any = await res.json();
      const cast = data.cast;
      const author = cast?.author || {};
      return {
        ...contrib,
        authorFid: author.fid || contrib.authorFid,
        authorUsername: author.username || contrib.authorUsername,
        displayName: author.display_name || author.displayName || contrib.displayName,
        pfpUrl: author.pfp_url || author.pfpUrl || contrib.pfpUrl,
        followerCount: author.follower_count || author.followerCount || contrib.followerCount,
        text: typeof cast?.text === "string" && cast.text ? cast.text : contrib.text,
        timestamp: cast?.timestamp || contrib.timestamp,
      };
    } catch {
      return contrib;
    }
  }));
}

async function fetchQuoteReplies(
  apiKey: string,
  castHash: string,
): Promise<ContributorCast[]> {
  // Fetch casts that quote this cast via Neynar
  try {
    const res = await fetch(
      buildNeynarCastUrl(castHash),
      { headers: { "x-api-key": apiKey } },
    );
    if (!res.ok) return [];

    const data: any = await res.json();
    const replies: ContributorCast[] = [];

    // Get direct replies
    if (data.cast?.direct_replies) {
      for (const reply of data.cast.direct_replies) {
        replies.push({
          castHash: reply.hash,
          authorFid: reply.author?.fid || 0,
          authorUsername: reply.author?.username || "unknown",
          displayName: reply.author?.display_name || reply.author?.displayName,
          pfpUrl: reply.author?.pfp_url || reply.author?.pfpUrl,
          text: reply.text || "",
          timestamp: reply.timestamp || "",
        });
      }
    }

    return replies;
  } catch {
    return [];
  }
}

function buildNeynarCastUrl(hash: string): string {
  return `https://api.neynar.com/v2/farcaster/cast?identifier=${encodeURIComponent(hash)}&type=hash&viewer_fid=12193`;
}

function buildNeynarConversationUrl(hash: string): string {
  const params = new URLSearchParams({
    identifier: hash,
    type: "hash",
    reply_depth: "3",
    include_chronological_parent_casts: "true",
    viewer_fid: "12193",
    sort_type: "chron",
    limit: "20",
  });
  return `https://api.neynar.com/v2/farcaster/cast/conversation/?${params.toString()}`;
}

async function publishCastHelper(
  apiKey: string,
  signerUuid: string,
  opts: { text: string; parent?: string; quoteHash?: string; embedUrl?: string },
): Promise<string | null> {
  const castBody: Record<string, any> = {
    signer_uuid: signerUuid,
    text: opts.text,
  };

  const embeds: any[] = [];
  if (opts.quoteHash) {
    embeds.push({ cast_id: { fid: 12193, hash: opts.quoteHash } });
  }
  if (opts.embedUrl) {
    embeds.push({ url: opts.embedUrl });
  }
  if (embeds.length > 0) {
    castBody.embeds = embeds;
  }
  if (opts.parent) {
    castBody.parent = opts.parent;
  }

  try {
    const res = await fetch("https://api.neynar.com/v2/farcaster/cast", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify(castBody),
    });

    if (res.ok) {
      const data: any = await res.json();
      return data.cast?.hash || null;
    }
    return null;
  } catch {
    return null;
  }
}

async function replyThread(
  apiKey: string,
  signerUuid: string,
  parentHash: string,
  text: string,
  maxChars: number,
  opts: { referenceCasts?: CastReference[] } = {},
): Promise<string> {
  return replyThreadWithFallback(apiKey, signerUuid, parentHash, text, maxChars, maxChars === 320 ? undefined : 320, opts);
}

async function replyThreadWithFallback(
  apiKey: string,
  signerUuid: string,
  parentHash: string,
  text: string,
  maxChars: number,
  fallbackChars?: number,
  opts: { referenceCasts?: CastReference[] } = {},
): Promise<string> {
  const parts = splitReplyText(text, maxChars);
  let currentParent = parentHash;
  let firstHash = "unknown";
  const remainingReferences = uniqueCastReferences(opts.referenceCasts || []);

  try {
    for (const [index, part] of parts.entries()) {
      const embedCastIds = remainingReferences.splice(0, 2);
      const hash = await replyToCast(apiKey, signerUuid, currentParent, part, { embedCastIds });
      if (index === 0) firstHash = hash;
      currentParent = hash;
      if (index < parts.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1200));
      }
    }
    return firstHash;
  } catch (err: any) {
    if (fallbackChars && /limit|length|text|validation|400/i.test(err?.message || "")) {
      return replyThreadWithFallback(apiKey, signerUuid, parentHash, text, fallbackChars, undefined, opts);
    }
    throw err;
  }
}

function uniqueCastReferences(references: CastReference[]): CastReference[] {
  const seen = new Set<string>();
  const output: CastReference[] = [];
  for (const reference of references) {
    if (!reference.fid || !reference.hash || seen.has(reference.hash)) continue;
    seen.add(reference.hash);
    output.push(reference);
  }
  return output;
}

function splitReplyText(text: string, maxChars: number): string[] {
  const normalized = text.replace(/\r/g, "").trim();
  if (!normalized) return ["i don't have a response for that."];
  if (normalized.length <= maxChars) return [normalized];

  const parts: string[] = [];
  let remaining = normalized;
  while (remaining.length > maxChars && parts.length < 6) {
    const window = remaining.slice(0, maxChars);
    const splitAt = Math.max(
      window.lastIndexOf("\n\n"),
      window.lastIndexOf(". "),
      window.lastIndexOf("? "),
      window.lastIndexOf("! "),
    );
    const boundary = splitAt > Math.floor(maxChars * 0.45) ? splitAt + 1 : maxChars;
    parts.push(remaining.slice(0, boundary).trim());
    remaining = remaining.slice(boundary).trim();
  }
  if (remaining) parts.push(remaining.slice(0, maxChars).trim());
  return parts.filter(Boolean);
}

console.log(`[atlas-server] Listening on port ${PORT}`);
