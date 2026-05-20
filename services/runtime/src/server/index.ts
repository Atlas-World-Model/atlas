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

import {
  verifyWebhookSignature,
  isMentioningAtlas,
  extractQuestion,
  replyToCast,
} from "./webhook.js";
import { askAtlas } from "./atlas-brain.js";
import { askAtlasToWrite } from "../jobs/blog-publish.js";
import { runCampaignCreationCheck } from "../jobs/campaign-create.js";
import { getDb, auditLog, createId } from "../../../../packages/db/src/index.js";
import { and, eq } from "drizzle-orm";

const PORT = parseInt(process.env.ATLAS_WEBHOOK_PORT || "3141");
const MAX_JSON_BYTES = 64 * 1024;

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

      // Handle async, respond immediately
      handleBrainRequest(body).catch((err) =>
        console.error(`[brain-api] Error: ${err.message}`),
      );

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

      if (!isMentioningAtlas(payload)) {
        return Response.json({ ok: true, action: "ignored" });
      }

      const question = extractQuestion(payload.data.text);
      const author = payload.data.author;
      const castHash = payload.data.hash;

      console.log(
        `[webhook] @${author.username} (fid:${author.fid}): "${question}"`,
      );

      // Process async — respond 200 immediately
      handleMention(question, author, castHash).catch((err) =>
        console.error(`[webhook] Error handling mention: ${err.message}`),
      );

      return Response.json({ ok: true, action: "processing" });
    }

    return new Response("Not found", { status: 404 });
  },
});

