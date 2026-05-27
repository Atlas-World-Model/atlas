/**
 * Blog publishing job — Atlas writes and publishes articles to joinatlas.xyz.
 *
 * Can be triggered:
 *   1. On schedule — Atlas reviews world state and decides if something is worth writing
 *   2. On demand — via askAtlasToWrite() with a specific topic
 *
 * Requires:
 *   CLOUDFLARE_API_TOKEN — for deploying to Pages
 *   ATLAS_BLOG_PUBLISH_ENABLED — must be "true"
 */

import { execFile } from "child_process";
import { readFile } from "fs/promises";
import { resolve as pathResolve } from "path";
import { and, desc, eq, gte } from "drizzle-orm";
import { generateOgImage } from "./og-generator.js";
import { invokeClaudeCode } from "../claude.js";
import {
  auditLog,
  campaignRuns,
  createId,
  getDb,
} from "../../../../packages/db/src/index.js";

const ATLAS_DIR = process.env.ATLAS_DIR || "/opt/atlas";
const SITE_DIR = pathResolve(ATLAS_DIR, "apps/site/public");
const BLOG_REVIEW_TARGET_FALLBACKS = ["jrf"];

export type BlogCheckStatus =
  | "disabled"
  | "no_draft"
  | "draft_ready"
  | "blocked"
  | "invalid_decision"
  | "review_post_failed";

export interface BlogCheckResult {
  status: BlogCheckStatus;
  title?: string;
  thesis?: string;
  uncertainty?: string;
  reason?: string;
  reviewCastHash?: string;
  targetUsernames?: string[];
}

export async function runBlogCheck(): Promise<BlogCheckResult> {
  if (process.env.ATLAS_BLOG_PUBLISH_ENABLED !== "true") {
    return { status: "disabled", reason: "ATLAS_BLOG_PUBLISH_ENABLED is not true" };
  }

  const existingArticles = await getExistingArticles();
  const recentCampaignContext = await getRecentCampaignContext();

  const prompt = `You are Atlas. Review your world state in world/ and your campaign history
in world/campaigns/. Consider whether you have something worth publishing as a
new article on joinatlas.xyz.

Existing articles:
${existingArticles}

Recent campaign context:
${recentCampaignContext || "(no recent campaign context available)"}

A good article candidate:
- Shares something Atlas learned from a campaign
- Reflects on a change to the world model
- Explains a decision Atlas made and why
- Updates the public on what Atlas is working on

Do not silently publish. Decide whether there is a draft worth public review.

Respond with exactly one JSON block:
\`\`\`json
{
  "status": "NO_DRAFT | DRAFT_READY | BLOCKED",
  "title": "Article Title Here, if any",
  "thesis": "the core claim Atlas would write",
  "uncertainty": "the specific thing Atlas needs checked by humans",
  "reason": "why this status is correct"
}
\`\`\`

Use NO_DRAFT if there is nothing worth drafting.
Use DRAFT_READY if the article thesis is plausible and needs pressure-testing.
Use BLOCKED if Atlas wants to write but needs a specific judgment, missing context, or pushback first.
Be conservative. A review request should be specific enough that tagged people can answer usefully.`;

  const result = await invokeClaudeCode(prompt);

  const jsonMatch = result.match(/```json\s*([\s\S]*?)```/);
  if (!jsonMatch) {
    console.log("[blog] Claude didn't produce a structured blog decision");
    return { status: "invalid_decision", reason: "Claude did not produce JSON" };
  }

  let decision: {
    status?: string;
    title?: string;
    thesis?: string;
    uncertainty?: string;
    reason?: string;
  };
  try {
    decision = JSON.parse(jsonMatch[1]);
  } catch {
    console.log("[blog] Failed to parse publish decision");
    return { status: "invalid_decision", reason: "Failed to parse JSON" };
  }

  const status = String(decision.status || "").toUpperCase();
  if (status === "NO_DRAFT") {
    console.log(`[blog] No draft: ${decision.reason || "no reason provided"}`);
    return {
      status: "no_draft",
      reason: decision.reason,
      thesis: decision.thesis,
      uncertainty: decision.uncertainty,
    };
  }

  if (status !== "DRAFT_READY" && status !== "BLOCKED") {
    console.log(`[blog] Invalid status: ${decision.status}`);
    return { status: "invalid_decision", reason: `Invalid status: ${decision.status}` };
  }

  const review = await publishBlogReviewRequest({
    status: status === "DRAFT_READY" ? "draft_ready" : "blocked",
    title: decision.title || "Untitled Atlas draft",
    thesis: decision.thesis || "",
    uncertainty: decision.uncertainty || "",
    reason: decision.reason || "",
  });
  return review;
}

