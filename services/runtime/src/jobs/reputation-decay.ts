import { getDb } from "../../../../packages/db/src/index.js";
import { applyTimeDecay } from "../../../../packages/agent/src/index.js";

export async function runReputationDecay(): Promise<void> {
  const db = getDb();
  const updated = await applyTimeDecay(db);
  if (updated > 0) {
    console.log(`[reputation] Decayed ${updated} records`);
  }
}
