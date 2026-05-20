import {
  pgTable,
  text,
  timestamp,
  real,
  pgEnum,
} from "drizzle-orm/pg-core";
import { createId } from "../util.js";
import { questions } from "./questions.js";
import { answers } from "./answers.js";

export const outcomeTierEnum = pgEnum("outcome_tier", [
  "engagement",
  "behavioral",
  "ground_truth",
]);

export const outcomeVerdictEnum = pgEnum("outcome_verdict", [
  "correct",
  "incorrect",
  "partially_correct",
  "unverifiable",
  "pending",
]);

export const outcomeResolverEnum = pgEnum("outcome_resolver", [
  "system",
  "asker",
  "atlas_agent",
  "human_reviewer",
]);

export const outcomes = pgTable("outcomes", {
  id: text("id").primaryKey().$defaultFn(createId),
  questionId: text("question_id").notNull().references(() => questions.id),
  answerId: text("answer_id").references(() => answers.id),
  tier: outcomeTierEnum("tier").notNull(),
  verdict: outcomeVerdictEnum("verdict").notNull().default("pending"),
  score: real("score"), // -1 to 1
  confidence: real("confidence"), // 0 to 1
  evidence: text("evidence"),
  resolver: outcomeResolverEnum("resolver"),
  supersedesOutcomeId: text("supersedes_outcome_id"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Outcome = typeof outcomes.$inferSelect;
export type NewOutcome = typeof outcomes.$inferInsert;
