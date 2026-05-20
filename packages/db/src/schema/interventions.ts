import {
  pgTable,
  text,
  timestamp,
  pgEnum,
} from "drizzle-orm/pg-core";
import { createId } from "../util.js";
import { campaignRuns } from "./campaign-runs.js";

export const interventionTypeEnum = pgEnum("intervention_type", [
  "skill",
  "dashboard",
  "analysis",
  "internal_tool",
  "public_explainer",
  "workflow_change",
  "campaign_process_change",
  "farcaster_behavior_change",
]);

export const interventionStatusEnum = pgEnum("intervention_status", [
  "planned",
  "building",
  "built",
  "testing",
  "deployed",
  "effective",
  "partially_effective",
  "ineffective",
  "retired",
]);

export const interventions = pgTable("interventions", {
  id: text("id").primaryKey().$defaultFn(createId),
  campaignRunId: text("campaign_run_id").notNull().references(() => campaignRuns.id),
  type: interventionTypeEnum("type").notNull(),
  status: interventionStatusEnum("status").notNull().default("planned"),
  description: text("description").notNull(),
  scopeLimit: text("scope_limit"),
  evaluationPlan: text("evaluation_plan"),
  rollbackCondition: text("rollback_condition"),
  owner: text("owner").notNull().default("atlas_agent"), // "atlas_agent" | "human_operator" | "both"
  linkedEvidenceIds: text("linked_evidence_ids"), // comma-separated answer IDs
  builtAt: timestamp("built_at", { withTimezone: true }),
  deployedAt: timestamp("deployed_at", { withTimezone: true }),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const interventionEvents = pgTable("intervention_events", {
  id: text("id").primaryKey().$defaultFn(createId),
  interventionId: text("intervention_id").notNull().references(() => interventions.id),
  eventType: text("event_type").notNull(), // "status_change" | "feedback" | "metric" | "note"
  summary: text("summary").notNull(),
  payload: text("payload"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Intervention = typeof interventions.$inferSelect;
export type NewIntervention = typeof interventions.$inferInsert;
export type InterventionEvent = typeof interventionEvents.$inferSelect;
