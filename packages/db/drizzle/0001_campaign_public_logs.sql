CREATE TABLE "campaign_public_pages" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_run_id" text NOT NULL,
	"campaign_id" text NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'published' NOT NULL,
	"body_markdown" text DEFAULT '' NOT NULL,
	"snapshot_json" jsonb DEFAULT '{}'::jsonb,
	"last_generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_public_events" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_run_id" text NOT NULL,
	"campaign_id" text NOT NULL,
	"event_type" text NOT NULL,
	"source" text NOT NULL,
	"body_markdown" text DEFAULT '' NOT NULL,
	"snapshot_json" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campaign_public_pages" ADD CONSTRAINT "campaign_public_pages_campaign_run_id_campaign_runs_id_fk" FOREIGN KEY ("campaign_run_id") REFERENCES "public"."campaign_runs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "campaign_public_events" ADD CONSTRAINT "campaign_public_events_campaign_run_id_campaign_runs_id_fk" FOREIGN KEY ("campaign_run_id") REFERENCES "public"."campaign_runs"("id") ON DELETE no action ON UPDATE no action;
