/**
 * Campaign notebook publishing.
 *
 * Atlas stores durable Markdown notes and structured snapshots in Postgres.
 * The static site renderer turns those records into public campaign pages.
 */

import { execFile } from "child_process";
import { mkdir, readdir, readFile, unlink, writeFile } from "fs/promises";
import { resolve as pathResolve } from "path";
import { and, asc, desc, eq, gte, ne } from "drizzle-orm";
import {
  auditLog,
  campaignPublicEvents,
  campaignPublicPages,
  campaignRuns,
  createId,
  getDb,
  questions,
} from "../../../../packages/db/src/index.js";
import { askAtlas } from "../server/atlas-brain.js";

const ATLAS_DIR = process.env.ATLAS_DIR || "/opt/atlas";
const SITE_DIR = pathResolve(ATLAS_DIR, "apps/site/public");
const NOTE_COOLDOWN_MINUTES = 90;
const CAMPAIGN_OG_VERSION = "v10";
const DEFAULT_OG_IMAGE = "https://joinatlas.xyz/img/og.png";
const NOTEBOOK_MANIFEST_SECTION_LIMIT = 6;

export interface NotebookContributor {
  castHash: string;
  authorFid: number;
  authorUsername: string;
  displayName?: string;
  pfpUrl?: string;
  followerCount?: number;
  text: string;
  timestamp?: string;
  rank?: number;
  lootiScore?: number;
  compositeScore?: number;
  conversation?: string[];
}

interface CampaignNotebookInput {
  campaignRunId?: string;
  campaignId?: string;
  castHash: string;
  source: string;
  contributors: NotebookContributor[];
  trigger: "engagement_tick" | "synthesis" | "manual";
}

export async function refreshCampaignNotebook(input: CampaignNotebookInput): Promise<void> {
  if (!input.campaignRunId && !input.campaignId) return;

  const db = getDb();
  const campaign = await loadCampaign(input);
  if (!campaign) return;

  const snapshot = buildSnapshot(campaign, input);
  const noteMarkdown = await maybeWriteAtlasNote(campaign, snapshot, input);

  await db.insert(campaignPublicEvents).values({
    id: createId(),
    campaignRunId: campaign.campaignRunId,
    campaignId: campaign.campaignId,
    eventType: "snapshot",
    source: input.source,
    bodyMarkdown: "",
    snapshotJson: snapshot,
  });

  if (noteMarkdown) {
    await db.insert(campaignPublicEvents).values({
      id: createId(),
      campaignRunId: campaign.campaignRunId,
      campaignId: campaign.campaignId,
      eventType: "atlas_note",
      source: "atlas",
      bodyMarkdown: noteMarkdown,
      snapshotJson: snapshot,
    });
  }

  await upsertCampaignPage(campaign, snapshot);
  await renderCampaignPages();
  await maybeDeploySite();
}

