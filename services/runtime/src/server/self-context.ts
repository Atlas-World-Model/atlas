/**
 * Atlas self-context — builds a real-time snapshot of Atlas's own state.
 * Loaded into every Claude Code prompt so Atlas has full operational awareness.
 */

import { getDb, campaignRuns, questions, outcomes, contributors, contributorReputation, auditLog, outcomeChecks } from "../../../../packages/db/src/index.js";
import { eq, desc, and, gte, count, isNotNull } from "drizzle-orm";

export async function buildSelfContext(): Promise<string> {
  try {
    const db = getDb();
    const now = new Date();

    const [
      activeCampaigns,
      recentAuditEntries,
      contributorCount,
      treasuryBalance,
      recentErrors,
      pendingChecks,
    ] = await Promise.all([
      getActiveCampaigns(db),
      getRecentActivity(db, now),
      getContributorCount(db),
      getTreasuryBalance(),
      getRecentErrors(db, now),
      getPendingChecks(db, now),
    ]);

    const sections: string[] = [];

    // Active campaigns
    if (activeCampaigns.length > 0) {
      sections.push("Active campaigns:");
      for (const c of activeCampaigns) {
        const age = Math.floor((now.getTime() - new Date(c.createdAt).getTime()) / (1000 * 60 * 60));
        const ageStr = age < 24 ? `${age}h ago` : `${Math.floor(age / 24)}d ago`;
        sections.push(`  - ${c.campaignId || "unknown"}: stage=${c.lifecycleStage}, started ${ageStr}, action=${c.expectedAction}`);
        if (c.questionText) {
          sections.push(`    question: "${c.questionText.slice(0, 100)}"`);
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
        questionText: questions.text,
      })
      .from(campaignRuns)
      .leftJoin(questions, eq(campaignRuns.questionId, questions.id))
      .where(and(
        eq(campaignRuns.status, "active"),
        isNotNull(campaignRuns.atlasRunId),
      ))
      .orderBy(desc(campaignRuns.createdAt))
      .limit(5);
    return runs;
  } catch {
    return [];
  }
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
