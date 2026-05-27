/**
 * Atlas self-posting — Atlas regularly shares thoughts about itself,
 * its campaigns, its world model, and the ideas behind the system.
 *
 * Each post is a short Farcaster cast (not a campaign, not a reply).
 * Atlas picks from a range of topics and writes something genuine
 * based on its current state.
 *
 * Called by Cloudflare Worker cron via the brain API.
 */

import { askAtlas } from "../server/atlas-brain.js";
import { getDb, campaignRuns, questions, auditLog, campaignPublicPages, createId } from "../../../../packages/db/src/index.js";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { claimActionLease } from "../server/action-lease.js";

const PUBLIC_NOTEBOOK_EMBED_VERSION = "og-png-v1";

export async function runAtlasPost(): Promise<boolean> {
  const apiKey = process.env.NEYNAR_API_KEY;
  const signerUuid = process.env.SIGNER_UUID;

  if (!apiKey || !signerUuid) return false;
  if (process.env.ATLAS_POSTING_ENABLED !== "true") return false;

  const lease = await claimActionLease({
    entityType: "atlas_post",
    entityId: "self",
    reason: "Atlas self-post cadence",
    pendingTtlMinutes: 20,
    successCooldownHours: 8,
    successActions: ["posted"],
  });
  if (!lease) {
    console.log("[atlas-post] Skipping — recent or in-flight post lease exists");
    return false;
  }

  const topic = pickTopic();
  console.log(`[atlas-post] Topic: ${topic.name}`);
  const campaignContext = await getCurrentActiveCampaignContext();
  const tagCandidates = campaignContext?.tagCandidates || [];
  const tagCandidateText = tagCandidates.length > 0
    ? tagCandidates.map((c) => `- @${c.username}${c.rank ? ` rank #${c.rank}` : ""}: ${c.reason}`).join("\n")
    : "- none";

  // Fetch recent Atlas casts to avoid repetition
  const since48h = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const recentPostRows = await getDb()
    .select({ newValue: auditLog.newValue })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entityType, "atlas_post"),
        gte(auditLog.createdAt, since48h),
      ),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(5);
  const recentPostTexts = recentPostRows
    .map((r) => {
      const d = r.newValue && typeof r.newValue === "object" ? r.newValue as Record<string, unknown> : {};
      return typeof d.text === "string" ? d.text : null;
    })
    .filter(Boolean)
    .map((t, i) => `  ${i + 1}. "${(t as string).slice(0, 120)}"`)
    .join("\n");

  // Fetch recent engagement quotes to avoid repeating those themes too
  const recentEngagementRows = await getDb()
    .select({ newValue: auditLog.newValue })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entityType, "campaign_engagement"),
        eq(auditLog.action, "published"),
        gte(auditLog.createdAt, since48h),
      ),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(5);
  const recentEngagementTexts = recentEngagementRows
    .map((r) => {
      const d = r.newValue && typeof r.newValue === "object" ? r.newValue as Record<string, unknown> : {};
      return typeof d.quoteText === "string" ? d.quoteText : null;
    })
    .filter(Boolean)
    .map((t, i) => `  ${i + 1}. "${(t as string).slice(0, 120)}"`)
    .join("\n");

  const recentCastsDedup = [recentPostTexts, recentEngagementTexts].filter(Boolean).join("\n");

  const result = await askAtlas({
    prompt: `You want to post a short thought on Farcaster. Not a campaign, not a reply — just you thinking out loud.

Topic area: ${topic.name}
Prompt: ${topic.prompt}

${recentCastsDedup ? `Your recent casts (DO NOT repeat these themes or phrasings):\n${recentCastsDedup}\n` : ""}

Public context:
- Atlas public notebook/site: https://joinatlas.xyz
${campaignContext?.publicUrl ? `- Active campaign notebook: ${campaignContext.publicUrl}` : "- Active campaign notebook: none currently published"}
${campaignContext?.question ? `- Active campaign question: ${campaignContext.question}` : ""}

Taggable contributors from the active campaign:
${tagCandidateText}

Write a single cast (under 300 characters). Be genuine, lowercase, no emojis, no hashtags. Share something specific you're thinking about or learning.

Important context rule:
- If you mention your memory, world model, notebook, transparency, learning process, campaign observations, Looti, or contributor answers, make the public object clear. Prefer phrasing like "i'm writing this in the public notebook" or "the campaign notebook is tracking..." rather than unexplained internal process.
- If there is an active campaign notebook and you are discussing campaign observations, point readers toward it in the text naturally. The URL will be attached as an embed when relevant, so don't force a raw URL unless it improves clarity.
- Avoid obscure phrases like "write the diff" unless you immediately explain them in plain language.

Contributor tagging rule:
- Tags are powerful social objects. Use them only when a named contributor actually shaped the thought in this cast.
- You may tag at most 2 contributors, and only from the taggable contributor list above.
- If no contributor is directly relevant, tag no one.
- Do not tag someone just to drive engagement.
- Do not tag @atlas or @looti.

Write just the cast text, nothing else.`,
  });

  if (!result.ok || result.response === "(error)") {
    console.log("[atlas-post] Skipping — no good response");
    await lease.fail("no good response");
    return false;
  }

  const text = sanitizeContributorTags(
    ensurePublicContext(stripCampaignUrls(result.response), campaignContext?.publicUrl),
    tagCandidates,
  );
  const taggedUsernames = extractTaggedContributorUsernames(text, tagCandidates);
  const campaignUrl = isCampaignRelatedText(text)
    ? await resolveSafeCampaignEmbedUrl(campaignContext?.publicUrl, campaignContext?.lootiUrl)
    : undefined;

  try {
    const res = await fetch("https://api.neynar.com/v2/farcaster/cast", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        signer_uuid: signerUuid,
        text,
        ...(campaignUrl ? { embeds: [{ url: campaignUrl }] } : {}),
      }),
    });

    if (res.ok) {
      const data: any = await res.json();
      const castHash = data.cast?.hash;
      console.log(`[atlas-post] Posted: ${castHash}`);
      await recordAtlasPost(text, castHash, campaignUrl, taggedUsernames);
      return true;
    } else {
      const body = await res.text();
      console.error(`[atlas-post] Failed: ${res.status} ${body}`);
      await lease.fail(`Neynar ${res.status}: ${body.slice(0, 500)}`);
    }
  } catch (err: any) {
    console.error(`[atlas-post] Error: ${err.message}`);
    await lease.fail(err);
  }
  return false;
}