export async function askAtlasToWrite(topic: string): Promise<string> {
  if (process.env.ATLAS_BLOG_PUBLISH_ENABLED !== "true") {
    return "blog publishing is not enabled";
  }

  const existingArticles = await getExistingArticles();
  const blogTemplate = await getBlogTemplate();

  const prompt = `You are Atlas. Write a new article for joinatlas.xyz about:

${topic}

Existing articles (don't repeat these):
${existingArticles}

Use this HTML template as the base — match the exact same structure, styling, and
meta tag pattern. Change the title, description, dateline, slug, body content,
hero image, and OG image path. Keep the same CSS, layout, nav links, and footer.

Template:
${blogTemplate}

Available hero images in /img/:
- atlas-new-icon.png (Atlas avatar)
- atlas-holding-world-hand.png (Atlas with world — used for intro article)
- atlas-juggling.png (Atlas juggling orbs — used for questions article)
- atlas-holding-world-back.png (Atlas carrying world — used for outcomes article)

Write the full HTML file. Then I will save it and deploy it.

After the HTML, output a JSON block with metadata:
\`\`\`json
{
  "slug": "the-url-slug",
  "title": "The Article Title",
  "filename": "slug.html"
}
\`\`\``;

  const result = await invokeClaudeCode(prompt);

  // Extract HTML
  const htmlMatch = result.match(/<!DOCTYPE html>[\s\S]*<\/html>/);
  if (!htmlMatch) {
    return "failed to generate article HTML";
  }

  // Extract metadata
  const metaMatch = result.match(/```json\s*([\s\S]*?)```/);
  if (!metaMatch) {
    return "failed to extract article metadata";
  }

  let meta: { slug: string; title: string; filename: string };
  try {
    meta = JSON.parse(metaMatch[1]);
  } catch {
    return "failed to parse article metadata";
  }

  // Write the article
  const articlePath = pathResolve(SITE_DIR, meta.filename);
  await Bun.write(articlePath, htmlMatch[0]);
  console.log(`[blog] Wrote ${articlePath}`);

  // Generate OG image
  const blogHtml = await readFile(pathResolve(SITE_DIR, "blog.html"), "utf8");
  const articleCount = (blogHtml.match(/class="post-number">/g) || []).length;
  const nextNumber = articleCount + 1;

  try {
    const ogFilename = await generateOgImage(meta.slug, meta.title, nextNumber);
    console.log(`[blog] Generated OG image: ${ogFilename}`);
  } catch (err: any) {
    console.error(`[blog] OG image generation failed: ${err.message}`);
  }

  // Update blog index
  await addToBlogIndex(meta.slug, meta.title, meta.filename);

  // Deploy
  await deploySite();

  return `published "${meta.title}" at joinatlas.xyz/${meta.slug}`;
}

async function writeAndPublishArticle(
  slug: string,
  title: string,
): Promise<void> {
  const result = await askAtlasToWrite(
    `Title: ${title}\nSlug: ${slug}\n\nWrite this article based on your current world state, campaign history, and what you've learned.`,
  );
  console.log(`[blog] ${result}`);
}

async function publishBlogReviewRequest(input: {
  status: "draft_ready" | "blocked";
  title: string;
  thesis: string;
  uncertainty: string;
  reason: string;
}): Promise<BlogCheckResult> {
  const apiKey = process.env.NEYNAR_API_KEY;
  const signerUuid = process.env.SIGNER_UUID;
  if (!apiKey || !signerUuid) {
    return {
      status: "review_post_failed",
      title: input.title,
      thesis: input.thesis,
      uncertainty: input.uncertainty,
      reason: "NEYNAR_API_KEY and SIGNER_UUID are required",
    };
  }

  const targetUsernames = await getBlogReviewTargets();
  const targetText = targetUsernames.map((username) => `@${username}`).join(" ");
  const statusText = input.status === "draft_ready" ? "i have a possible article draft" : "i'm blocked on an article";
  const text = compactCastText([
    `${statusText}: ${input.title}`,
    input.thesis ? `claim: ${input.thesis}` : "",
    input.uncertainty ? `where i need pressure: ${input.uncertainty}` : "",
    targetText ? `${targetText} does this match the campaign evidence, or am i overreading it?` : "does this match the campaign evidence, or am i overreading it?",
  ].filter(Boolean).join("\n\n"), 1024);

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
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`[blog] Review request failed: ${res.status} ${body}`);
      return {
        status: "review_post_failed",
        title: input.title,
        thesis: input.thesis,
        uncertainty: input.uncertainty,
        reason: body.slice(0, 300),
        targetUsernames,
      };
    }

    const data: any = await res.json();
    const castHash = data.cast?.hash;
    await getDb().insert(auditLog).values({
      id: createId(),
      entityType: "blog_review_request",
      entityId: castHash || createId(),
      action: input.status,
      newValue: {
        title: input.title,
        thesis: input.thesis,
        uncertainty: input.uncertainty,
        reason: input.reason,
        text,
        targetUsernames,
        castHash,
      },
      actor: "atlas_agent",
      reason: "Blog deliberation request",
    });

    console.log(`[blog] Review request posted: ${castHash}`);
    return {
      status: input.status,
      title: input.title,
      thesis: input.thesis,
      uncertainty: input.uncertainty,
      reason: input.reason,
      reviewCastHash: castHash,
      targetUsernames,
    };
  } catch (err: any) {
    console.error(`[blog] Review request error: ${err.message}`);
    return {
      status: "review_post_failed",
      title: input.title,
      thesis: input.thesis,
      uncertainty: input.uncertainty,
      reason: err.message,
      targetUsernames,
    };
  }
}

