import { and, desc, eq, gte, sql } from "drizzle-orm";
import { auditLog, createId, getDb } from "../../../../packages/db/src/index.js";

interface ActionLeaseInput {
  entityType: string;
  entityId: string;
  reason: string;
  pendingTtlMinutes?: number;
  successCooldownHours?: number;
  successActions?: string[];
  newValue?: unknown;
}

export interface ActionLease {
  id: string;
  entityType: string;
  entityId: string;
  fail: (error: unknown) => Promise<void>;
}

const DEFAULT_PENDING_TTL_MINUTES = 15;
const DEFAULT_SUCCESS_COOLDOWN_HOURS = 1;
const DEFAULT_SUCCESS_ACTIONS = ["posted", "replied", "published", "completed"];

export async function claimActionLease(input: ActionLeaseInput): Promise<ActionLease | null> {
  const db = getDb();
  const pendingTtlMinutes = input.pendingTtlMinutes ?? DEFAULT_PENDING_TTL_MINUTES;
  const successCooldownHours = input.successCooldownHours ?? DEFAULT_SUCCESS_COOLDOWN_HOURS;
  const successActions = new Set(input.successActions ?? DEFAULT_SUCCESS_ACTIONS);
  const pendingCutoff = new Date(Date.now() - pendingTtlMinutes * 60 * 1000);
  const successCutoff = new Date(Date.now() - successCooldownHours * 60 * 60 * 1000);
  const since = pendingCutoff < successCutoff ? pendingCutoff : successCutoff;
  const lockKey = advisoryLockKey(`${input.entityType}:${input.entityId}`);

  const lockRows = await db.execute(sql<{ locked: boolean }>`select pg_try_advisory_lock(${lockKey}) as locked`);
  const locked = Boolean(lockRows[0]?.locked);
  if (!locked) return null;

  try {
    const recent = await db
      .select({ action: auditLog.action, createdAt: auditLog.createdAt })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, input.entityType),
          eq(auditLog.entityId, input.entityId),
          gte(auditLog.createdAt, since),
        ),
      )
      .orderBy(desc(auditLog.createdAt))
      .limit(20);

    const blocked = recent.some((row) => {
      const createdAt = row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt);
      if ((row.action === "pending" || row.action === "running") && createdAt >= pendingCutoff) return true;
      return successActions.has(row.action) && createdAt >= successCutoff;
    });
    if (blocked) return null;

    const id = createId();
    await db.insert(auditLog).values({
      id,
      entityType: input.entityType,
      entityId: input.entityId,
      action: "pending",
      newValue: {
        ...(input.newValue && typeof input.newValue === "object" && !Array.isArray(input.newValue) ? input.newValue : {}),
        pendingTtlMinutes,
        successCooldownHours,
        claimedAt: new Date().toISOString(),
      },
      actor: "atlas_agent",
      reason: input.reason,
    });

    return {
      id,
      entityType: input.entityType,
      entityId: input.entityId,
      fail: async (error: unknown) => {
        await db.insert(auditLog).values({
          id: createId(),
          entityType: input.entityType,
          entityId: input.entityId,
          action: "failed",
          previousValue: { leaseId: id },
          newValue: {
            error: error instanceof Error ? error.message : String(error),
            failedAt: new Date().toISOString(),
          },
          actor: "atlas_agent",
          reason: input.reason,
        });
      },
    };
  } finally {
    await db.execute(sql`select pg_advisory_unlock(${lockKey})`);
  }
}

function advisoryLockKey(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash | 0;
}