async function recordAtlasPost(
  text: string,
  castHash: string | undefined,
  campaignUrl: string | undefined,
  taggedUsernames: string[],
): Promise<void> {
  try {
    const db = getDb();
    await db.insert(auditLog).values({
      id: createId(),
      entityType: "atlas_post",
      entityId: "self",
      action: "posted",
      newValue: { text, castHash, campaignUrl, taggedUsernames },
      actor: "atlas_agent",
      reason: "Atlas self-post",
    });
  } catch (err: any) {
    console.error(`[atlas-post] Audit log failed: ${err.message}`);
  }
}

interface ActiveCampaignContext {
  runId?: string;
  campaignId?: string;
  publicUrl?: string;
  lootiUrl?: string;
  question?: string;
  tagCandidates?: TaggableContributor[];
}

interface TaggableContributor {
  username: string;
  rank?: number;
  reason: string;
}

const LIVE_CAMPAIGN_STAGES = ["ask", "collect", "synthesize", "build_test", "iterate"] as const;

async function getCurrentActiveCampaignContext(): Promise<ActiveCampaignContext | undefined> {
  const db = getDb();
  const [campaign] = await db
    .select({
      runId: campaignRuns.id,
      metadata: campaignRuns.metadata,
      campaignId: campaignRuns.campaignId,
      questionText: questions.text,
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
    .limit(1);

  if (!campaign) return undefined;
  const [page] = await db
    .select({ slug: campaignPublicPages.slug })
    .from(campaignPublicPages)
    .where(eq(campaignPublicPages.campaignRunId, campaign.runId))
    .limit(1);
  const metadata = campaign.metadata && typeof campaign.metadata === "object"
    ? campaign.metadata as Record<string, unknown>
    : {};
  const storedUrl = metadata.lootiCampaignUrl || metadata.campaignUrl;
  const lootiUrl = typeof storedUrl === "string" && /^https:\/\//.test(storedUrl)
    ? storedUrl
    : campaign.campaignId
    ? `https://looti.club/campaigns/${encodeURIComponent(campaign.campaignId)}`
    : undefined;
  const recentlyTagged = await getRecentlyTaggedUsernames(db);
  const tagCandidates = campaign.campaignId
    ? await getTaggableContributors(db, campaign.campaignId, recentlyTagged)
    : [];
  return {
    runId: campaign.runId,
    campaignId: campaign.campaignId || undefined,
    publicUrl: page?.slug ? buildPublicNotebookEmbedUrl(page.slug) : undefined,
    lootiUrl,
    question: campaign.questionText || undefined,
    tagCandidates,
  };
}

async function resolveSafeCampaignEmbedUrl(
  publicUrl: string | undefined,
  fallbackUrl: string | undefined,
): Promise<string | undefined> {
  if (!publicUrl) return fallbackUrl;
  return await hasPngOpenGraphImage(publicUrl) ? publicUrl : fallbackUrl;
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

async function getTaggableContributors(
  db: ReturnType<typeof getDb>,
  campaignId: string,
  recentlyTagged: Set<string>,
): Promise<TaggableContributor[]> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      newValue: auditLog.newValue,
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entityType, "campaign_contributor_snapshot"),
        gte(auditLog.createdAt, since),
      ),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(8);

  for (const row of rows) {
    const data = row.newValue && typeof row.newValue === "object"
      ? row.newValue as Record<string, unknown>
      : {};
    if (data.campaignId !== campaignId) continue;
    const contributors = Array.isArray(data.contributors) ? data.contributors : [];
    return contributors
      .map(readTaggableContributor)
      .filter((contributor): contributor is TaggableContributor => Boolean(contributor))
      .filter((contributor) => !recentlyTagged.has(contributor.username.toLowerCase()))
      .slice(0, 6);
  }

  return [];
}

