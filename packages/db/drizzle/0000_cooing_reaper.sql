CREATE TYPE "public"."campaign_run_status" AS ENUM('active', 'paused', 'completed', 'failed', 'retired');--> statement-breakpoint
CREATE TYPE "public"."lifecycle_stage" AS ENUM('ask', 'collect', 'synthesize', 'build_test', 'evaluate', 'iterate', 'remember', 'closed');--> statement-breakpoint
CREATE TYPE "public"."claim_type" AS ENUM('factual', 'predictive', 'causal', 'procedural', 'normative');--> statement-breakpoint
CREATE TYPE "public"."claim_verdict" AS ENUM('correct', 'incorrect', 'partially_correct', 'unverifiable', 'pending');--> statement-breakpoint
CREATE TYPE "public"."expected_action" AS ENUM('none', 'memory_update', 'follow_up_question', 'build_skill', 'build_tool', 'run_experiment');--> statement-breakpoint
CREATE TYPE "public"."question_type" AS ENUM('prediction', 'decision', 'diagnostic', 'procedural', 'evaluation', 'question_generation');--> statement-breakpoint
CREATE TYPE "public"."resolvability" AS ENUM('verifiable_by_date', 'verifiable_on_action', 'subjective', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."outcome_resolver" AS ENUM('system', 'asker', 'atlas_agent', 'human_reviewer');--> statement-breakpoint
CREATE TYPE "public"."outcome_tier" AS ENUM('engagement', 'behavioral', 'ground_truth');--> statement-breakpoint
CREATE TYPE "public"."outcome_verdict" AS ENUM('correct', 'incorrect', 'partially_correct', 'unverifiable', 'pending');--> statement-breakpoint
CREATE TYPE "public"."intervention_status" AS ENUM('planned', 'building', 'built', 'testing', 'deployed', 'effective', 'partially_effective', 'ineffective', 'retired');--> statement-breakpoint
CREATE TYPE "public"."intervention_type" AS ENUM('skill', 'dashboard', 'analysis', 'internal_tool', 'public_explainer', 'workflow_change', 'campaign_process_change', 'farcaster_behavior_change');--> statement-breakpoint
CREATE TYPE "public"."check_status" AS ENUM('scheduled', 'running', 'completed', 'skipped', 'failed');--> statement-breakpoint
CREATE TYPE "public"."check_type" AS ENUM('day_7_synthesis', 'day_30_evaluation', 'day_90_final_label', 'custom');--> statement-breakpoint
CREATE TABLE "answers" (
	"id" text PRIMARY KEY NOT NULL,
	"question_id" text NOT NULL,
	"farcaster_cast_hash" text,
	"responder_fid" integer,
	"text" text NOT NULL,
	"rationale_extracted" text,
	"confidence_signaled" text,
	"cites_sources" boolean DEFAULT false,
	"looti_rank" integer,
	"looti_score" text,
	"parent_answer_id" text,
	"claims" jsonb DEFAULT '[]'::jsonb,
	"responded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"action" text NOT NULL,
	"previous_value" jsonb,
	"new_value" jsonb,
	"actor" text DEFAULT 'atlas_agent' NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"question_id" text,
	"campaign_id" text,
	"atlas_run_id" text,
	"lifecycle_stage" "lifecycle_stage" DEFAULT 'ask' NOT NULL,
	"status" "campaign_run_status" DEFAULT 'active' NOT NULL,
	"expected_action" "expected_action" DEFAULT 'none' NOT NULL,
	"split_address" text,
	"funding_tx_hash" text,
	"synthesis_result" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"asked_at" timestamp with time zone,
	"collect_ends_at" timestamp with time zone,
	"synthesized_at" timestamp with time zone,
	"build_started_at" timestamp with time zone,
	"evaluated_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"id" text PRIMARY KEY NOT NULL,
	"answer_id" text NOT NULL,
	"text" text NOT NULL,
	"claim_type" "claim_type" DEFAULT 'factual' NOT NULL,
	"checkable" boolean DEFAULT false,
	"check_method" text,
	"claim_verdict" "claim_verdict" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "context_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL,
	"related_recent_casts" jsonb DEFAULT '[]'::jsonb,
	"active_contributors" jsonb DEFAULT '[]'::jsonb,
	"prior_interactions" jsonb DEFAULT '[]'::jsonb,
	"atlas_internal_state" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contributor_reputation" (
	"id" text PRIMARY KEY NOT NULL,
	"fid" integer NOT NULL,
	"domain" text DEFAULT 'global' NOT NULL,
	"score" real DEFAULT 0 NOT NULL,
	"sample_size" integer DEFAULT 0 NOT NULL,
	"confidence" real DEFAULT 0 NOT NULL,
	"decay_half_life_days" integer DEFAULT 180 NOT NULL,
	"last_updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contributors" (
	"fid" integer PRIMARY KEY NOT NULL,
	"display_name" text,
	"domains_active_in" jsonb DEFAULT '[]'::jsonb,
	"total_answers" integer DEFAULT 0 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "questions" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_id" text,
	"farcaster_cast_hash" text,
	"asker_fid" integer,
	"text" text NOT NULL,
	"problem" text,
	"current_belief" text,
	"success_test" text,
	"domain_tags" jsonb DEFAULT '[]'::jsonb,
	"question_type" "question_type" DEFAULT 'decision' NOT NULL,
	"resolvability" "resolvability" DEFAULT 'unknown' NOT NULL,
	"expected_action" "expected_action" DEFAULT 'none' NOT NULL,
	"resolution_target_at" timestamp with time zone,
	"context_snapshot_id" text,
	"asked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outcomes" (
	"id" text PRIMARY KEY NOT NULL,
	"question_id" text NOT NULL,
	"answer_id" text,
	"tier" "outcome_tier" NOT NULL,
	"verdict" "outcome_verdict" DEFAULT 'pending' NOT NULL,
	"score" real,
	"confidence" real,
	"evidence" text,
	"resolver" "outcome_resolver",
	"supersedes_outcome_id" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intervention_events" (
	"id" text PRIMARY KEY NOT NULL,
	"intervention_id" text NOT NULL,
	"event_type" text NOT NULL,
	"summary" text NOT NULL,
	"payload" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interventions" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_run_id" text NOT NULL,
	"type" "intervention_type" NOT NULL,
	"status" "intervention_status" DEFAULT 'planned' NOT NULL,
	"description" text NOT NULL,
	"scope_limit" text,
	"evaluation_plan" text,
	"rollback_condition" text,
	"owner" text DEFAULT 'atlas_agent' NOT NULL,
	"linked_evidence_ids" text,
	"built_at" timestamp with time zone,
	"deployed_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outcome_checks" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_run_id" text NOT NULL,
	"check_type" "check_type" NOT NULL,
	"check_status" "check_status" DEFAULT 'scheduled' NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"result" text,
	"day_offset" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "answers" ADD CONSTRAINT "answers_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_answer_id_answers_id_fk" FOREIGN KEY ("answer_id") REFERENCES "public"."answers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contributor_reputation" ADD CONSTRAINT "contributor_reputation_fid_contributors_fid_fk" FOREIGN KEY ("fid") REFERENCES "public"."contributors"("fid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcomes" ADD CONSTRAINT "outcomes_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcomes" ADD CONSTRAINT "outcomes_answer_id_answers_id_fk" FOREIGN KEY ("answer_id") REFERENCES "public"."answers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intervention_events" ADD CONSTRAINT "intervention_events_intervention_id_interventions_id_fk" FOREIGN KEY ("intervention_id") REFERENCES "public"."interventions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interventions" ADD CONSTRAINT "interventions_campaign_run_id_campaign_runs_id_fk" FOREIGN KEY ("campaign_run_id") REFERENCES "public"."campaign_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcome_checks" ADD CONSTRAINT "outcome_checks_campaign_run_id_campaign_runs_id_fk" FOREIGN KEY ("campaign_run_id") REFERENCES "public"."campaign_runs"("id") ON DELETE no action ON UPDATE no action;