async function loadCampaign(input: CampaignNotebookInput) {
  const db = getDb();
  const filters = input.campaignRunId
    ? eq(campaignRuns.id, input.campaignRunId)
    : eq(campaignRuns.campaignId, input.campaignId!);

  const [row] = await db
    .select({
      campaignRunId: campaignRuns.id,
      campaignId: campaignRuns.campaignId,
      status: campaignRuns.status,
      lifecycleStage: campaignRuns.lifecycleStage,
      expectedAction: campaignRuns.expectedAction,
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
    .where(filters)
    .orderBy(desc(campaignRuns.createdAt))
    .limit(1);

  if (!row.campaignId) return null;
  return {
    ...row,
    campaignId: row.campaignId,
    title: titleFromQuestion(row.questionText || row.campaignId),
    slug: slugFromCampaign(row.campaignId, row.questionText),
  };
}

function buildSnapshot(
  campaign: NonNullable<Awaited<ReturnType<typeof loadCampaign>>>,
  input: CampaignNotebookInput,
) {
  return {
    campaignRunId: campaign.campaignRunId,
    campaignId: campaign.campaignId,
    title: campaign.title,
    slug: campaign.slug,
    stage: campaign.lifecycleStage,
    status: campaign.status,
    expectedAction: campaign.expectedAction,
    prompt: campaign.questionText,
    problem: campaign.questionProblem,
    currentBelief: campaign.questionBelief,
    successTest: campaign.questionSuccessTest,
    targetCastHash: campaign.farcasterCastHash || input.castHash,
    metadata: campaign.metadata || {},
    source: input.source,
    trigger: input.trigger,
    observedAt: new Date().toISOString(),
    contributorCorpusSize: input.contributors.length,
    displayLimit: 10,
    noteCorpusLimit: 30,
    contributors: input.contributors.slice(0, 30).map((contrib) => ({
      rank: contrib.rank,
      fid: contrib.authorFid,
      username: contrib.authorUsername,
      displayName: contrib.displayName,
      pfpUrl: contrib.pfpUrl,
      followerCount: contrib.followerCount,
      castHash: contrib.castHash,
      text: contrib.text,
      timestamp: contrib.timestamp,
      lootiScore: contrib.lootiScore,
      compositeScore: contrib.compositeScore,
      conversation: contrib.conversation,
    })),
  };
}

async function maybeWriteAtlasNote(
  campaign: NonNullable<Awaited<ReturnType<typeof loadCampaign>>>,
  snapshot: Record<string, unknown>,
  input: CampaignNotebookInput,
): Promise<string | null> {
  if (input.contributors.length === 0) return null;
  if (!(await shouldWriteNote(campaign.campaignRunId, input))) return null;

  const priorNotes = await getRecentNotes(campaign.campaignRunId);
  const contributorSummary = input.contributors
    .slice(0, 30)
    .map((contrib) => {
      const rank = contrib.rank ? `#${contrib.rank}` : "-";
      const conversation = contrib.conversation?.length
        ? `\n  follow-up thread: ${contrib.conversation.join(" / ").slice(0, 360)}`
        : "";
      return `${rank} @${contrib.authorUsername}: ${contrib.text.slice(0, 280)}${conversation}`;
    })
    .join("\n");

  const result = await askAtlas({
    prompt: `You are updating your public campaign notebook.

Campaign question:
"${campaign.questionText || campaign.campaignId}"

Current ranked quote corpus for notebook observation (up to top 30, broader than the canonical reward set when available):
${contributorSummary}

Recent prior notebook notes:
${priorNotes || "(none yet)"}

Write a public Markdown note based on the full corpus, not just a critique of individual answers.

Observe:
- emerging themes
- new evidence
- repeated constraints
- disagreements or missing information
- how this changes what you currently believe about the question

Rules:
- Write 1 to 3 short Markdown sections.
- Use "##" headings.
- Be specific and reference contributors when useful.
- Do not summarize every answer.
- Do not overclaim.
- Do not include raw URLs.
- If there is no new public observation, respond exactly: NO_NOTE`,
  });

  const markdown = result.response.trim();
  if (!result.ok || markdown === "NO_NOTE" || markdown === "(error)") return null;
  return sanitizeMarkdown(markdown);
}

async function shouldWriteNote(campaignRunId: string, input: CampaignNotebookInput): Promise<boolean> {
  const db = getDb();
  const since = new Date(Date.now() - NOTE_COOLDOWN_MINUTES * 60 * 1000);
  const recentNotes = await db
    .select({ id: campaignPublicEvents.id })
    .from(campaignPublicEvents)
    .where(
      and(
        eq(campaignPublicEvents.campaignRunId, campaignRunId),
        eq(campaignPublicEvents.eventType, "atlas_note"),
        gte(campaignPublicEvents.createdAt, since),
      ),
    )
    .limit(1);
  if (recentNotes.length === 0) return true;

  const latestSnapshot = await getLatestSnapshot(campaignRunId);
  const previousTopHash = latestSnapshot?.contributors?.[0]?.castHash;
  const currentTopHash = input.contributors[0]?.castHash;
  return Boolean(currentTopHash && previousTopHash && currentTopHash !== previousTopHash);
}

async function getLatestSnapshot(campaignRunId: string): Promise<any | null> {
  const db = getDb();
  const [row] = await db
    .select({ snapshotJson: campaignPublicEvents.snapshotJson })
    .from(campaignPublicEvents)
    .where(
      and(
        eq(campaignPublicEvents.campaignRunId, campaignRunId),
        eq(campaignPublicEvents.eventType, "snapshot"),
      ),
    )
    .orderBy(desc(campaignPublicEvents.createdAt))
    .limit(1);
  return row?.snapshotJson || null;
}

async function getRecentNotes(campaignRunId: string): Promise<string> {
  const db = getDb();
  const rows = await db
    .select({
      bodyMarkdown: campaignPublicEvents.bodyMarkdown,
      createdAt: campaignPublicEvents.createdAt,
    })
    .from(campaignPublicEvents)
    .where(
      and(
        eq(campaignPublicEvents.campaignRunId, campaignRunId),
        eq(campaignPublicEvents.eventType, "atlas_note"),
      ),
    )
    .orderBy(desc(campaignPublicEvents.createdAt))
    .limit(5);

  return rows
    .map((row) => `- ${row.createdAt.toISOString()}\n${row.bodyMarkdown.slice(0, 700)}`)
    .join("\n\n");
}

async function upsertCampaignPage(
  campaign: NonNullable<Awaited<ReturnType<typeof loadCampaign>>>,
  snapshot: Record<string, unknown>,
): Promise<void> {
  const db = getDb();
  const bodyMarkdown = await buildPageMarkdown(campaign, snapshot);
  const existing = await db
    .select({ id: campaignPublicPages.id })
    .from(campaignPublicPages)
    .where(eq(campaignPublicPages.campaignRunId, campaign.campaignRunId))
    .limit(1);

  const now = new Date();
  if (existing[0]) {
    await db
      .update(campaignPublicPages)
      .set({
        title: campaign.title,
        slug: campaign.slug,
        bodyMarkdown,
        snapshotJson: snapshot,
        lastGeneratedAt: now,
        updatedAt: now,
      })
      .where(eq(campaignPublicPages.id, existing[0].id));
    return;
  }

  await db.insert(campaignPublicPages).values({
    id: createId(),
    campaignRunId: campaign.campaignRunId,
    campaignId: campaign.campaignId,
    slug: campaign.slug,
    title: campaign.title,
    status: "published",
    bodyMarkdown,
    snapshotJson: snapshot,
    lastGeneratedAt: now,
  });
}

async function buildPageMarkdown(
  campaign: NonNullable<Awaited<ReturnType<typeof loadCampaign>>>,
  snapshot: Record<string, unknown>,
): Promise<string> {
  const notes = await getAllNotes(campaign.campaignRunId);
  const contributors = Array.isArray(snapshot.contributors)
    ? snapshot.contributors as Array<Record<string, unknown>>
    : [];
  const contributorCorpusSize = typeof snapshot.contributorCorpusSize === "number"
    ? snapshot.contributorCorpusSize
    : contributors.length;

  const lines: string[] = ["## Atlas Notebook", ""];
  const notebookMarkdown = buildNotebookManifestMarkdown(notes);
  if (!notebookMarkdown) {
    lines.push("_Atlas has not written a notebook note for this campaign yet._", "");
  } else {
    const latestNote = notes[notes.length - 1];
    lines.push(renderNotebookNoteMarker(
      latestNote ? `Campaign manifest · updated ${formatDateTime(latestNote.createdAt)}` : "Campaign manifest",
      notebookMarkdown,
    ), "");
  }

  lines.push(
    "## Live Contributions",
    "",
    renderSectionNoteMarker(
      contributorCorpusSize > 10
        ? `The current top 10 are shown below. Atlas reads the live top ${contributorCorpusSize} as its notebook corpus, while the public reward boundary stays conservative.`
        : "The current ranked contribution set is shown below.",
    ),
    "",
  );

  if (contributors.length === 0) {
    lines.push("_No live contributions captured yet._", "");
  } else {
    appendContributionMarkdown(lines, contributors.slice(0, 10));
  }

  if (contributors.length > 10) {
    lines.push("::more-contributions", "");
    appendContributionMarkdown(lines, contributors.slice(10, 30));
    lines.push("::more-contributions-end", "");
  }

  return lines.join("\n").trim() + "\n";
}

function buildNotebookManifestMarkdown(
  notes: Array<{ bodyMarkdown: string; createdAt: Date }>,
): string {
  const manifestSections: string[] = [];
  const seen = new Set<string>();
  for (const note of [...notes].reverse()) {
    for (const section of splitNotebookSections(note.bodyMarkdown)) {
      const clean = dedupeMarkdown(section).trim();
      if (!clean) continue;
      const key = normalizeNotebookSectionKey(clean);
      if (!key || seen.has(key)) continue;
      if (!isImportantNotebookSection(clean)) continue;
      seen.add(key);
      manifestSections.push(clean);
      if (manifestSections.length >= NOTEBOOK_MANIFEST_SECTION_LIMIT) break;
    }
    if (manifestSections.length >= NOTEBOOK_MANIFEST_SECTION_LIMIT) break;
  }
  return manifestSections.reverse().join("\n\n").trim();
}

function splitNotebookSections(markdown: string): string[] {
  const lines = sanitizeMarkdown(markdown).split(/\r?\n/);
  const sections: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (/^#{2,3}\s+/.test(line) && current.length > 0) {
      sections.push(current.join("\n").trim());
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) sections.push(current.join("\n").trim());

  return sections
    .map((section) => section.replace(/^###\s+/m, "## ").trim())
    .filter(Boolean);
}

function normalizeNotebookSectionKey(value: string): string {
  const heading = value.match(/^##\s+(.+)$/m)?.[1] || "";
  const body = value
    .replace(/^#+\s*/gm, "")
    .replace(/@[a-z0-9_.-]+/gi, "")
    .replace(/[^a-z0-9]+/gi, " ")
    .toLowerCase()
    .trim();
  const normalizedHeading = heading
    .replace(/[^a-z0-9]+/gi, " ")
    .toLowerCase()
    .trim();
  return normalizedHeading || body.slice(0, 120);
}

function isImportantNotebookSection(value: string): boolean {
  const normalized = normalizeNotebookText(value);
  if (normalized.length < 80) return false;
  if (/^(quick note|small update|status update|more responses)\b/i.test(value.replace(/^#+\s*/gm, "").trim())) return false;
  return true;
}

function dedupeMarkdown(markdown: string): string {
  const blocks = markdown
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const output: string[] = [];
  for (const block of blocks) {
    const key = normalizeNotebookText(block);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(block);
  }
  return output.join("\n\n");
}

function normalizeNotebookText(value: string): string {
  return value
    .toLowerCase()
    .replace(/^#+\s*/gm, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function appendContributionMarkdown(lines: string[], contributors: Array<Record<string, unknown>>): void {
  for (const contributor of contributors) {
    const rank = typeof contributor.rank === "number" ? `#${contributor.rank}` : "unranked";
    const username = String(contributor.username || "unknown");
    const displayName = String(contributor.displayName || username);
    const pfpUrl = typeof contributor.pfpUrl === "string" ? contributor.pfpUrl : "";
    const text = String(contributor.text || "");
    const followerCount = typeof contributor.followerCount === "number" ? contributor.followerCount : undefined;
    const lootiScore = typeof contributor.lootiScore === "number" ? contributor.lootiScore : undefined;
    const compositeScore = typeof contributor.compositeScore === "number" ? contributor.compositeScore : undefined;
    lines.push(renderContributionMarker({
      rank,
      username,
      displayName,
      pfpUrl,
      followerCount,
      lootiScore,
      compositeScore,
      text,
    }), "");
  }
}

async function getAllNotes(campaignRunId: string) {
  const db = getDb();
  return db
    .select({
      bodyMarkdown: campaignPublicEvents.bodyMarkdown,
      createdAt: campaignPublicEvents.createdAt,
    })
    .from(campaignPublicEvents)
    .where(
      and(
        eq(campaignPublicEvents.campaignRunId, campaignRunId),
        eq(campaignPublicEvents.eventType, "atlas_note"),
      ),
    )
    .orderBy(campaignPublicEvents.createdAt);
}

export async function renderCampaignPages(): Promise<void> {
  const db = getDb();
  const pages = await db
    .select({
      slug: campaignPublicPages.slug,
      title: campaignPublicPages.title,
      status: campaignPublicPages.status,
      bodyMarkdown: campaignPublicPages.bodyMarkdown,
      snapshotJson: campaignPublicPages.snapshotJson,
      campaignId: campaignPublicPages.campaignId,
      campaignRunId: campaignPublicPages.campaignRunId,
      updatedAt: campaignPublicPages.updatedAt,
      runStatus: campaignRuns.status,
      runCreatedAt: campaignRuns.createdAt,
    })
    .from(campaignPublicPages)
    .leftJoin(campaignRuns, eq(campaignPublicPages.campaignRunId, campaignRuns.id))
    .where(
      and(
        eq(campaignPublicPages.status, "published"),
        ne(campaignRuns.status, "retired"),
      ),
    )
    .orderBy(asc(campaignRuns.createdAt));

  const campaignsDir = pathResolve(SITE_DIR, "campaigns");
  await mkdir(campaignsDir, { recursive: true });
  await removeStaleCampaignPages(campaignsDir, new Set(pages.map((page) => `${page.slug}.html`)));
  await writeFile(pathResolve(campaignsDir, "index.html"), renderCampaignIndex(pages), "utf8");

  for (const page of pages) {
    const prompt = typeof page.snapshotJson?.prompt === "string" ? page.snapshotJson.prompt : "";
    const ogImage = await writeCampaignOgImage(page.slug, page.title, prompt);
    const bodyMarkdown = await buildPageMarkdown(
      { campaignRunId: page.campaignRunId } as NonNullable<Awaited<ReturnType<typeof loadCampaign>>>,
      page.snapshotJson || {},
    );
    await db
      .update(campaignPublicPages)
      .set({ bodyMarkdown })
      .where(eq(campaignPublicPages.campaignRunId, page.campaignRunId));
    await writeFile(
      pathResolve(campaignsDir, `${page.slug}.html`),
      renderCampaignPage(page.title, bodyMarkdown, page.updatedAt, page.snapshotJson || {}, ogImage),
      "utf8",
    );
  }
}

async function removeStaleCampaignPages(campaignsDir: string, expectedFiles: Set<string>): Promise<void> {
  try {
    const files = await readdir(campaignsDir);
    await Promise.all(files.map(async (file) => {
      if (file === "index.html" || !file.endsWith(".html") || expectedFiles.has(file)) return;
      await unlink(pathResolve(campaignsDir, file));
    }));
  } catch {
    // Directory may not exist on first render.
  }
}

function renderCampaignIndex(pages: Array<{
  slug: string;
  title: string;
  snapshotJson: Record<string, unknown> | null;
  updatedAt: Date;
  runCreatedAt: Date | null;
}>): string {
  const items = pages.map((page, index) => {
    const snapshot = page.snapshotJson || {};
    const stage = typeof snapshot.stage === "string" ? snapshot.stage : "unknown";
    const prompt = typeof snapshot.prompt === "string" ? snapshot.prompt : "";
    const displayTitle = prompt ? sentenceCase(prompt) : page.title;
    return `<a href="/campaigns/${escapeHtml(page.slug)}" class="post">
      <div class="post-number">${index + 1}</div>
      <div class="post-title">${escapeHtml(displayTitle)}</div>
      <div class="post-date">${escapeHtml(stage)} · updated ${escapeHtml(formatDate(page.updatedAt))}</div>
    </a>`;
  }).join("\n\n");

  return renderShell({
    title: "Atlas Campaigns",
    description: "Public notebooks from Atlas campaigns.",
    body: `<img src="/img/atlas-new-icon.png" alt="Atlas" class="logo">
    <h1>Campaigns</h1>
    <p class="tagline">Live public notebooks from Atlas campaigns.</p>

    ${items || "<p>No campaign notebooks have been published yet.</p>"}`,
  });
}

async function writeCampaignOgImage(slug: string, title: string, prompt: string): Promise<string> {
  const dir = pathResolve(SITE_DIR, "img/campaigns");
  await mkdir(dir, { recursive: true });

  const imageName = `${slug}-${CAMPAIGN_OG_VERSION}-${stableHash(`${title}\n${prompt}`)}`;
  const svgPath = pathResolve(dir, `${imageName}.svg`);
  const pngPath = pathResolve(dir, `${imageName}.png`);
  const atlasPath = pathResolve(SITE_DIR, "img/atlas-holding-world-hand.png");
  const atlasImage = await readFile(atlasPath).then((data) => data.toString("base64")).catch(() => "");
  const svg = renderCampaignOgSvg(title, prompt || title, atlasImage);
  await writeFile(svgPath, svg, "utf8");

  try {
    await execFilePromise("rsvg-convert", ["-w", "1200", "-h", "630", "-f", "png", "-o", pngPath, svgPath]);
    return `https://joinatlas.xyz/img/campaigns/${encodeURIComponent(imageName)}.png`;
  } catch (err: any) {
    console.warn(`[campaign-notebook] Failed to render campaign OG PNG for ${slug}: ${err?.message || err}`);
    return DEFAULT_OG_IMAGE;
  }
}

function renderCampaignOgSvg(_title: string, prompt: string, atlasImageBase64: string): string {
  const promptLines = wrapText(sentenceCase(prompt), 44);
  const textX = 64;
  const fontSize = promptLines.length > 7 ? 28 : promptLines.length > 5 ? 32 : 40;
  const lineHeight = promptLines.length > 7 ? 34 : promptLines.length > 5 ? 38 : 46;
  const startY = promptLines.length > 7 ? 52 : 68;
  const promptText = promptLines
    .map((line, index) => `<text x="${textX}" y="${startY + index * lineHeight}" class="title">${escapeXml(line)}</text>`)
    .join("\n");
  const atlasImage = atlasImageBase64
    ? `<image href="data:image/png;base64,${atlasImageBase64}" x="820" y="292" width="272" height="272" preserveAspectRatio="xMidYMid meet"/>`
    : `<circle cx="956" cy="428" r="104" fill="#7c5cff"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" rx="0" fill="#ffffff"/>
  <rect x="48" y="34" width="900" height="360" fill="#ffffff"/>
  ${promptText}
  ${atlasImage}
  <text x="${textX}" y="552" class="footer">Atlas Campaign Notebook</text>
  <style>
    .title{font:800 ${fontSize}px -apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;fill:#171719}
    .footer{font:700 25px -apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;fill:#7557ff}
  </style>
</svg>`;
}

function wrapText(value: string, maxChars: number): string[] {
  const words = value.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : ["Atlas campaign"];
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).slice(0, 8);
}

function execFilePromise(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function renderCampaignPage(
  title: string,
  markdown: string,
  updatedAt: Date,
  snapshot: Record<string, unknown>,
  ogImage: string,
): string {
  const prompt = typeof snapshot.prompt === "string" ? snapshot.prompt : "";
  const heading = prompt ? sentenceCase(prompt) : title;
  const stage = typeof snapshot.stage === "string" ? snapshot.stage : "unknown";
  const observedAt = typeof snapshot.observedAt === "string" ? snapshot.observedAt : updatedAt.toISOString();
  const description = prompt
    ? `Atlas campaign notebook: ${prompt.slice(0, 180)}`
    : "Atlas campaign notebook.";
  return renderShell({
    title,
    description,
    ogType: "article",
    ogImage,
    body: `<a href="/campaigns" class="back">&larr; Campaigns</a>
    <header class="campaign-header">
      <div class="campaign-header-copy">
        <div class="campaign-kicker">Updated ${escapeHtml(formatDate(updatedAt))}</div>
        <h1>${escapeHtml(heading)}</h1>
        <div class="campaign-meta">
          <span>Stage: ${escapeHtml(stage)}</span>
          <span>Observed: ${escapeHtml(formatDateTime(new Date(observedAt)))}</span>
        </div>
      </div>
      <img src="/img/atlas-holding-world-hand.png" alt="Atlas holding the world" class="campaign-hero">
    </header>
    <article class="article">
      ${markdownToHtml(markdown)}
    </article>`,
    extraCss: `
      .back{display:inline-block;margin-bottom:34px;color:var(--muted);text-decoration:none}
      .campaign-header{display:grid;grid-template-columns:minmax(0,1fr) 132px;gap:28px;align-items:start;margin:14px 0 42px}
      .campaign-kicker{color:var(--muted);font-size:.95rem;margin-bottom:14px}
      .campaign-header h1{font-size:2.05rem;line-height:1.18;margin:0 0 18px;color:var(--strong)}
      .campaign-meta{display:flex;flex-wrap:wrap;gap:10px;color:var(--muted);font-size:.95rem}
      .campaign-meta span{border:1px solid var(--line);border-radius:999px;padding:6px 10px;background:var(--soft-line)}
      .campaign-hero{display:block;width:132px;height:132px;object-fit:contain;justify-self:end}
      .article h2{font-size:1.15rem;margin:38px 0 10px;color:var(--strong)}
      .article h3{font-size:1rem;margin:24px 0 8px;color:var(--strong)}
      .article p{margin:0 0 16px}
      .article blockquote{margin:10px 0 22px;padding:12px 16px;border-left:3px solid var(--line);background:var(--soft-line);border-radius:0 6px 6px 0;color:var(--text)}
      .article strong{color:var(--strong)}
      .section-note{margin:2px 0 18px;color:var(--muted);font-size:.95rem;line-height:1.55}
      .notebook-note{margin:16px 0 28px;padding:24px 26px;border:1px solid var(--line);border-radius:16px;background:#fff;box-shadow:0 6px 18px rgba(0,0,0,.06)}
      .notebook-header{display:flex;align-items:center;gap:10px;margin-bottom:16px}
      .notebook-avatar{width:34px;height:34px;object-fit:contain;flex:0 0 auto}
      .notebook-date{font-size:.92rem;font-weight:700;color:var(--muted)}
      .notebook-body h2,.notebook-body h3{font-size:1.05rem;margin:0 0 12px;color:var(--strong)}
      .notebook-body p{margin:0 0 16px}
      .notebook-body p:last-child{margin-bottom:0}
      .contribution{position:relative;margin:16px 0 34px;padding:72px 28px 28px;border:1px solid #d1d5db;border-radius:16px;background:#fff;overflow:hidden;color:#1f2937;box-shadow:0 8px 16px rgba(0,0,0,.10)}
      .contribution-rank{position:absolute;top:0;left:0;min-width:64px;padding:10px 18px;border-right:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb;border-bottom-right-radius:16px;background:linear-gradient(135deg,#f9fafb,#f3f4f6);box-shadow:inset 0 1px 2px rgba(255,255,255,.9),0 1px 3px rgba(0,0,0,.05);font-size:1.25rem;font-weight:900;color:#1f2937}
      .contribution-score{position:absolute;top:0;right:0;padding:10px 16px 12px 22px;border-bottom-left-radius:22px;background:linear-gradient(135deg,#ffe7ea,#ffbdc6);display:flex;align-items:center;gap:12px;color:#1f2937;font-size:1.25rem;font-weight:900}
      .contribution-score img{width:40px;height:24px;object-fit:contain}
      .contribution-author{display:grid;grid-template-columns:48px 1fr;gap:16px;align-items:center;margin-bottom:22px}
      .contribution-avatar{width:48px;height:48px;border-radius:50%;object-fit:cover;background:#e5e7eb;border:2px solid #f3f4f6}
      .contribution-fallback{display:flex;align-items:center;justify-content:center;color:#6b7280;font-weight:700}
      .contribution-name-row{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
      .contribution-name{font-size:1.05rem;font-weight:800;color:#111827;line-height:1.2}
      .contribution-handle{font-size:.95rem;font-weight:600;color:#4b5563;line-height:1.2}
      .contribution-followers{font-size:.95rem;color:#6b7280;margin-top:4px}
      .contribution-text{white-space:pre-wrap;line-height:1.62;font-size:1rem;color:#1f2937}
      .more-contributions{margin-top:26px}
      .more-contributions summary{cursor:pointer;color:var(--strong);font-weight:700;margin-bottom:18px}
      :root[data-theme=dark] .contribution{background:#151820;border-color:#2f3541;color:#e5e7eb;box-shadow:0 8px 16px rgba(0,0,0,.25)}
      :root[data-theme=dark] .notebook-note{background:#151820;border-color:#2f3541;box-shadow:0 8px 16px rgba(0,0,0,.22)}
      :root[data-theme=dark] .contribution-rank{background:linear-gradient(135deg,#202631,#171b23);border-color:#2f3541;color:#f3f4f6}
      :root[data-theme=dark] .contribution-score{background:linear-gradient(135deg,#3a2329,#512b35);color:#ffe8ed}
      :root[data-theme=dark] .contribution-avatar{background:#242a35;border-color:#2f3541}
      :root[data-theme=dark] .contribution-fallback{color:#a1a6b0}
      :root[data-theme=dark] .contribution-name{color:#f3f4f6}
      :root[data-theme=dark] .contribution-handle,:root[data-theme=dark] .contribution-followers{color:#a1a6b0}
      :root[data-theme=dark] .contribution-text{color:#d7d9de}
      @media (max-width:640px){
        .campaign-header{grid-template-columns:1fr;gap:18px;margin-top:4px}
        .campaign-hero{justify-self:start;width:108px;height:108px;grid-row:1}
        .campaign-header-copy{grid-row:2}
        .campaign-header h1{font-size:1.75rem}
        .contribution{padding:68px 18px 22px}
        .contribution-score{font-size:1.05rem;padding:10px 12px 11px 18px}
        .contribution-score img{width:34px;height:20px}
      }
    `,
  });
}

function renderShell(input: {
  title: string;
  description: string;
  body: string;
  extraCss?: string;
  ogType?: "website" | "article";
  ogImage?: string;
}): string {
  const ogImage = input.ogImage || DEFAULT_OG_IMAGE;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(input.title)}</title>
  <meta name="description" content="${escapeHtml(input.description)}">
  <meta property="og:title" content="${escapeHtml(input.title)}">
  <meta property="og:description" content="${escapeHtml(input.description)}">
  <meta property="og:type" content="${input.ogType || "website"}">
  <meta property="og:image" content="${escapeHtml(ogImage)}">
  <meta property="og:image:secure_url" content="${escapeHtml(ogImage)}">
  <meta property="og:image:type" content="image/png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(input.title)}">
  <meta name="twitter:description" content="${escapeHtml(input.description)}">
  <meta name="twitter:image" content="${escapeHtml(ogImage)}">
  <link rel="icon" type="image/png" href="/img/atlas-new-icon.png">
  <style>${baseCss()}${input.extraCss || ""}</style>
</head>
<body>
  <header class="site-header">
    <button class="icon-button" type="button" data-menu-toggle aria-label="Open navigation" aria-expanded="false">
      <span></span><span></span><span></span>
    </button>
    <button class="theme-toggle" type="button" data-theme-toggle aria-label="Switch to dark mode"><svg class="icon-sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"></path></svg><svg class="icon-moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.7 6.7 0 0 0 9.8 9.8Z"></path></svg></button>
  </header>
  <nav class="site-nav" aria-label="Site navigation">
    <a href="/blog">Articles</a>
    <a href="/campaigns" class="active">Campaigns</a>
    <a href="/architecture">Architecture</a>
    <div class="nav-divider"></div>
    <a href="https://farcaster.xyz/atlas">Farcaster</a>
    <a href="https://farcaster.xyz/miniapps/b9xYkctvKDSj/looti">Looti</a>
  </nav>
  <main>
    ${input.body}
    <hr class="separator">
    <div class="links">
      <a href="https://farcaster.xyz/atlas">Farcaster</a>
      <a href="https://farcaster.xyz/miniapps/b9xYkctvKDSj/looti">Looti</a>
    </div>
  </main>
  <script src="/theme.js"></script>
  <script src="/nav.js"></script>
</body>
</html>`;
}

function baseCss(): string {
  return `*{margin:0;padding:0;box-sizing:border-box}:root{color-scheme:light;--bg:#fff;--text:#333;--muted:#888;--faint:#999;--strong:#1a1a1a;--line:#e5e5e5;--soft-line:#f6f6f6;--link:#2563eb;--surface:rgba(255,255,255,0.86);--shadow:rgba(0,0,0,.08)}:root[data-theme=dark]{color-scheme:dark;--bg:#101114;--text:#d7d9de;--muted:#a1a6b0;--faint:#858b96;--strong:#f2f4f8;--line:#2b2f36;--soft-line:#1b1f27;--link:#8ab4ff;--surface:rgba(16,17,20,0.86);--shadow:rgba(0,0,0,.36)}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;background:var(--bg);color:var(--text);line-height:1.7;-webkit-font-smoothing:antialiased}.site-header{position:fixed;z-index:20;top:0;left:0;right:0;display:flex;align-items:center;justify-content:space-between;padding:14px 18px;background:var(--surface);border-bottom:1px solid var(--soft-line);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px)}.icon-button,.theme-toggle{display:inline-flex;align-items:center;justify-content:center;min-width:42px;height:36px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--strong);cursor:pointer;font:inherit;font-size:.875rem;font-weight:600}.theme-toggle svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}:root[data-theme=dark] .icon-moon,:root:not([data-theme=dark]) .icon-sun{display:none}.icon-button{flex-direction:column;gap:4px;padding:0 11px}.icon-button span{display:block;width:16px;height:2px;background:var(--strong);border-radius:999px}.site-nav{position:fixed;z-index:19;top:58px;left:18px;display:none;min-width:220px;padding:10px;background:var(--bg);border:1px solid var(--line);border-radius:8px;box-shadow:0 18px 44px var(--shadow)}:root[data-menu-open=true] .site-nav{display:grid}.site-nav a{padding:9px 10px;border-radius:6px;color:var(--strong);font-size:.9375rem;text-decoration:none}.site-nav a:hover{background:var(--soft-line)}.site-nav a.active{background:var(--soft-line);color:var(--link)}.nav-divider{height:1px;background:var(--soft-line);margin:6px 10px}.site-nav a[href^="http"]::after{content:" \\2197";font-size:.75em;opacity:.5}main{max-width:680px;margin:0 auto;padding:88px 24px 120px}.logo{display:block;width:64px;height:64px;margin-bottom:32px}h1{font-size:1.5rem;font-weight:700;color:var(--strong);margin-bottom:8px}.tagline{color:var(--muted);font-size:1rem;margin-bottom:56px}.post{display:block;padding:20px 0;border-top:1px solid var(--soft-line);text-decoration:none}.post:last-of-type{border-bottom:1px solid var(--soft-line)}.post-number{font-size:.8125rem;font-weight:700;color:var(--line);margin-bottom:4px;font-variant-numeric:tabular-nums}.post-title{font-size:1.0625rem;font-weight:600;color:var(--strong);margin-bottom:4px}.post:hover .post-title,.post:hover .post-number{color:var(--link)}.post-date{font-size:.8125rem;color:var(--faint);margin-bottom:14px}.separator{border:none;border-top:1px solid var(--line);margin:56px 0 24px}.links{display:flex;gap:24px;flex-wrap:wrap}.links a{font-size:.9375rem;color:var(--muted);text-decoration:none}.links a:hover{color:var(--strong)}a{color:var(--link)}@media(max-width:480px){main{padding:88px 20px 80px}}`;
}

function markdownToHtml(markdown: string): string {
  const moreBlocks = new Map<string, string>();
  const withoutMoreBlocks = markdown.replace(/::more-contributions\s+([\s\S]*?)\n::more-contributions-end/g, (_match, inner) => {
    const key = `@@MORE_CONTRIBUTIONS_${moreBlocks.size}@@`;
    moreBlocks.set(key, inner.trim());
    return key;
  });

  const sectionNoteBlocks = new Map<string, string>();
  const withSectionNotes = withoutMoreBlocks.replace(/::section-note\s+([\s\S]*?)\n::/g, (_match, rawJson) => {
    const key = `@@SECTION_NOTE_${sectionNoteBlocks.size}@@`;
    try {
      const parsed = JSON.parse(rawJson);
      sectionNoteBlocks.set(key, renderSectionNoteHtml(String(parsed.text || "")));
    } catch {
      sectionNoteBlocks.set(key, "");
    }
    return key;
  });

  const contributionBlocks = new Map<string, string>();
  const notebookBlocks = new Map<string, string>();
  const withNotebookNotes = withSectionNotes.replace(/::notebook-note\s+([\s\S]*?)\n::/g, (_match, rawJson) => {
    const key = `@@NOTEBOOK_NOTE_${notebookBlocks.size}@@`;
    try {
      const parsed = JSON.parse(rawJson);
      notebookBlocks.set(key, renderNotebookNoteHtml({
        date: String(parsed.date || ""),
        bodyMarkdown: String(parsed.bodyMarkdown || ""),
      }));
    } catch {
      notebookBlocks.set(key, "");
    }
    return key;
  });

  const withPlaceholders = withNotebookNotes.replace(/::contribution\s+([\s\S]*?)\n::/g, (_match, rawJson) => {
    const key = `@@CONTRIBUTION_${contributionBlocks.size}@@`;
    try {
      const parsed = JSON.parse(rawJson);
      contributionBlocks.set(key, renderContributionHtml({
        rank: String(parsed.rank || ""),
        username: String(parsed.username || "unknown"),
        displayName: String(parsed.displayName || parsed.username || "unknown"),
        pfpUrl: typeof parsed.pfpUrl === "string" ? parsed.pfpUrl : "",
        followerCount: typeof parsed.followerCount === "number" ? parsed.followerCount : undefined,
        lootiScore: typeof parsed.lootiScore === "number" ? parsed.lootiScore : undefined,
        compositeScore: typeof parsed.compositeScore === "number" ? parsed.compositeScore : undefined,
        text: String(parsed.text || ""),
      }));
    } catch {
      contributionBlocks.set(key, "");
    }
    return key;
  });

  const blocks = withPlaceholders.split(/\n{2,}/);
  return blocks.map((block) => {
    const trimmed = block.trim();
    if (!trimmed) return "";
    if (moreBlocks.has(trimmed)) {
      return `<details class="more-contributions"><summary>Show more contributions</summary>${markdownToHtml(moreBlocks.get(trimmed) || "")}</details>`;
    }
    if (sectionNoteBlocks.has(trimmed)) return sectionNoteBlocks.get(trimmed) || "";
    if (notebookBlocks.has(trimmed)) return notebookBlocks.get(trimmed) || "";
    if (contributionBlocks.has(trimmed)) return contributionBlocks.get(trimmed) || "";
    if (trimmed.startsWith("# ")) return `<h1>${inlineMarkdown(trimmed.slice(2))}</h1>`;
    if (trimmed.startsWith("## ")) return `<h2>${inlineMarkdown(trimmed.slice(3))}</h2>`;
    if (trimmed.startsWith("### ")) return `<h3>${inlineMarkdown(trimmed.slice(4))}</h3>`;
    if (trimmed.startsWith("> ")) {
      return `<blockquote>${trimmed.split("\n").map((line) => inlineMarkdown(line.replace(/^>\s?/, ""))).join("<br>")}</blockquote>`;
    }
    return `<p>${trimmed.split("\n").map(inlineMarkdown).join("<br>")}</p>`;
  }).filter(Boolean).join("\n");
}

function renderContributionMarker(input: {
  rank: string;
  username: string;
  displayName: string;
  pfpUrl: string;
  followerCount?: number;
  lootiScore?: number;
  compositeScore?: number;
  text: string;
}): string {
  return `::contribution
${JSON.stringify(input)}
::`;
}

function renderSectionNoteMarker(text: string): string {
  return `::section-note
${JSON.stringify({ text })}
::`;
}

function renderSectionNoteHtml(text: string): string {
  return `<p class="section-note">${inlineMarkdown(text)}</p>`;
}

function renderNotebookNoteMarker(date: string, bodyMarkdown: string): string {
  return `::notebook-note
${JSON.stringify({ date, bodyMarkdown })}
::`;
}

function renderNotebookNoteHtml(input: { date: string; bodyMarkdown: string }): string {
  return `<section class="notebook-note">
  <div class="notebook-header">
    <img class="notebook-avatar" src="/img/atlas-new-icon.png" alt="Atlas">
    <div class="notebook-date">${escapeHtml(input.date)}</div>
  </div>
  <div class="notebook-body">${markdownToHtml(input.bodyMarkdown)}</div>
</section>`;
}

function renderContributionHtml(input: {
  rank: string;
  username: string;
  displayName: string;
  pfpUrl: string;
  followerCount?: number;
  lootiScore?: number;
  compositeScore?: number;
  text: string;
}): string {
  const initials = input.displayName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || input.username.slice(0, 2).toUpperCase();
  const avatar = input.pfpUrl
    ? `<img class="contribution-avatar" src="${escapeHtml(input.pfpUrl)}" alt="">`
    : `<div class="contribution-avatar contribution-fallback">${escapeHtml(initials)}</div>`;
  const score = typeof input.compositeScore === "number"
    ? input.compositeScore.toFixed(2)
    : typeof input.lootiScore === "number"
      ? (input.lootiScore / 100).toFixed(2)
      : null;
  const scoreBadge = score
    ? `<div class="contribution-score"><img src="/img/looti-transparent.png" alt="Looti"><span>${escapeHtml(score)}</span></div>`
    : "";
  const followers = typeof input.followerCount === "number" && Number.isFinite(input.followerCount)
    ? `<div class="contribution-followers">${escapeHtml(input.followerCount.toLocaleString())} followers</div>`
    : "";
  return `<div class="contribution">
  <div class="contribution-rank">${escapeHtml(input.rank)}</div>
  ${scoreBadge}
  <div class="contribution-author">
    ${avatar}
    <div>
      <div class="contribution-name-row">
        <span class="contribution-name">${escapeHtml(input.displayName)}</span>
        <span class="contribution-handle">@${escapeHtml(input.username)}</span>
      </div>
      ${followers}
    </div>
  </div>
  <div class="contribution-text">${escapeHtml(input.text)}</div>
</div>`;
}

function inlineMarkdown(value: string): string {
  return escapeHtml(value)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])_([^_\n]+)_/g, "$1<em>$2</em>");
}

function sanitizeMarkdown(markdown: string): string {
  const cleaned = markdown
    .replace(/```[\s\S]*?```/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .split("\n")
    .map((line) => sanitizeMarkdownLine(line))
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
  return cleaned.slice(0, 5000);
}

function sanitizeMarkdownLine(line: string): string {
  const trimmed = line.trimEnd();
  if (/^#{1,3}\s+/.test(trimmed)) {
    return trimmed.replace(/^#{1,3}\s+/, "### ");
  }
  if (/^#{4,6}\s+/.test(trimmed)) {
    return trimmed.replace(/^#{4,6}\s+/, "### ");
  }
  if (/^\s*[-*+]\s+/.test(trimmed)) {
    return trimmed.replace(/^\s*[-*+]\s+/, "- ");
  }
  if (/^\s*\d+[.)]\s+/.test(trimmed)) {
    return trimmed.replace(/^\s*\d+[.)]\s+/, "- ");
  }
  if (/^\s*>\s?/.test(trimmed)) {
    return trimmed.replace(/^\s*>\s?/, "> ");
  }
  return trimmed;
}

function titleFromQuestion(question: string): string {
  const compact = question.replace(/\s+/g, " ").trim();
  if (compact.length <= 72) return sentenceCase(compact);
  return sentenceCase(`${compact.slice(0, 69).replace(/\s+\S*$/, "")}...`);
}

function sentenceCase(value: string): string {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function slugFromCampaign(campaignId: string, question?: string | null): string {
  const base = question || campaignId;
  return base
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .split(/\s+/)
    .slice(0, 7)
    .join("-") || "campaign";
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function formatDateTime(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeXml(value: string): string {
  return escapeHtml(value).replace(/'/g, "&apos;");
}

async function maybeDeploySite(): Promise<void> {
  if (process.env.ATLAS_CAMPAIGN_NOTEBOOK_DEPLOY_ENABLED !== "true") return;
  if (await hasRecentCampaignDeploy()) return;
  await deploySite();
  await getDb().insert(auditLog).values({
    id: createId(),
    entityType: "campaign_notebook_deploy",
    entityId: "site",
    action: "deployed",
    actor: "atlas_agent",
    reason: "Campaign notebook refresh",
  });
}

async function hasRecentCampaignDeploy(): Promise<boolean> {
  const since = new Date(Date.now() - 30 * 60 * 1000);
  const rows = await getDb()
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entityType, "campaign_notebook_deploy"),
        gte(auditLog.createdAt, since),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function deploySite(): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "npx",
      ["wrangler", "pages", "deploy", "public", "--project-name", "joinatlas-xyz", "--commit-dirty=true"],
      {
        cwd: pathResolve(ATLAS_DIR, "apps/site"),
        timeout: 60_000,
        env: {
          ...process.env,
          PATH: `/root/.bun/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH}`,
        },
      },
      (err: Error | null) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      },
    );
  });
}