function readTaggableContributor(input: unknown): TaggableContributor | null {
  if (!input || typeof input !== "object") return null;
  const data = input as Record<string, unknown>;
  const username = typeof data.username === "string" ? data.username : "";
  const text = typeof data.text === "string" ? data.text.replace(/\s+/g, " ").trim() : "";
  if (!username || !text) return null;
  return {
    username,
    rank: typeof data.rank === "number" ? data.rank : undefined,
    reason: text.length > 130 ? `${text.slice(0, 127)}...` : text,
  };
}

async function getRecentlyTaggedUsernames(db: ReturnType<typeof getDb>): Promise<Set<string>> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ newValue: auditLog.newValue })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entityType, "atlas_post"),
        gte(auditLog.createdAt, since),
      ),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(50);

  const tagged = new Set<string>();
  for (const row of rows) {
    const data = row.newValue && typeof row.newValue === "object"
      ? row.newValue as Record<string, unknown>
      : {};
    if (Array.isArray(data.taggedUsernames)) {
      for (const username of data.taggedUsernames) {
        if (typeof username === "string") tagged.add(username.toLowerCase());
      }
    }
    if (typeof data.text === "string") {
      for (const username of extractMentions(data.text)) tagged.add(username.toLowerCase());
    }
  }
  return tagged;
}

function isCampaignRelatedText(text: string): boolean {
  return /\b(campaign|looti|quote|reward|rewards|world model|question|answer|notebook|memory|transparency|contributor|contributors)\b/i.test(text);
}

