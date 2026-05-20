import { mkdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  AtlasPointAllocationInput,
  LootiClient,
  LootiRewardSet,
  LootiRewardSetEntry,
} from "../../sdk/src/index.js";

export interface IngestRewardSetInput {
  atlasRunId: string;
  campaignId: string;
  rewardSetLimit: 3 | 10;
  worldDir?: string;
  lootiClient: LootiClient;
  recordAllocations?: boolean;
}

export interface IngestRewardSetResult {
  atlasRunId: string;
  campaignId: string;
  rewardSetLimit: 3 | 10;
  ingestedAt: string;
  rewardSet: LootiRewardSet;
  allocations: AtlasPointAllocationInput;
  artifactPaths: {
    rewardSet: string;
    evidence: string;
    memoryCandidate: string;
    review: string;
    allocations: string;
  };
  recordedAllocations: boolean;
}

export async function ingestRewardSet(input: IngestRewardSetInput): Promise<IngestRewardSetResult> {
  const rewardSet = await input.lootiClient.getRewardSet(input.campaignId, input.rewardSetLimit);
  const allocations = buildAtlasAllocations(input.atlasRunId, rewardSet);
  const worldDir = input.worldDir || process.env.ATLAS_WORLD_DIR || "world";
  const campaignDir = resolve(process.cwd(), worldDir, "campaigns", input.campaignId);
  await mkdir(campaignDir, { recursive: true });

  const artifactPaths = {
    rewardSet: resolve(campaignDir, "reward-set.json"),
    evidence: resolve(campaignDir, "evidence.md"),
    memoryCandidate: resolve(campaignDir, "memory-candidate.md"),
    review: resolve(campaignDir, "review.md"),
    allocations: resolve(campaignDir, "atlas-allocations.json"),
  };

  await writeJsonAtomic(artifactPaths.rewardSet, rewardSet);
  await writeJsonAtomic(artifactPaths.allocations, allocations);
  await writeTextAtomic(artifactPaths.evidence, renderEvidenceMarkdown(rewardSet));
  await writeTextAtomic(artifactPaths.memoryCandidate, renderMemoryCandidateMarkdown(rewardSet));
  await writeTextAtomic(artifactPaths.review, renderReviewMarkdown(rewardSet, allocations));

  if (input.recordAllocations) {
    await input.lootiClient.recordAtlasAllocations(input.campaignId, allocations);
  }

  return {
    atlasRunId: input.atlasRunId,
    campaignId: input.campaignId,
    rewardSetLimit: input.rewardSetLimit,
    ingestedAt: new Date().toISOString(),
    rewardSet,
    allocations,
    artifactPaths,
    recordedAllocations: input.recordAllocations === true,
  };
}

export function buildAtlasAllocations(
  atlasRunId: string,
  rewardSet: LootiRewardSet
): AtlasPointAllocationInput {
  const maxRank = Math.max(rewardSet.entries.length, 1);

  return {
    atlasRunId,
    rewardSetSnapshotId: rewardSet.snapshotId,
    allocations: rewardSet.entries.map((entry) => {
      const topQuote = entry.topQuotes[0];
      const points = Math.max(maxRank - entry.rank + 1, 1);

      return {
        fid: entry.fid,
        username: entry.username,
        quoteHash: topQuote?.hash || "",
        rank: entry.rank,
        points,
        rationale: `Beta allocation: rank ${entry.rank} in Looti ${rewardSet.rewardSetLimit}-entry reward set.`,
        memoryEffect: {
          worldPath: "world/candidates",
          summary: summarizeEntry(entry),
        },
      };
    }),
  };
}

function renderEvidenceMarkdown(rewardSet: LootiRewardSet): string {
  const lines = [
    "# Campaign Evidence",
    "",
    `Campaign: ${rewardSet.campaignId}`,
    `Snapshot: ${rewardSet.snapshotId}`,
    `Generated: ${rewardSet.generatedAt}`,
    `Prompt cast: ${rewardSet.cast.hash}`,
    `Prompt author: @${rewardSet.cast.authorUsername}`,
    "",
    "## Prompt",
    "",
    rewardSet.cast.text || "(no prompt text returned)",
    "",
    "## Top Entries",
    "",
  ];

  for (const entry of rewardSet.entries) {
    lines.push(`### ${entry.rank}. @${entry.username} (${entry.fid})`);
    lines.push("");
    lines.push(`Composite score: ${entry.totalCompositeScore}`);
    lines.push(`Looti score: ${entry.totalLootiScore}`);
    lines.push("");

    for (const quote of entry.topQuotes) {
      lines.push(`- Quote ${quote.hash}`);
      lines.push(`  - Algo rank: ${quote.algoRank}`);
      lines.push(`  - Composite: ${quote.compositeScore}`);
      lines.push(`  - Looti: ${quote.lootiScore}`);
      lines.push(`  - Text: ${quote.text || "(empty quote text)"}`);
    }

    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function renderMemoryCandidateMarkdown(rewardSet: LootiRewardSet): string {
  const observations = rewardSet.entries.map((entry) => {
    const quote = entry.topQuotes[0];
    return `- Rank ${entry.rank}, @${entry.username}, quote ${quote?.hash || "unknown"}: ${summarizeEntry(entry)}`;
  });

  return [
    "# Memory Candidate",
    "",
    "Status: beta candidate only. Do not apply automatically.",
    "",
    `Campaign: ${rewardSet.campaignId}`,
    `Reward set snapshot: ${rewardSet.snapshotId}`,
    "",
    "## Proposed World Update",
    "",
    "Atlas should review the winning quotes and decide whether they support a durable update to:",
    "",
    "- `world/world-state.md`",
    "- `world/entities.md`",
    "- `world/timeline.md`",
    "- future campaign questions",
    "",
    "## Candidate Observations",
    "",
    ...observations,
    "",
    "## Required Human/Atlas Review",
    "",
    "- Does each observation actually answer the campaign question?",
    "- Is the observation general enough to become world memory?",
    "- Which quote hashes should be cited in any applied update?",
    "- Should this trigger a follow-up Looti campaign instead of a world update?",
    "",
  ].join("\n");
}

function renderReviewMarkdown(
  rewardSet: LootiRewardSet,
  allocations: AtlasPointAllocationInput
): string {
  return [
    "# Beta Review",
    "",
    `Campaign: ${rewardSet.campaignId}`,
    `Entries reviewed: ${rewardSet.entries.length}`,
    `Allocations drafted: ${allocations.allocations.length}`,
    "",
    "## Decision",
    "",
    "- [ ] No world update",
    "- [ ] Append timeline note",
    "- [ ] Add candidate observation",
    "- [ ] Apply reviewed world-state update",
    "- [ ] Launch follow-up campaign",
    "",
    "## Notes",
    "",
    "This beta artifact exists to keep public input separate from durable memory until the review loop is trusted.",
    "",
  ].join("\n");
}

function summarizeEntry(entry: LootiRewardSetEntry): string {
  const quote = entry.topQuotes[0];
  const text = quote?.text?.replace(/\s+/g, " ").trim();
  if (!text) {
    return "No quote text was returned; inspect raw reward-set artifact before making a memory change.";
  }

  return text.length > 220 ? `${text.slice(0, 217)}...` : text;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeTextAtomic(path: string, value: string): Promise<void> {
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, value, "utf8");
  await rename(tmpPath, path);
}
