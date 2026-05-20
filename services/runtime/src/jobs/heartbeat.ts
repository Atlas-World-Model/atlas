import { runAtlasTick } from "../../../../packages/agent/src/index.js";
import { getDb, auditLog, createId } from "../../../../packages/db/src/index.js";

export async function runHeartbeat(): Promise<void> {
  const tick = await runAtlasTick();

  const db = getDb();
  await db.insert(auditLog).values({
    id: createId(),
    entityType: "system",
    entityId: "heartbeat",
    action: "heartbeat",
    newValue: {
      worldStateBytes: tick.worldStateBytes,
      configBytes: tick.configBytes,
      status: tick.heartbeat.status,
      checks: tick.heartbeat.checks.map((c) => `${c.name}:${c.status}`),
    },
    actor: "system",
    reason: "Scheduled heartbeat",
  });
}