function requireRuntimeSecret(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for this endpoint`);
  }
  return value;
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
    "think",
  ].includes(action);
}

async function handleMention(
  question: string,
  author: { fid: number; username: string; display_name: string },
  castHash: string,
): Promise<void> {
  const apiKey = process.env.NEYNAR_API_KEY;
  const signerUuid = process.env.SIGNER_UUID;
  const replyEnabled = process.env.ATLAS_FARCASTER_REPLY_ENABLED === "true";

  if (!apiKey || !signerUuid || !replyEnabled) {
    console.log("[webhook] Reply not enabled — logging only");
    console.log(`[webhook] Would reply to ${castHash}: processing "${question}"`);
    return;
  }

  // Allowlist gate — only reply to approved FIDs during beta
  const allowedFids = (process.env.ATLAS_REPLY_ALLOWED_FIDS || "")
    .split(",")
    .map((s) => parseInt(s.trim()))
    .filter((n) => !isNaN(n));
  if (allowedFids.length > 0 && !allowedFids.includes(author.fid)) {
    console.log(`[webhook] FID ${author.fid} not in allowlist — skipping reply`);
    return;
  }

  // Check for research/campaign command (operator only)
  const researchMatch = question.match(/^research\s+(.+)/i);
  if (researchMatch && author.fid === 11528) {
    console.log(`[webhook] Research request: "${researchMatch[1]}"`);
    try {
      await replyToCast(apiKey, signerUuid, castHash, "starting research. i'll cast my question shortly.");
      await runCampaignCreationCheck();
    } catch (err: any) {
      console.error(`[webhook] Failed research flow: ${err.message}`);
    }
    return;
  }

  // Check for blog write command (operator only)
  const writeMatch = question.match(/^write\s+(?:about\s+)?(.+)/i);
  if (writeMatch && author.fid === 11528) {
    console.log(`[webhook] Blog write request: "${writeMatch[1]}"`);
    const writeResult = await askAtlasToWrite(writeMatch[1]);
    try {
      await replyToCast(apiKey, signerUuid, castHash, writeResult.slice(0, 280));
    } catch (err: any) {
      console.error(`[webhook] Failed to reply with write result: ${err.message}`);
    }
    return;
  }

  const contextPrompt = `A Farcaster user @${author.username} (${author.display_name}, fid:${author.fid}) mentioned you and said:

"${question}"

Respond concisely (under 280 characters). Be helpful, direct, and on-topic.
If they're asking about Atlas campaigns, world state, or how to participate, answer from your knowledge.
If the question is unclear, ask for clarification.`;

  const result = await askAtlas({ prompt: contextPrompt });

  try {
    const replyHash = await replyToCast(
      apiKey,
      signerUuid,
      castHash,
      result.response,
    );
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

      const round = parseInt(body.round || "1");
      const castHash = body.castHash;
      if (!castHash) break;

      console.log(`[engage] Round ${round} for campaign ${body.campaignId}`);

      // Step 1: Fetch top-ranked contributors from Looti (not raw replies)
      // Only engage with people Looti has ranked — that's the signal boundary
      const lootiApiKey = process.env.ATLAS_LOOTI_API_KEY;
      const lootiBase = process.env.ATLAS_LOOTI_API_BASE_URL || "https://looti.club";
      let contributors: ContributorCast[] = [];

      if (lootiApiKey && body.campaignId) {
        contributors = await fetchRankedContributors(
          lootiBase, lootiApiKey, body.campaignId, apiKey, castHash,
        );
      }
      if (contributors.length === 0) {
        // Fallback: fetch direct replies if Looti hasn't ranked yet
        contributors = await fetchQuoteReplies(apiKey, castHash);
      }
      console.log(`[engage] Found ${contributors.length} ranked contributors`);

      // Step 2: Find who we've already replied to (don't spam)
      const db = getDb();
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

      // Reply to contributors we haven't engaged yet,
      // OR who have replied back since our last reply (conversation mode)
      for (const contrib of contributors) {
        if (contrib.authorFid === 12193) continue; // skip own casts

        if (repliedFids.has(contrib.authorFid)) {
          // We already replied — only re-engage if they replied back
          const theirFollowUp = await hasFollowUpReply(apiKey, contrib.castHash, contrib.authorFid);
          if (!theirFollowUp) continue;
          console.log(`[engage] @${contrib.authorUsername} replied back — continuing conversation`);
        }

        // Build contributor context via kg-pipeline if available
        let contributorContext = "";
        const kgUrl = process.env.ATLAS_KG_PIPELINE_URL;
        if (kgUrl) {
          try {
            const kgRes = await fetch(`${kgUrl}/api/v1/graphs/${contrib.authorFid}`);
            if (kgRes.ok) {
              const kg: any = await kgRes.json();
              const profile = kg.graph_data || kg;
              contributorContext = `\nContributor profile: ${profile.profile_type || "unknown"}, builds: ${(profile.projects || []).map((p: any) => p.name).join(", ") || "unknown"}, expertise: ${(profile.topics || []).slice(0, 5).map((t: any) => t.name).join(", ") || "unknown"}`;
            }
          } catch {
            // KG not available, continue without context
          }
        }

        const replyResult = await askAtlas({
          prompt: `You have an active campaign. A contributor just quoted your question with their answer.

Contributor: @${contrib.authorUsername} (fid:${contrib.authorFid})${contributorContext}
Their answer: "${contrib.text}"

Write a brief reply (under 280 characters). Be specific about what's useful, what you'd push back on, or what follow-up their answer suggests. Reference their actual content. Don't be generic.`,
        });

        if (replyResult.ok && replyResult.response !== "(error)") {
          await publishCastHelper(apiKey, signerUuid, {
            text: replyResult.response.slice(0, 280),
            parent: contrib.castHash,
          });
          console.log(`[engage] Replied to @${contrib.authorUsername}`);

          // Record so we don't reply again
          await db.insert(auditLog).values({
            id: createId(),
            entityType: "engagement_reply",
            entityId: String(contrib.authorFid),
            action: "replied",
            newValue: { username: contrib.authorUsername, castHash: contrib.castHash },
            actor: "atlas_agent",
            reason: body.campaignId,
          });

          // Small delay between replies to avoid rate limits
          await new Promise((r) => setTimeout(r, 2000));
        }
      }

      // Step 3: Quote own cast with a new angle
      const quoteResult = await askAtlas({
        prompt: `You have an active campaign (round ${round}). Your question cast: ${castHash}

${contributors.length > 0 ? `So far ${contributors.length} people have responded. Some answers: ${contributors.slice(0, 3).map((c) => `@${c.authorUsername}: "${c.text.slice(0, 100)}"`).join("; ")}` : "No responses yet."}

Quote your own cast with a new angle — add context, share a thought that came up, refine what you're looking for, or react to what you've seen so far. This draws attention to the campaign.

Write just the cast text (under 280 characters). Be genuine, not promotional.`,
      });

      if (quoteResult.ok && quoteResult.response !== "(error)") {
        await publishCastHelper(apiKey, signerUuid, {
          text: quoteResult.response.slice(0, 280),
          quoteHash: castHash,
        });
        console.log(`[engage] Quoted own cast`);
      }

      break;
    }

    case "synthesize": {
      if (!apiKey || !signerUuid) break;

      // Fetch the ranked contributors for this campaign
      const lootiKey = process.env.ATLAS_LOOTI_API_KEY;
      const lootiUrl = process.env.ATLAS_LOOTI_API_BASE_URL || "https://looti.club";
      let topContributors: ContributorCast[] = [];

      if (lootiKey && body.campaignId) {
        topContributors = await fetchRankedContributors(
          lootiUrl, lootiKey, body.campaignId, apiKey, body.castHash || "",
        );
      }

      const contributorSummary = topContributors.length > 0
        ? topContributors.slice(0, 10).map((c, i) =>
            `${i + 1}. @${c.authorUsername}: "${c.text.slice(0, 150)}"`
          ).join("\n")
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

      // Parse and publish the attribution cast
      if (result.ok) {
        const castMatch = result.response.match(/CAST:\s*([\s\S]+?)$/);
        if (castMatch) {
          const castText = castMatch[1].trim().slice(0, 1024);
          const hash = await publishCastHelper(apiKey, signerUuid, { text: castText });
          if (hash) {
            console.log(`[brain-api] Attribution cast published: ${hash}`);
          }
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

// --- Helpers ---

interface ContributorCast {
  castHash: string;
  authorFid: number;
  authorUsername: string;
  text: string;
  timestamp: string;
}

async function hasFollowUpReply(
  apiKey: string,
  castHash: string,
  authorFid: number,
): Promise<boolean> {
  // Check if this contributor has replied in the thread after Atlas's reply
  try {
    const res = await fetch(
      `https://api.neynar.com/v2/farcaster/cast/${castHash}?type=hash&viewer_fid=12193`,
      { headers: { "x-api-key": apiKey } },
    );
    if (!res.ok) return false;

    const data: any = await res.json();
    const replies = data.cast?.direct_replies || [];

    // Look for: Atlas replied, then the contributor replied after Atlas
    let atlasReplied = false;
    for (const reply of replies) {
      if (reply.author?.fid === 12193) {
        atlasReplied = true;
      } else if (atlasReplied && reply.author?.fid === authorFid) {
        return true; // contributor replied after Atlas
      }
    }
    return false;
  } catch {
    return false;
  }
}

async function fetchRankedContributors(
  lootiBase: string,
  lootiApiKey: string,
  campaignId: string,
  neynarApiKey: string,
  castHash: string,
): Promise<ContributorCast[]> {
  try {
    // Fetch top 20 from Looti's ranked reward set
    const res = await fetch(
      `${lootiBase}/api/atlas/campaigns/${campaignId}/reward-set?limit=20`,
      { headers: { Authorization: `Bearer ${lootiApiKey}` } },
    );
    if (!res.ok) return [];

    const data: any = await res.json();
    const entries = data.entries || data.rewardSet || [];

    return entries.map((e: any) => ({
      castHash: e.castHash || e.cast_hash || "",
      authorFid: e.fid || e.authorFid || 0,
      authorUsername: e.username || e.authorUsername || "unknown",
      text: e.text || e.content || "",
      timestamp: e.timestamp || "",
    })).filter((c: ContributorCast) => c.castHash && c.authorFid);
  } catch {
    return [];
  }
}

async function fetchQuoteReplies(
  apiKey: string,
  castHash: string,
): Promise<ContributorCast[]> {
  // Fetch casts that quote this cast via Neynar
  try {
    const res = await fetch(
      `https://api.neynar.com/v2/farcaster/cast/${castHash}?type=hash&viewer_fid=12193`,
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

async function publishCastHelper(
  apiKey: string,
  signerUuid: string,
  opts: { text: string; parent?: string; quoteHash?: string },
): Promise<string | null> {
  const castBody: Record<string, any> = {
    signer_uuid: signerUuid,
    text: opts.text,
  };

  if (opts.parent) {
    castBody.parent = opts.parent;
  } else if (opts.quoteHash) {
    castBody.embeds = [{ cast_id: { fid: 12193, hash: opts.quoteHash } }];
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

console.log(`[atlas-server] Listening on port ${PORT}`);
