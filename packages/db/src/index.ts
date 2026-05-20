export * from "./schema/index.js";
export * from "./client.js";
export * from "./util.js";

// Legacy types kept for backward compat with existing workers
export type AtlasRunStatus = "queued" | "running" | "completed" | "failed";
export type AtlasTriggerType =
  | "schedule"
  | "campaign_created"
  | "campaign_closed"
  | "evaluation"
  | "compaction"
  | "heartbeat"
  | "system";

export type AtlasArtifactStatus =
  | "draft"
  | "published"
  | "committed"
  | "superseded"
  | "failed";

export interface AtlasRunRecord {
  id: string;
  triggerType: AtlasTriggerType;
  triggerSource?: string | null;
  status: AtlasRunStatus;
  idempotencyKey?: string | null;
  contextSnapshot: Record<string, unknown>;
  error?: string | null;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export interface AtlasArtifactRecord {
  id: string;
  runId: string;
  artifactType:
    | "campaign_brief"
    | "reward_set_snapshot"
    | "point_allocation_rationale"
    | "memory_patch"
    | "compaction_diff"
    | "analysis"
    | "heartbeat";
  title: string;
  status: AtlasArtifactStatus;
  textPayload?: string | null;
  jsonPayload?: Record<string, unknown> | null;
  worldPath?: string | null;
  createdAt: string;
}

export interface AtlasEventRecord {
  id: string;
  runId?: string | null;
  eventType: string;
  summary: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface AtlasCostLedgerEntry {
  id: string;
  runId?: string | null;
  category: "cognition" | "campaign" | "distribution" | "hosting";
  amountUsd: number;
  units?: number | null;
  unitLabel?: string | null;
  source: string;
  createdAt: string;
}

export interface AtlasQualityEvaluation {
  id: string;
  artifactId: string;
  score: 1 | 2 | 3 | 4 | 5;
  flags: Array<"empty" | "stale_data" | "unsupported_claim" | "low_signal" | "format_error">;
  rationale: string;
  createdAt: string;
}
