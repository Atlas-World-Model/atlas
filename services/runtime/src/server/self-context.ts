/**
 * Atlas self-context — builds a real-time snapshot of Atlas's own state.
 * Loaded into every Claude Code prompt so Atlas has full operational awareness.
 */

import { getDb, campaignRuns, questions, outcomes, contributors, contributorReputation, auditLog, outcomeChecks } from "../../../../packages/db/src/index.js";
import { eq, desc, and, gte, count } from "drizzle-orm";
import { readFile } from "fs/promises";
import { resolve } from "path";

const ATLAS_DIR = process.env.ATLAS_DIR || "/opt/atlas";
const ARCHITECTURE_MEMORY_PATH = resolve(ATLAS_DIR, "world/architecture/current-architecture.md");
const ARCHITECTURE_MEMORY_MAX_CHARS = 3600;

export async function buildSelfContext(): Promise<string> {
  try {
    const db = getDb();
    const now = new Date();

    const activeCampaigns = await getActiveCampaigns(db);
    const recentAuditEntries = await getRecentActivity(db, now);
    const recentPublicOutputs = await getRecentPublicOutputs(db, now);
    const recentContributorSnapshots = await getRecentContributorSnapshots(db, now);
    const contributorCount = await getContributorCount(db);
    const treasuryBalance = await getTreasuryBalance();
    const recentErrors = await getRecentErrors(db, now);
    const pendingChecks = await getPendingChecks(db, now);
    const architectureMemory = await getArchitectureMemory();

    const sections: string[] = [];

    // Active campaigns
    if (activeCampaigns.length > 0) {
      const current = activeCampaigns[0];
      const currentUrl = readCampaignUrl(current.metadata);
      sections.push("CURRENT_ACTIVE_CAMPAIGN:");
      sections.push(`  campaign_id: ${current.campaignId || "unknown"}`);
      const currentAlgorithm = readLootiDistributionAlgorithm(current.metadata);
      if (currentAlgorithm) {
        sections.push(`  looti_distribution_algorithm: ${currentAlgorithm}`);
        sections.push(`  looti_product: ${currentAlgorithm === "the_ladder" ? "the_podium" : "the_well"}`);
      }
      sections.push(`  stage: ${current.lifecycleStage}`);
      sections.push(`  expected_action: ${current.expectedAction}`);
      if (current.questionText) {
        sections.push(`  question: "${current.questionText.slice(0, 240)}"`);
      }
      if (current.farcasterCastHash) {
        sections.push(`  farcaster_cast_hash: ${current.farcasterCastHash}`);
      }
      if (currentUrl) {
        sections.push(`  looti_campaign_url: ${currentUrl}`);
      }
      sections.push("");
      sections.push("Active campaigns:");
      const shownCampaignKeys = new Set<string>();
      for (const c of activeCampaigns) {
        const campaignKey = c.farcasterCastHash || c.campaignId || c.id;
        if (shownCampaignKeys.has(campaignKey)) continue;
        shownCampaignKeys.add(campaignKey);

        const age = Math.floor((now.getTime() - new Date(c.createdAt).getTime()) / (1000 * 60 * 60));
        const ageStr = age < 24 ? `${age}h ago` : `${Math.floor(age / 24)}d ago`;
        const campaignUrl = readCampaignUrl(c.metadata);
        sections.push(`  - ${c.campaignId || "unknown"}: stage=${c.lifecycleStage}, started ${ageStr}, action=${c.expectedAction}`);
        if (c.questionText) {
          sections.push(`    active question: "${c.questionText.slice(0, 180)}"`);
        }
        if (c.farcasterCastHash) {
          sections.push(`    farcaster cast hash: ${c.farcasterCastHash}`);
        }
        if (campaignUrl) {
          sections.push(`    campaign url: ${campaignUrl}`);
        }
      }
    } else {
      sections.push("Active campaigns: none");
    }

    // Treasury
    sections.push("");
    sections.push(`Treasury: ${treasuryBalance}`);

    // Contributors
    sections.push(`Total contributors in DB: ${contributorCount}`);

    if (architectureMemory) {
      sections.push("");
      sections.push("Architecture memory:");
      sections.push(architectureMemory);
    }

    // Pending outcome checks
    if (pendingChecks.length > 0) {
      sections.push("");
      sections.push("Upcoming checks:");
      for (const check of pendingChecks) {
        const daysUntil = Math.ceil((new Date(check.scheduledFor).getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
        sections.push(`  - ${check.checkType} in ${daysUntil}d (campaign run ${check.campaignRunId})`);
      }
    }

    // Recent activity
    if (recentAuditEntries.length > 0) {
      sections.push("");
      sections.push("Recent activity (last 24h):");
      for (const entry of recentAuditEntries) {
        sections.push(`  - ${entry.action}: ${entry.reason || entry.entityType}`);
      }
    }

    if (recentPublicOutputs.length > 0) {
      sections.push("");
      sections.push("Recent public output text (avoid repeating these angles or phrasing):");
      for (const output of recentPublicOutputs) {
        const ageMinutes = Math.max(0, Math.floor((now.getTime() - new Date(output.createdAt).getTime()) / (1000 * 60)));
        const age = ageMinutes < 60 ? `${ageMinutes}m ago` : `${Math.floor(ageMinutes / 60)}h ago`;
        sections.push(`  - ${age} ${output.kind}: "${output.text.slice(0, 220)}"`);
      }
    }

    if (recentContributorSnapshots.length > 0) {
      sections.push("");
      sections.push("Live campaign contributors from recent Looti snapshots:");
      for (const snapshot of recentContributorSnapshots) {
        const ageMinutes = Math.max(0, Math.floor((now.getTime() - new Date(snapshot.createdAt).getTime()) / (1000 * 60)));
        const age = ageMinutes < 60 ? `${ageMinutes}m ago` : `${Math.floor(ageMinutes / 60)}h ago`;
        sections.push(`  ${snapshot.campaignId || snapshot.entityId} (${snapshot.source}, ${age}):`);
        for (const contributor of snapshot.contributors.slice(0, 5)) {
          const rank = contributor.rank ? `#${contributor.rank}` : "-";
          sections.push(`    ${rank} @${contributor.username}: "${contributor.text.slice(0, 180)}"`);
        }
      }
    }

    // Recent errors
    if (recentErrors.length > 0) {
      sections.push("");
      sections.push("Recent errors (last 6h):");
      for (const err of recentErrors) {
        sections.push(`  - ${err.reason || err.action}`);
      }
    }

    return sections.join("\n");
  } catch (err: any) {
    return `(self-context unavailable: ${err.message})`;
  }
}

async function getArchitectureMemory(): Promise<string> {
  try {
    const text = await readFile(ARCHITECTURE_MEMORY_PATH, "utf8");
    return compactArchitectureMarkdown(text).slice(0, ARCHITECTURE_MEMORY_MAX_CHARS);
  } catch {
    return "";
  }
}

function compactArchitectureMarkdown(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      if (/^Last updated:/i.test(trimmed)) return false;
      if (/^This is Atlas's compact self-architecture memory/i.test(trimmed)) return false;
      if (/^It describes what Atlas's own code/i.test(trimmed)) return false;
      return true;
    })
    .map((line) => line.replace(/^#\s+/, "").replace(/^##\s+/, "").trimEnd())
    .join("\n");
}

async function getActiveCampaigns(db: any) {
  try {
    const runs = await db
      .select({
        id: campaignRuns.id,
        campaignId: campaignRuns.campaignId,
        lifecycleStage: campaignRuns.lifecycleStage,
        expectedAction: campaignRuns.expectedAction,
        status: campaignRuns.status,
        createdAt: campaignRuns.createdAt,
        metadata: campaignRuns.metadata,
        questionText: questions.text,
        farcasterCastHash: questions.farcasterCastHash,
      })
      .from(campaignRuns)
      .leftJoin(questions, eq(campaignRuns.questionId, questions.id))
      .where(eq(campaignRuns.status, "active"))
      .orderBy(desc(campaignRuns.createdAt))
      .limit(5);
    return runs;
  } catch (err: any) {
    console.error("[self-context] active campaigns unavailable:", err);
    return [];
  }
}

function readCampaignUrl(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const data = metadata as Record<string, unknown>;
  const value = data.lootiCampaignUrl || data.campaignUrl;
  return typeof value === "string" && /^https:\/\//.test(value) ? value : null;
}

function readLootiDistributionAlgorithm(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const data = metadata as Record<string, unknown>;
  const value = data.lootiDistributionAlgorithm || data.distributionAlgorithm || data.campaignType;
  return typeof value === "string" ? value : null;
}

async function getRecentActivity(db: any, now: Date) {
  try {
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    return await db
      .select({
        action: auditLog.action,
        entityType: auditLog.entityType,
        reason: auditLog.reason,
      })
      .from(auditLog)
      .where(gte(auditLog.createdAt, since))
      .orderBy(desc(auditLog.createdAt))
      .limit(10);
  } catch {
    return [];
  }
}

async function getRecentPublicOutputs(db: any, now: Date) {
  try {
    const since = new Date(now.getTime() - 12 * 60 * 60 * 1000);
    const rows = await db
      .select({
        entityType: auditLog.entityType,
        action: auditLog.action,
        newValue: auditLog.newValue,
        createdAt: auditLog.createdAt,
      })
      .from(auditLog)
      .where(gte(auditLog.createdAt, since))
      .orderBy(desc(auditLog.createdAt))
      .limit(30);

    return rows
      .map((row: any) => {
        const data = row.newValue && typeof row.newValue === "object"
          ? row.newValue as Record<string, unknown>
          : {};
        const text = readPublicOutputText(row.entityType, data);
        return text
          ? {
              kind: describePublicOutput(row.entityType, row.action),
              text,
              createdAt: row.createdAt,
            }
          : null;
      })
      .filter(Boolean)
      .slice(0, 8);
  } catch {
    return [];
  }
}

function readPublicOutputText(entityType: string, data: Record<string, unknown>): string | null {
  const value =
    entityType === "campaign_engagement"
      ? data.quoteText
      : entityType === "engagement_reply" || entityType === "atlas_post"
        ? data.text
        : null;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function describePublicOutput(entityType: string, action: string): string {
  if (entityType === "campaign_engagement") return "campaign quote";
  if (entityType === "engagement_reply") return "contributor reply";
  if (entityType === "atlas_post") return "self-post";
  return action;
}

async function getRecentContributorSnapshots(db: any, now: Date) {
  try {
    const since = new Date(now.getTime() - 12 * 60 * 60 * 1000);
    const rows = await db
      .select({
        entityId: auditLog.entityId,
        newValue: auditLog.newValue,
        createdAt: auditLog.createdAt,
      })
      .from(auditLog)
      .where(
        and(
          gte(auditLog.createdAt, since),
          eq(auditLog.entityType, "campaign_contributor_snapshot"),
        ),
      )
      .orderBy(desc(auditLog.createdAt))
      .limit(10);

    const seen = new Set<string>();
    return rows
      .map((row: any) => {
        const data = row.newValue && typeof row.newValue === "object"
          ? row.newValue as Record<string, unknown>
          : {};
        const contributors = Array.isArray(data.contributors)
          ? data.contributors
              .map(readSnapshotContributor)
              .filter(Boolean)
          : [];
        const key = typeof data.campaignId === "string" ? data.campaignId : row.entityId;
        if (seen.has(key) || contributors.length === 0) return null;
        seen.add(key);
        return {
          entityId: row.entityId,
          campaignId: typeof data.campaignId === "string" ? data.campaignId : null,
          source: typeof data.source === "string" ? data.source : "unknown",
          contributors,
          createdAt: row.createdAt,
        };
      })
      .filter(Boolean)
      .slice(0, 3);
  } catch {
    return [];
  }
}

function readSnapshotContributor(input: unknown) {
  if (!input || typeof input !== "object") return null;
  const data = input as Record<string, unknown>;
  const username = typeof data.username === "string" ? data.username : null;
  const text = typeof data.text === "string" ? data.text : null;
  if (!username || !text) return null;
  return {
    rank: typeof data.rank === "number" ? data.rank : null,
    username,
    text,
  };
}

async function getContributorCount(db: any): Promise<number> {
  try {
    const result = await db.select({ n: count() }).from(contributors);
    return result[0]?.n || 0;
  } catch {
    return 0;
  }
}

async function getRecentErrors(db: any, now: Date) {
  try {
    const since = new Date(now.getTime() - 6 * 60 * 60 * 1000);
    return await db
      .select({
        action: auditLog.action,
        reason: auditLog.reason,
      })
      .from(auditLog)
      .where(
        and(
          gte(auditLog.createdAt, since),
          eq(auditLog.action, "error"),
        ),
      )
      .orderBy(desc(auditLog.createdAt))
      .limit(5);
  } catch {
    return [];
  }
}

async function getPendingChecks(db: any, now: Date) {
  try {
    return await db
      .select({
        checkType: outcomeChecks.checkType,
        scheduledFor: outcomeChecks.scheduledFor,
        campaignRunId: outcomeChecks.campaignRunId,
      })
      .from(outcomeChecks)
      .where(eq(outcomeChecks.status, "scheduled"))
      .orderBy(outcomeChecks.scheduledFor)
      .limit(5);
  } catch {
    return [];
  }
}

async function getTreasuryBalance(): Promise<string> {
  try {
    const treasuryAddress = process.env.ATLAS_TREASURY_WALLET_ADDRESS;
    const tokenAddress = process.env.ATLAS_CAMPAIGN_TOKEN_ADDRESS;
    if (!treasuryAddress || !tokenAddress) return "(unknown — env vars missing)";

    const rpcUrl = process.env.ATLAS_BASE_RPC_URL || "https://mainnet.base.org";
    const paddedAddr = treasuryAddress.replace("0x", "").padStart(64, "0");

    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_call",
        params: [{ to: tokenAddress, data: `0x70a08231${paddedAddr}` }, "latest"],
        id: 1,
      }),
    });

    const data: any = await res.json();
    const raw = BigInt(data.result || "0x0");
    const atl = Number(raw) / 1e18;
    const usd = atl * 0.0000017; // approximate — good enough for self-context
    return `${Math.round(atl).toLocaleString()} ATL (~$${usd.toFixed(0)})`;
  } catch {
    return "(balance check failed)";
  }
}