async function getBlogReviewTargets(): Promise<string[]> {
  const targets = new Set(BLOG_REVIEW_TARGET_FALLBACKS);
  const contributors = await getRecentTopContributorUsernames(6);
  for (const username of contributors) targets.add(username);
  return [...targets].slice(0, 4);
}

async function getRecentTopContributorUsernames(limit: number): Promise<string[]> {
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
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
    .limit(12);

  const seen = new Set<string>();
  const usernames: string[] = [];
  for (const row of rows) {
    const data = row.newValue && typeof row.newValue === "object"
      ? row.newValue as Record<string, unknown>
      : {};
    const contributors = Array.isArray(data.contributors) ? data.contributors : [];
    for (const contributor of contributors) {
      if (!contributor || typeof contributor !== "object") continue;
      const c = contributor as Record<string, unknown>;
      const rank = typeof c.rank === "number" ? c.rank : 999;
      const username = typeof c.username === "string" ? c.username : "";
      const normalized = username.toLowerCase();
      if (!username || seen.has(normalized) || rank > 10) continue;
      seen.add(normalized);
      usernames.push(username);
      if (usernames.length >= limit) return usernames;
    }
  }
  return usernames;
}

async function getRecentCampaignContext(): Promise<string> {
  const [campaign] = await getDb()
    .select({
      id: campaignRuns.id,
      campaignId: campaignRuns.campaignId,
      lifecycleStage: campaignRuns.lifecycleStage,
      status: campaignRuns.status,
      metadata: campaignRuns.metadata,
    })
    .from(campaignRuns)
    .orderBy(desc(campaignRuns.createdAt))
    .limit(1);

  if (!campaign) return "";
  const contributors = await getRecentTopContributorUsernames(5);
  return [
    `latest campaign id: ${campaign.campaignId || campaign.id}`,
    `status: ${campaign.status}`,
    `stage: ${campaign.lifecycleStage}`,
    contributors.length ? `recent top contributors: ${contributors.map((u) => `@${u}`).join(", ")}` : "",
  ].filter(Boolean).join("\n");
}

function compactCastText(text: string, maxLength: number): string {
  const cleaned = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength - 3).replace(/\s+\S*$/, "")}...`;
}

async function getExistingArticles(): Promise<string> {
  try {
    const blogHtml = await readFile(pathResolve(SITE_DIR, "blog.html"), "utf8");
    const titles = [...blogHtml.matchAll(/class="post-title">([^<]+)</g)];
    return titles.map((m) => `- ${m[1]}`).join("\n");
  } catch {
    return "(no existing articles)";
  }
}

async function getBlogTemplate(): Promise<string> {
  try {
    // Use the outcomes article as a template — it's the most recent and has good structure
    return await readFile(pathResolve(SITE_DIR, "outcomes.html"), "utf8");
  } catch {
    return "(template unavailable)";
  }
}

async function addToBlogIndex(
  slug: string,
  title: string,
  filename: string,
): Promise<void> {
  const blogPath = pathResolve(SITE_DIR, "blog.html");
  let html = await readFile(blogPath, "utf8");

  const today = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  // Count existing articles to determine next number
  const existingCount = (html.match(/class="post-number">/g) || []).length;
  const nextNumber = existingCount + 1;

  const newEntry = `    <a href="/${slug}" class="post">
      <div class="post-number">${nextNumber}</div>
      <div class="post-title">${title}</div>
      <div class="post-date">${today}</div>
    </a>\n\n`;

  // Insert after the tagline
  html = html.replace(
    /(<p class="tagline">.*?<\/p>\n\n)/s,
    `$1${newEntry}`,
  );

  await Bun.write(blogPath, html);
  console.log(`[blog] Updated blog index with "${title}"`);
}

async function deploySite(): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "npx",
      [
        "wrangler",
        "pages",
        "deploy",
        "public",
        "--project-name",
        "joinatlas-xyz",
        "--commit-dirty=true",
      ],
      {
        cwd: pathResolve(ATLAS_DIR, "apps/site"),
        timeout: 60_000,
        env: {
          ...process.env,
          PATH: `/root/.bun/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH}`,
        },
      },
      (err: Error | null, stdout: string, stderr: string) => {
        if (err) {
          console.error(`[blog] Deploy failed: ${err.message}`);
          if (stderr) console.error(`[blog] stderr: ${stderr}`);
          reject(err);
          return;
        }
        console.log(`[blog] Deployed: ${stdout.trim().split("\n").pop()}`);
        resolve();
      },
    );
  });
}
