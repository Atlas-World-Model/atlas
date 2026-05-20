import {
  pgTable,
  text,
  timestamp,
  jsonb,
  pgEnum,
} from "drizzle-orm/pg-core";
import { createId } from "../util.js";
import { expectedActionEnum } from "./questions.js";

export const lifecycleStageEnum = pgEnum("lifecycle_stage", [
  "ask",
  "collect",
  "synthesize",
  "build_test",
  "evaluate",
  "iterate",
  "remember",
  "closed",
]);

export const campaignRunStatusEnum = pgEnum("campaign_run_status", [
  "active",
  "paused",
  "completed",
  "failed",
  "retired",
]);

export const campaignRuns = pgTable("campaign_runs", {
  id: text("id").primaryKey().$defaultFn(createId),
  questionId: text("question_id"),
  campaignId: text("campaign_id"), // Looti campaign ID
  atlasRunId: text("atlas_run_id"),
  lifecycleStage: lifecycleStageEnum("lifecycle_stage").notNull().default("ask"),
  status: campaignRunStatusEnum("status").notNull().default("active"),
  expectedAction: expectedActionEnum("expected_action").notNull().default("none"),
  splitAddress: text("split_address"),
  fundingTxHash: text("funding_tx_hash"),
  synthesisResult: text("synthesis_result"), // "no_action" | "memory_only" | "follow_up" | "build" | "manual_review"
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  askedAt: timestamp("asked_at", { withTimezone: true }),
  collectEndsAt: timestamp("collect_ends_at", { withTimezone: true }),
  synthesizedAt: timestamp("synthesized_at", { withTimezone: true }),
  buildStartedAt: timestamp("build_started_at", { withTimezone: true }),
  evaluatedAt: timestamp("evaluated_at", { withTimezone: true }),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type CampaignRun = typeof campaignRuns.$inferSelect;
export type NewCampaignRun = typeof campaignRuns.$inferInsert;
