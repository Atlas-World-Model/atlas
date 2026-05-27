/**
 * Close the review loop after campaign synthesis.
 *
 * Reads the evidence and reward set, then applies durable updates:
 *   - entities.md — adds ranked contributors with quote citations
 *   - timeline.md — appends campaign outcome
 *   - review.md — checks the appropriate decision boxes
 */

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { LootiRewardSet, LootiRewardSetEntry } from "../../sdk/src/index.js";

export interface CloseReviewLoopInput {
  campaignId: string;
  rewardSet: LootiRewardSet;
  synthesisResult: string;
  worldDir?: string;
}

export interface CloseReviewLoopResult {
  entitiesUpdated: number;
  timelineAppended: boolean;
  reviewClosed: boolean;
}

export async function closeReviewLoop(
  input: CloseReviewLoopInput,
): Promise<CloseReviewLoopResult> {
  const worldDir = input.worldDir || process.env.ATLAS_WORLD_DIR || "world";
  const baseDir = resolve(process.cwd(), worldDir);
  const entries = input.rewardSet.entries;

  if (entries.length === 0) {
    return { entitiesUpdated: 0, timelineAppended: false, reviewClosed: false };
  }

  // 1. Update entities.md — add contributors
  const entitiesPath = resolve(baseDir, "entities.md");
  const entitiesUpdated = await updateEntities(entitiesPath, input.campaignId, entries);

  // 2. Append to timeline.md
  const timelinePath = resolve(baseDir, "timeline.md");
  const timelineAppended = await appendTimeline(
    timelinePath,
    input.campaignId,
    input.rewardSet,
    input.synthesisResult,
  );

  // 3. Close review.md
  const campaignDir = resolve(baseDir, "campaigns", input.campaignId);
  const reviewPath = resolve(campaignDir, "review.md");
  const reviewClosed = await closeReview(reviewPath, input.synthesisResult);

  return { entitiesUpdated, timelineAppended, reviewClosed };
}

async function updateEntities(
  path: string,
  campaignId: string,
  entries: LootiRewardSetEntry[],
): Promise<number> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    return 0;
  }

  // Build contributor lines
  const newContributors: string[] = [];
  for (const entry of entries) {
    const quote = entry.topQuotes[0];
    const text = quote?.text?.replace(/\s+/g, " ").trim().slice(0, 120) || "";
    const citeSuffix = quote?.hash ? ` (${quote.hash.slice(0, 10)})` : "";
    // Check if contributor already exists
    if (content.includes(`@${entry.username}`)) continue;
    newContributors.push(
      `- **@${entry.username}** — campaign ${campaignId}, rank ${entry.rank}. "${text}"${citeSuffix}`,
    );
  }

  if (newContributors.length === 0) return 0;

  // Replace the placeholder or append after ## Contributors
  const placeholder = "No contributors have entered Atlas's canonical context yet.";
  if (content.includes(placeholder)) {
    content = content.replace(placeholder, newContributors.join("\n"));
  } else if (content.includes("## Contributors")) {
    // Append after the last contributor entry before the next ## heading
    const contributorsIdx = content.indexOf("## Contributors");
    const nextHeadingIdx = content.indexOf("\n## ", contributorsIdx + 1);
    const insertAt = nextHeadingIdx === -1 ? content.length : nextHeadingIdx;
    content =
      content.slice(0, insertAt).trimEnd() +
      "\n" +
      newContributors.join("\n") +
      "\n\n" +
      content.slice(insertAt);
  }

  await writeFile(path, content, "utf8");
  return newContributors.length;
}

async function appendTimeline(
  path: string,
  campaignId: string,
  rewardSet: LootiRewardSet,
  synthesisResult: string,
): Promise<boolean> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    return false;
  }

  // Don't duplicate
  if (content.includes(campaignId)) return false;

  const date = new Date().toISOString().split("T")[0];
  const topNames = rewardSet.entries
    .slice(0, 5)
    .map((e) => `@${e.username}`)
    .join(", ");
  const castHash = rewardSet.cast.hash ? ` (cast: ${rewardSet.cast.hash.slice(0, 10)})` : "";

  const entry = [
    "",
    `## ${date}`,
    "",
    `- Campaign ${campaignId} synthesized${castHash}.`,
    `  ${rewardSet.entries.length} ranked entries. Top contributors: ${topNames}.`,
    `  Synthesis result: ${synthesisResult}.`,
    `  Reward set snapshot: ${rewardSet.snapshotId}.`,
    "",
  ].join("\n");

  content = content.trimEnd() + "\n" + entry;
  await writeFile(path, content, "utf8");
  return true;
}

async function closeReview(
  path: string,
  synthesisResult: string,
): Promise<boolean> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    return false;
  }

  // Check the appropriate boxes
  if (synthesisResult === "no_action") {
    content = content.replace("- [ ] No world update", "- [x] No world update");
  } else if (synthesisResult === "memory_only" || synthesisResult === "manual_review") {
    content = content.replace("- [ ] Apply reviewed world-state update", "- [x] Apply reviewed world-state update");
    content = content.replace("- [ ] Append timeline note", "- [x] Append timeline note");
  } else if (synthesisResult === "follow_up") {
    content = content.replace("- [ ] Launch follow-up campaign", "- [x] Launch follow-up campaign");
    content = content.replace("- [ ] Append timeline note", "- [x] Append timeline note");
  } else if (synthesisResult === "build") {
    content = content.replace("- [ ] Apply reviewed world-state update", "- [x] Apply reviewed world-state update");
    content = content.replace("- [ ] Append timeline note", "- [x] Append timeline note");
  }

  await writeFile(path, content, "utf8");
  return true;
}
