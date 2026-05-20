import {
  pgTable,
  text,
  timestamp,
  boolean,
  pgEnum,
} from "drizzle-orm/pg-core";
import { createId } from "../util.js";
import { answers } from "./answers.js";

export const claimTypeEnum = pgEnum("claim_type", [
  "factual",
  "predictive",
  "causal",
  "procedural",
  "normative",
]);

export const claimVerdictEnum = pgEnum("claim_verdict", [
  "correct",
  "incorrect",
  "partially_correct",
  "unverifiable",
  "pending",
]);

export const claims = pgTable("claims", {
  id: text("id").primaryKey().$defaultFn(createId),
  answerId: text("answer_id").notNull().references(() => answers.id),
  text: text("text").notNull(),
  claimType: claimTypeEnum("claim_type").notNull().default("factual"),
  checkable: boolean("checkable").default(false),
  checkMethod: text("check_method"),
  verdict: claimVerdictEnum("claim_verdict").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Claim = typeof claims.$inferSelect;
export type NewClaim = typeof claims.$inferInsert;