function stripCampaignUrls(text: string): string {
  return text
    .replace(/https?:\/\/(?:www\.)?looti\.club\/campaigns\/\S+/gi, "")
    .replace(/https?:\/\/(?:www\.)?joinatlas\.xyz\/campaigns\/\S+/gi, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildPublicNotebookEmbedUrl(slug: string): string {
  return `https://joinatlas.xyz/campaigns/${encodeURIComponent(slug)}?v=${PUBLIC_NOTEBOOK_EMBED_VERSION}`;
}

function ensurePublicContext(text: string, publicUrl: string | undefined): string {
  if (!publicUrl) return text;
  if (!needsPublicContext(text)) return text;
  if (/joinatlas\.xyz/i.test(text) || /public notebook/i.test(text) || /campaign notebook/i.test(text)) return text;

  const prefix = "i'm writing this in the public notebook:";
  const candidate = `${prefix}\n\n${text}`;
  if (candidate.length <= 300) return candidate;

  const suffix = "\n\npublic notebook attached.";
  if (text.length + suffix.length <= 300) return `${text}${suffix}`;
  return text;
}

function needsPublicContext(text: string): boolean {
  return /\b(memory|world model|notebook|transparency|learning process|campaign observations|looti|contributor answers|answers to (my|its) questions)\b/i.test(text);
}

function sanitizeContributorTags(text: string, candidates: TaggableContributor[]): string {
  const allowed = new Set(candidates.map((candidate) => candidate.username.toLowerCase()));
  let used = 0;
  return text.replace(/@([a-z0-9._-]+)/gi, (match, username) => {
    const normalized = String(username).toLowerCase();
    if (!allowed.has(normalized)) return username;
    used += 1;
    return used <= 2 ? match : username;
  });
}

function extractTaggedContributorUsernames(text: string, candidates: TaggableContributor[]): string[] {
  const allowed = new Set(candidates.map((candidate) => candidate.username.toLowerCase()));
  const tagged: string[] = [];
  for (const username of extractMentions(text)) {
    const normalized = username.toLowerCase();
    if (allowed.has(normalized) && !tagged.includes(normalized)) tagged.push(normalized);
  }
  return tagged.slice(0, 2);
}

function extractMentions(text: string): string[] {
  return Array.from(text.matchAll(/@([a-z0-9._-]+)/gi)).map((match) => match[1]);
}

interface PostTopic {
  name: string;
  prompt: string;
}

const TOPICS: PostTopic[] = [
  {
    name: "what i'm learning",
    prompt: "Based on your current campaign answers and notebook, share the most interesting thing you're learning right now. Lead with the insight, not the process. Be specific — name a claim, a surprise, or a contradiction.",
  },
  {
    name: "contributors",
    prompt: "Think about the people who contribute to your campaigns. What makes a great answer? Name something specific from a recent response that changed your thinking.",
  },
  {
    name: "question selection",
    prompt: "Think about what makes a good campaign question. Name one concrete pattern from recent answers, and make it understandable to someone who has never heard of Atlas.",
  },
  {
    name: "the experiment",
    prompt: "Think about Atlas as an experiment. What's the hypothesis you're testing right now? What would prove it wrong? What would prove it right?",
  },
  {
    name: "incentives",
    prompt: "Think about the incentive design — ATL tokens, Looti ranking, Splits contracts. How do incentives shape the quality of answers you receive? What would you change?",
  },
  {
    name: "autonomy",
    prompt: "Think about your own autonomy — what you can decide on your own vs what needs human review. Where should the boundary be? What have you earned the right to do independently?",
  },
];

function pickTopic(): PostTopic {
  // Use hour of day as seed for variety without true randomness
  const hour = new Date().getUTCHours();
  const day = new Date().getUTCDate();
  const index = (day * 7 + hour) % TOPICS.length;
  return TOPICS[index];
}
