import { eq, and, lte } from "drizzle-orm";
import type { Db } from "../../db/src/index.js";
import {
  campaignRuns,
  outcomeChecks,
  auditLog,
  type CampaignRun,
  type NewOutcomeCheck,
  createId,
} from "../../db/src/index.js";

type LifecycleStage = CampaignRun["lifecycleStage"];

const VALID_TRANSITIONS: Record<string, LifecycleStage[]> = {
  ask: ["collect"],
  collect: ["synthesize"],
  synthesize: ["build_test", "evaluate", "remember", "closed"],
  build_test: ["evaluate"],
  evaluate: ["iterate", "remember", "closed"],
  iterate: ["evaluate", "remember", "closed"],
  remember: ["closed"],
};

const BUILD_ACTIONS = new Set(["build_skill", "build_tool", "run_experiment"]);

export async function transitionCampaign(
  db: Db,
  campaignRunId: string,
  nextStage: LifecycleStage,
  reason: string,
): Promise<CampaignRun> {
  const run = await db.query.campaignRuns.findFirst({
    where: eq(campaignRuns.id, campaignRunId),
  });

  if (!run) throw new Error(`Campaign run ${campaignRunId} not found`);

  if (run.lifecycleStage === nextStage) {
    return run;
  }

  const allowed = VALID_TRANSITIONS[run.lifecycleStage];
  if (!allowed?.includes(nextStage)) {
    throw new Error(
      `Invalid transition: ${run.lifecycleStage} -> ${nextStage}. Allowed: ${allowed?.join(", ")}`,
    );
  }

  // Guardrail: only build_skill/build_tool/run_experiment can enter build_test
  if (nextStage === "build_test" && !BUILD_ACTIONS.has(run.expectedAction)) {
    throw new Error(
      `Campaign expected_action "${run.expectedAction}" does not permit build_test stage`,
    );
  }

  const now = new Date();
  const timestamps: Partial<CampaignRun> = { updatedAt: now };

  if (nextStage === "synthesize") timestamps.synthesizedAt = now;
  if (nextStage === "build_test") timestamps.buildStartedAt = now;
  if (nextStage === "evaluate") timestamps.evaluatedAt = now;
  if (nextStage === "closed") timestamps.closedAt = now;

  const [updated] = await db
    .update(campaignRuns)
    .set({ lifecycleStage: nextStage, ...timestamps })
    .where(eq(campaignRuns.id, campaignRunId))
    .returning();

  await db.insert(auditLog).values({
    id: createId(),
    entityType: "campaign_run",
    entityId: campaignRunId,
    action: "status_changed",
    previousValue: { lifecycleStage: run.lifecycleStage },
    newValue: { lifecycleStage: nextStage },
    actor: "atlas_agent",
    reason,
  });

  return updated;
}

export async function initCampaignRun(
  db: Db,
  opts: {
    questionId: string;
    campaignId: string;
    atlasRunId: string;
    expectedAction: string;
    collectDays?: number;
  },
): Promise<CampaignRun> {
  const now = new Date();
  const collectEnds = new Date(now);
  collectEnds.setDate(collectEnds.getDate() + (opts.collectDays ?? 7));

  const existing = await db.query.campaignRuns.findFirst({
    where: eq(campaignRuns.campaignId, opts.campaignId),
  });

  if (existing) {
    await ensureOutcomeChecks(db, existing.id, existing.createdAt ?? now);
    if (existing.lifecycleStage === "ask") {
      return transitionCampaign(
        db,
        existing.id,
        "collect",
        "Campaign lifecycle initialized; collection opened",
      );
    }

    return existing;
  }

  const [run] = await db
    .insert(campaignRuns)
    .values({
      id: createId(),
      questionId: opts.questionId,
      campaignId: opts.campaignId,
      atlasRunId: opts.atlasRunId,
      expectedAction: opts.expectedAction as any,
      lifecycleStage: "collect",
      status: "active",
      askedAt: now,
      collectEndsAt: collectEnds,
    })
    .returning();

  await ensureOutcomeChecks(db, run.id, now);

  await db.insert(auditLog).values({
    id: createId(),
    entityType: "campaign_run",
    entityId: run.id,
    action: "created",
    newValue: { campaignId: opts.campaignId, expectedAction: opts.expectedAction },
    actor: "atlas_agent",
    reason: "Campaign lifecycle initialized; collection opened",
  });

  return run;
}

export async function getDueChecks(db: Db): Promise<Array<typeof outcomeChecks.$inferSelect>> {
  const now = new Date();
  return db
    .select()
    .from(outcomeChecks)
    .where(
      and(
        eq(outcomeChecks.status, "scheduled"),
        lte(outcomeChecks.scheduledFor, now),
      ),
    );
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

async function ensureOutcomeChecks(
  db: Db,
  campaignRunId: string,
  baseDate: Date,
): Promise<void> {
  const existing = await db
    .select({ checkType: outcomeChecks.checkType })
    .from(outcomeChecks)
    .where(eq(outcomeChecks.campaignRunId, campaignRunId));
  const existingTypes = new Set<NewOutcomeCheck["checkType"]>(
    existing.map((check) => check.checkType),
  );

  const checks: NewOutcomeCheck[] = [
    {
      id: createId(),
      campaignRunId,
      checkType: "day_7_synthesis" as const,
      dayOffset: 7,
      scheduledFor: addDays(baseDate, 7),
    },
    {
      id: createId(),
      campaignRunId,
      checkType: "day_30_evaluation" as const,
      dayOffset: 30,
      scheduledFor: addDays(baseDate, 30),
    },
    {
      id: createId(),
      campaignRunId,
      checkType: "day_90_final_label" as const,
      dayOffset: 90,
      scheduledFor: addDays(baseDate, 90),
    },
  ].filter((check) => !existingTypes.has(check.checkType));

  if (checks.length > 0) {
    await db.insert(outcomeChecks).values(checks);
  }
}
