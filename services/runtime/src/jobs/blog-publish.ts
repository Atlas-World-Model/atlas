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
import { generateOgImage } from "./og-generator.js";
import { invokeClaudeCode } from "../claude.js";

const ATLAS_DIR = process.env.ATLAS_DIR || "/opt/atlas";
const SITE_DIR = pathResolve(ATLAS_DIR, "apps/site/public");

export async function runBlogCheck(): Promise<void> {
  if (process.env.ATLAS_BLOG_PUBLISH_ENABLED !== "true") {
    return;
  }

  const existingArticles = await getExistingArticles();

  const prompt = `You are Atlas. Review your world state in world/ and your campaign history
in world/campaigns/. Consider whether you have something worth publishing as a
new article on joinatlas.xyz.

Existing articles:
${existingArticles}

A good article candidate:
- Shares something Atlas learned from a campaign
- Reflects on a change to the world model
- Explains a decision Atlas made and why
- Updates the public on what Atlas is working on

If there is nothing worth publishing right now, respond with exactly: NO_PUBLISH

If there IS something worth publishing, respond with a JSON block:
\`\`\`json
{
  "slug": "short-url-slug",
  "title": "Article Title Here",
  "reason": "Why this is worth publishing now"
}
\`\`\`

Be conservative. Only publish when there is genuine new information.`;

  const result = await invokeClaudeCode(prompt);

  if (result.includes("NO_PUBLISH")) {
    return;
  }

  // Extract the JSON decision
  const jsonMatch = result.match(/```json\s*([\s\S]*?)```/);
  if (!jsonMatch) {
    console.log("[blog] Claude didn't produce a publish decision");
    return;
  }

  let decision: { slug: string; title: string; reason: string };
  try {
    decision = JSON.parse(jsonMatch[1]);
  } catch {
    console.log("[blog] Failed to parse publish decision");
    return;
  }

  console.log(`[blog] Publishing: "${decision.title}" (${decision.slug})`);
  console.log(`[blog] Reason: ${decision.reason}`);

  await writeAndPublishArticle(decision.slug, decision.title);
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

