import {
  pgTable,
  text,
  timestamp,
  integer,
  pgEnum,
} from "drizzle-orm/pg-core";
import { createId } from "../util.js";
import { campaignRuns } from "./campaign-runs.js";

export const checkTypeEnum = pgEnum("check_type", [
  "day_7_synthesis",
  "day_30_evaluation",
  "day_90_final_label",
  "custom",
]);

export const checkStatusEnum = pgEnum("check_status", [
  "scheduled",
  "running",
  "completed",
  "skipped",
  "failed",
]);

export const outcomeChecks = pgTable("outcome_checks", {
  id: text("id").primaryKey().$defaultFn(createId),
  campaignRunId: text("campaign_run_id").notNull().references(() => campaignRuns.id),
  checkType: checkTypeEnum("check_type").notNull(),
  status: checkStatusEnum("check_status").notNull().default("scheduled"),
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  result: text("result"),
  dayOffset: integer("day_offset").notNull(), // days since campaign ask
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type OutcomeCheck = typeof outcomeChecks.$inferSelect;
export type NewOutcomeCheck = typeof outcomeChecks.$inferInsert;
