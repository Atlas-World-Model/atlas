import {
  pgTable,
  text,
  timestamp,
  integer,
  jsonb,
  pgEnum,
} from "drizzle-orm/pg-core";
import { createId } from "../util.js";

export const questionTypeEnum = pgEnum("question_type", [
  "prediction",
  "decision",
  "diagnostic",
  "procedural",
  "evaluation",
  "question_generation",
]);

export const resolvabilityEnum = pgEnum("resolvability", [
  "verifiable_by_date",
  "verifiable_on_action",
  "subjective",
  "unknown",
]);

export const expectedActionEnum = pgEnum("expected_action", [
  "none",
  "memory_update",
  "follow_up_question",
  "build_skill",
  "build_tool",
  "run_experiment",
]);

export const questions = pgTable("questions", {
  id: text("id").primaryKey().$defaultFn(createId),
  campaignId: text("campaign_id"),
  farcasterCastHash: text("farcaster_cast_hash"),
  askerFid: integer("asker_fid"),
  text: text("text").notNull(),
  problem: text("problem"),
  currentBelief: text("current_belief"),
  successTest: text("success_test"),
  domainTags: jsonb("domain_tags").$type<string[]>().default([]),
  questionType: questionTypeEnum("question_type").notNull().default("decision"),
  resolvability: resolvabilityEnum("resolvability").notNull().default("unknown"),
  expectedAction: expectedActionEnum("expected_action").notNull().default("none"),
  resolutionTargetAt: timestamp("resolution_target_at", { withTimezone: true }),
  contextSnapshotId: text("context_snapshot_id"),
  askedAt: timestamp("asked_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Question = typeof questions.$inferSelect;
export type NewQuestion = typeof questions.$inferInsert;
