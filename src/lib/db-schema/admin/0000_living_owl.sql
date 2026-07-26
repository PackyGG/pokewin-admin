-- Current sql file was generated after introspecting the database
-- If you want to run this migration please uncomment this code before executing migrations
/*
CREATE TYPE "public"."admin_role" AS ENUM('admin', 'support', 'marketing', 'creator', 'pack_creator', 'creator_manager');--> statement-breakpoint
CREATE TYPE "public"."deal_status" AS ENUM('pending', 'active', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."deal_type" AS ENUM('flat_fee', 'rev_share', 'hybrid', 'custom');--> statement-breakpoint
CREATE TYPE "public"."limit_period_type" AS ENUM('daily', 'weekly', 'monthly');--> statement-breakpoint
CREATE TYPE "public"."roadmap_status" AS ENUM('planned', 'in_progress', 'shipped', 'blocked', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."social_platform" AS ENUM('twitter', 'youtube', 'kick', 'discord', 'instagram');--> statement-breakpoint
CREATE TYPE "public"."webhook_type" AS ENUM('balance_fill', 'deal_data');--> statement-breakpoint
CREATE TABLE "_prisma_migrations" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"checksum" varchar(64) NOT NULL,
	"finished_at" timestamp with time zone,
	"migration_name" varchar(255) NOT NULL,
	"logs" text,
	"rolled_back_at" timestamp with time zone,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_steps_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "creator_webhooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_user_id" text NOT NULL,
	"url" text NOT NULL,
	"secret" text NOT NULL,
	"type" "webhook_type" NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "creator_deals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_user_id" text NOT NULL,
	"deal_type" "deal_type" NOT NULL,
	"amount" numeric(20, 2) NOT NULL,
	"currency" varchar(10) DEFAULT 'USD' NOT NULL,
	"start_date" timestamp(6) with time zone NOT NULL,
	"end_date" timestamp(6) with time zone,
	"status" "deal_status" DEFAULT 'active' NOT NULL,
	"notes" text,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"deal_name" text,
	"daily_fill_amount" numeric(20, 2),
	"daily_fill_time" varchar(5),
	"daily_fill_enabled" boolean DEFAULT false NOT NULL,
	"keep_percentage" numeric(5, 4),
	"leaderboard_prize_pool" numeric(20, 2),
	"leaderboard_our_share" numeric(5, 4),
	"leaderboard_frequency" varchar(20),
	"min_stream_minutes" integer,
	"max_financial_exposure" numeric(20, 2),
	"currency_limit_amount" numeric(20, 2),
	"currency_limit_reset_days" integer,
	"percentage_limit" numeric(5, 4),
	"tip_limit" numeric(20, 2),
	"tip_limit_reset_days" integer
);
--> statement-breakpoint
CREATE TABLE "admin_giveaway_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_user_id" uuid NOT NULL,
	"target_user_id" text NOT NULL,
	"amount_usd" numeric(20, 2) NOT NULL,
	"source_url" text NOT NULL,
	"source_type" text NOT NULL,
	"reason" text,
	"ledger_tx_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "creator_socials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_user_id" text NOT NULL,
	"platform" "social_platform" NOT NULL,
	"platform_user_id" text,
	"username" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"token_expires_at" timestamp(6) with time zone,
	"follower_count" integer,
	"last_fetched_at" timestamp(6) with time zone,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"subscriber_count" integer,
	"total_views" bigint,
	"avg_views_30d" integer,
	"avg_viewers" integer,
	"avg_viewers_30d" integer,
	"engagement_rate" numeric(5, 4),
	"likes_avg" integer,
	"stats_json" jsonb,
	"discord_channel_url" text,
	"reward_page_url" text,
	CONSTRAINT "creator_socials_target_user_id_platform_key" UNIQUE("platform","target_user_id")
);
--> statement-breakpoint
CREATE TABLE "admin_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "admin_role" DEFAULT 'admin' NOT NULL,
	"totp_secret" text,
	"totp_enabled" boolean DEFAULT false NOT NULL,
	"recovery_codes" text[],
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp(6) with time zone NOT NULL,
	"allowed_pages" text[],
	"display_username" text,
	"profile_image" "bytea",
	"profile_image_mime" text,
	"role_id" uuid,
	"preferences" jsonb,
	"roles" "admin_role"[] DEFAULT '{}' NOT NULL,
	"permission_grants" text[] DEFAULT '{}' NOT NULL,
	"permission_revokes" text[] DEFAULT '{}' NOT NULL,
	"sessions_valid_after" timestamp with time zone,
	"is_owner" boolean DEFAULT false NOT NULL,
	"totp_last_step" bigint
);
--> statement-breakpoint
CREATE TABLE "admin_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_user_id" uuid NOT NULL,
	"ip" text,
	"user_agent" text,
	"auth_method" text,
	"logged_in_at" timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"expires_at" timestamp(6) with time zone NOT NULL,
	"logged_out_at" timestamp(6) with time zone
);
--> statement-breakpoint
CREATE TABLE "admin_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_user_id" uuid NOT NULL,
	"target_user_id" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp(6) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_user_id" uuid,
	"event_type" text NOT NULL,
	"target_user_id" text,
	"ip" text,
	"metadata" jsonb,
	"created_at" timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_gift_card_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"gift_card_id" uuid NOT NULL,
	"action" text NOT NULL,
	"admin_user_id" uuid NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_voucher_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"voucher_id" uuid NOT NULL,
	"action" text NOT NULL,
	"admin_user_id" uuid NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"webhook_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status_code" integer,
	"response" text,
	"success" boolean NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "creator_balance_fills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_user_id" text NOT NULL,
	"deal_id" uuid,
	"amount" numeric(20, 2) NOT NULL,
	"status" text DEFAULT 'completed' NOT NULL,
	"triggered_by" text DEFAULT 'cron' NOT NULL,
	"webhook_sent" boolean DEFAULT false NOT NULL,
	"webhook_error" text,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"description" text NOT NULL,
	"amount" numeric(20, 2) NOT NULL,
	"date" date NOT NULL,
	"paid_to" text NOT NULL,
	"payment_method" text NOT NULL,
	"notes" text,
	"created_by_id" uuid NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"category" text NOT NULL,
	"paid_by" text
);
--> statement-breakpoint
CREATE TABLE "recurring_expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"amount" numeric(20, 2) NOT NULL,
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by_id" uuid NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"category" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_balance_limits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_user_id" text NOT NULL,
	"period_type" "limit_period_type" NOT NULL,
	"max_amount" numeric(12, 2) NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_by" text,
	CONSTRAINT "admin_balance_limits_admin_user_id_period_type_key" UNIQUE("admin_user_id","period_type")
);
--> statement-breakpoint
CREATE TABLE "admin_shifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"week_start" timestamp(6) with time zone NOT NULL,
	"day_of_week" integer NOT NULL,
	"shift_slot" integer NOT NULL,
	"start_at" timestamp(6) with time zone NOT NULL,
	"end_at" timestamp(6) with time zone NOT NULL,
	"notes" text,
	"created_by_id" uuid,
	"created_at" timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp(6) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_shift_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shift_id" uuid NOT NULL,
	"admin_user_id" uuid NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "salary_employees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"discord_name" text NOT NULL,
	"eth_address" text NOT NULL,
	"salary_usdt" numeric(20, 6) NOT NULL,
	"max_per_payout" numeric(20, 6),
	"active" boolean DEFAULT true NOT NULL,
	"last_paid_at" timestamp(6) with time zone,
	"notes" text,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(6) with time zone NOT NULL,
	"created_by_id" uuid,
	"cadence" text DEFAULT 'monthly' NOT NULL,
	"pay_day_of_week" smallint,
	"pay_day_of_month" smallint
);
--> statement-breakpoint
CREATE TABLE "salary_payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"amount_usdt" numeric(20, 6) NOT NULL,
	"to_address" text NOT NULL,
	"tx_hash" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"error_message" text,
	"broadcast_at" timestamp(6) with time zone,
	"confirmed_at" timestamp(6) with time zone,
	"failed_at" timestamp(6) with time zone,
	"paid_by_id" uuid,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "salary_payouts_tx_hash_key" UNIQUE("tx_hash")
);
--> statement-breakpoint
CREATE TABLE "excluded_users" (
	"user_id" text PRIMARY KEY NOT NULL,
	"reason" text,
	"excluded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_leaderboard_sponsorship" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"leaderboard_id" text NOT NULL,
	"sponsored_percentage" numeric(5, 2) NOT NULL,
	"set_by_admin_id" uuid NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employee_board_placements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"workspace_id" uuid,
	"roles" text[] DEFAULT '{}' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(6) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employee_workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(6) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employee_managers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(6) with time zone NOT NULL,
	CONSTRAINT "employee_managers_employee_id_key" UNIQUE("employee_id")
);
--> statement-breakpoint
CREATE TABLE "employee_manager_workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"manager_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employee_manager_workspaces_manager_id_workspace_id_key" UNIQUE("manager_id","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "salary_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"payment_link" text NOT NULL,
	"paid_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"created_by_id" uuid NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_changelog_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"published_at" timestamp(6) with time zone NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"version" text,
	"category" text NOT NULL,
	"changes" jsonb NOT NULL,
	"author_admin_user_id" uuid,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(6) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_user_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_user_id" text NOT NULL,
	"tag" text NOT NULL,
	"set_by_admin_id" uuid,
	"created_at" timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "admin_user_tags_tag_value_check" CHECK (tag = ANY (ARRAY['vip'::text, 'wager_abuser'::text]))
);
--> statement-breakpoint
CREATE TABLE "admin_balance_adjustment_wipes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"username" varchar(255),
	"email" varchar(255),
	"wiped_at" timestamp(6) DEFAULT now() NOT NULL,
	"wiped_by" varchar(36) NOT NULL,
	"total_amount" numeric(20, 2) NOT NULL,
	"balance_before" numeric(20, 2) NOT NULL,
	"balance_after" numeric(20, 2) NOT NULL,
	"adjustment_count" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"restored_at" timestamp(6),
	"restored_by" varchar(36),
	"status" varchar(16) DEFAULT 'completed' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_account_wipes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wipe_type" varchar(32) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"username" varchar(255),
	"email" varchar(255),
	"wiped_at" timestamp(6) DEFAULT now() NOT NULL,
	"wiped_by" varchar(36) NOT NULL,
	"amount" numeric(20, 2) DEFAULT '0' NOT NULL,
	"item_count" integer DEFAULT 0 NOT NULL,
	"snapshot" jsonb NOT NULL,
	"restored_at" timestamp(6),
	"restored_by" varchar(36),
	"status" varchar(16) DEFAULT 'completed' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_balance_adjustment_meta" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_user_id" varchar(36) NOT NULL,
	"target_user_id" varchar(36) NOT NULL,
	"ledger_tx_id" varchar(36) NOT NULL,
	"category" varchar(40) NOT NULL,
	"amount_usd" numeric(20, 2) NOT NULL,
	"coin_type" varchar(64),
	"tx_hash" varchar(255),
	"social_link" varchar(2048),
	"reason_text" text,
	"lossback_pct" numeric(7, 2),
	"pnl_7d_usd" numeric(20, 2),
	"created_at" timestamp(6) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_leaderboard_creator_paid" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"leaderboard_id" text NOT NULL,
	"paid" boolean DEFAULT false NOT NULL,
	"paid_at" timestamp(6) with time zone,
	"set_by_admin_id" uuid NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_excluded_user_balance_v2" (
	"target_user_id" text PRIMARY KEY NOT NULL,
	"balance_v2" numeric(20, 2) NOT NULL,
	"set_by_admin_id" uuid,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "kick_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"kick_user_id" text,
	"display_name" text,
	"avatar_url" text,
	"bio" text,
	"follower_count" integer,
	"is_verified" boolean,
	"is_live" boolean DEFAULT false NOT NULL,
	"raw_json" jsonb,
	"last_fetched_at" timestamp(6) with time zone,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kick_streams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"kick_stream_id" text NOT NULL,
	"title" text,
	"category" text,
	"thumbnail_url" text,
	"started_at" timestamp(6) with time zone,
	"ended_at" timestamp(6) with time zone,
	"duration_seconds" integer,
	"vod_views" integer,
	"peak_viewers" integer,
	"vod_url" text,
	"raw_json" jsonb,
	"last_fetched_at" timestamp(6) with time zone,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "twitter_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"twitter_user_id" text,
	"display_name" text,
	"avatar_url" text,
	"bio" text,
	"follower_count" integer,
	"following_count" integer,
	"tweet_count" integer,
	"is_verified" boolean,
	"raw_json" jsonb,
	"last_fetched_at" timestamp(6) with time zone,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tweets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"tweet_id" text NOT NULL,
	"text" text NOT NULL,
	"like_count" integer,
	"retweet_count" integer,
	"reply_count" integer,
	"view_count" integer,
	"mentions_us" boolean DEFAULT false NOT NULL,
	"url" text,
	"posted_at" timestamp(6) with time zone,
	"raw_json" jsonb,
	"last_fetched_at" timestamp(6) with time zone,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "twitter_mentions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"tweet_id" text NOT NULL,
	"text" text NOT NULL,
	"matched_keyword" text,
	"url" text,
	"posted_at" timestamp(6) with time zone,
	"last_fetched_at" timestamp(6) with time zone,
	"raw_json" jsonb,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "creator_onboarding_checklist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_user_id" text NOT NULL,
	"lb_funds_collected" boolean DEFAULT false NOT NULL,
	"lb_funds_collected_at" timestamp(6) with time zone,
	"twitter_giveaway_done" boolean DEFAULT false NOT NULL,
	"twitter_giveaway_url" text,
	"streaming_assets_provided" boolean DEFAULT false NOT NULL,
	"lb_prepaid_coin" text,
	"lb_prepaid_tx_url" text,
	"completed_at" timestamp(6) with time zone,
	"updated_by" uuid,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "creator_crm" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_user_id" text NOT NULL,
	"account_owner_id" uuid,
	"stage" text DEFAULT 'onboarding' NOT NULL,
	"onboarded_by" uuid,
	"onboarded_at" timestamp(6) with time zone,
	"next_followup_at" timestamp(6) with time zone,
	"updated_by" uuid,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "creator_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_user_id" text,
	"alert_type" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"severity" text DEFAULT 'info' NOT NULL,
	"metadata" jsonb,
	"read_at" timestamp(6) with time zone,
	"read_by" uuid,
	"dismissed_at" timestamp(6) with time zone,
	"dismissed_by" uuid,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "creator_session_meta" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" text NOT NULL,
	"target_user_id" text NOT NULL,
	"kick_vod_url" text,
	"notes" text,
	"updated_by" uuid,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_deleted_users" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"username" varchar(255),
	"email" varchar(255),
	"deleted_at" timestamp(6) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"deleted_by" varchar(36) NOT NULL,
	"expires_at" timestamp(6) NOT NULL,
	"snapshot" jsonb NOT NULL,
	"restored_at" timestamp(6),
	"restored_by" varchar(36)
);
--> statement-breakpoint
CREATE TABLE "crypto_fee_profit_counter" (
	"id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	"count_start_at" timestamp(6) with time zone NOT NULL,
	"deposit_fee_bps" numeric(7, 4) NOT NULL,
	"withdrawal_fee_bps" numeric(7, 4) NOT NULL,
	"total_fee_usd" numeric(20, 2) DEFAULT '0' NOT NULL,
	"deposit_fee_usd" numeric(20, 2) DEFAULT '0' NOT NULL,
	"withdrawal_fee_usd" numeric(20, 2) DEFAULT '0' NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pack_set_assignments" (
	"pack_id" uuid PRIMARY KEY NOT NULL,
	"pack_set" text NOT NULL,
	"set_by_admin_id" uuid,
	"created_at" timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_system" boolean DEFAULT false NOT NULL,
	"capabilities" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp(6) with time zone NOT NULL,
	"system_key" "admin_role",
	"balance_limit_daily" numeric(12, 2),
	"balance_limit_weekly" numeric(12, 2),
	"balance_limit_monthly" numeric(12, 2),
	"issuance_limit_daily" numeric(12, 2),
	"issuance_limit_weekly" numeric(12, 2),
	"issuance_limit_monthly" numeric(12, 2),
	"landing_route" text
);
--> statement-breakpoint
CREATE TABLE "roadmap_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" "roadmap_status" DEFAULT 'planned' NOT NULL,
	"start_date" timestamp(6) with time zone,
	"end_date" timestamp(6) with time zone,
	"color" text,
	"body" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"archived_at" timestamp(6) with time zone,
	"created_at" timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roadmap_detail_fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"label" text NOT NULL,
	"value" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roadmap_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"label" text NOT NULL,
	"url" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roadmap_linear_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"linear_issue_id" text NOT NULL,
	"identifier" text NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"state_name" text,
	"state_type" text,
	"state_color" text,
	"assignee_name" text,
	"synced_at" timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_passkeys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_user_id" uuid NOT NULL,
	"credential_id" text NOT NULL,
	"public_key" "bytea" NOT NULL,
	"counter" bigint DEFAULT 0 NOT NULL,
	"transports" text[] DEFAULT '{}' NOT NULL,
	"device_name" text,
	"backed_up" boolean DEFAULT false NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp(6) with time zone,
	CONSTRAINT "admin_passkeys_credential_id_key" UNIQUE("credential_id")
);
--> statement-breakpoint
CREATE TABLE "pack_risk_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pack_id" text NOT NULL,
	"edge" numeric(8, 4) NOT NULL,
	"cv" numeric(8, 4) NOT NULL,
	"win_rate" numeric(6, 4) NOT NULL,
	"near_miss" numeric(6, 4) NOT NULL,
	"max_win" numeric(20, 2) NOT NULL,
	"max_mult" numeric(12, 4) NOT NULL,
	"risk_score" integer NOT NULL,
	"tier" text NOT NULL,
	"compliance" jsonb NOT NULL,
	"computed_at" timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pack_retune_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pack_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"proposed_price" numeric(20, 2) NOT NULL,
	"proposed_pool" jsonb NOT NULL,
	"computed_risk" jsonb NOT NULL,
	"source_snapshot" jsonb NOT NULL,
	"notes" text,
	"created_by" uuid NOT NULL,
	"last_edited_by" uuid NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"last_edited_at" timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"pushed_at" timestamp(6) with time zone,
	"pushed_by" uuid,
	"discarded_at" timestamp(6) with time zone,
	"discarded_by" uuid
);
--> statement-breakpoint
CREATE TABLE "admin_withdrawal_unlocks" (
	"target_user_id" text PRIMARY KEY NOT NULL,
	"unlocked_by" uuid,
	"unlocked_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "pack_state_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pack_id" text NOT NULL,
	"captured_at" timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"captured_by" uuid NOT NULL,
	"action" text NOT NULL,
	"price" numeric(20, 2) NOT NULL,
	"cards" jsonb NOT NULL,
	"risk" jsonb,
	"note" text,
	"tags" jsonb
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"expires_at" timestamp(6) with time zone,
	"last_used_at" timestamp(6) with time zone,
	"last_used_ip" text,
	"request_count" integer DEFAULT 0 NOT NULL,
	"rate_limit_per_min" integer DEFAULT 120 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp(6) with time zone,
	"revoked_by" uuid,
	"allowed_ips" text[] DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discord_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"discord_user_id" text NOT NULL,
	"user_id" text NOT NULL,
	"first_verified_at" timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"last_verified_at" timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"verify_count" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "creator_reward_programs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"creator_user_id" text NOT NULL,
	"codes" text[] DEFAULT '{}',
	"threshold_usd" numeric(20, 2),
	"reward_usd" numeric(20, 2),
	"is_active" boolean DEFAULT true NOT NULL,
	"accrual_start_at" timestamp(6) with time zone NOT NULL,
	"max_reward_per_user_usd" numeric(20, 2),
	"created_by" uuid NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"vip_reward_usd" numeric(20, 2),
	"lossback_pct" numeric(6, 2),
	"min_deposit_usd" numeric(20, 2)
);
--> statement-breakpoint
CREATE TABLE "creator_reward_program_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" uuid NOT NULL,
	"started_at" timestamp(6) with time zone NOT NULL,
	"ended_at" timestamp(6) with time zone
);
--> statement-breakpoint
CREATE TABLE "creator_reward_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"discord_user_id" text,
	"wager_basis_usd" numeric(20, 2) NOT NULL,
	"prior_consumed_usd" numeric(20, 2) NOT NULL,
	"consumed_wager_usd" numeric(20, 2) NOT NULL,
	"units" integer NOT NULL,
	"amount_usd" numeric(20, 2) NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_at" timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp(6) with time zone,
	"review_note" text,
	"ledger_tx_id" uuid,
	"forfeited_wager_usd" numeric(20, 2) DEFAULT '0' NOT NULL,
	"lifetime_wager_usd" numeric(20, 2) DEFAULT '0' NOT NULL,
	"run_started_at" timestamp(6) with time zone,
	"applied_reward_usd" numeric(20, 2) DEFAULT '0' NOT NULL,
	"was_vip" boolean DEFAULT false NOT NULL,
	"reinstated_at" timestamp(6) with time zone,
	"reinstated_by" uuid,
	"ftd_deposit_usd" numeric(20, 2),
	"ftd_loss_usd" numeric(20, 2),
	"leg" text DEFAULT 'wager' NOT NULL,
	"bot_notified_at" timestamp(6) with time zone,
	"bot_notify_error" text
);
--> statement-breakpoint
CREATE TABLE "chat_raffle_rounds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"starts_at" timestamp(6) with time zone NOT NULL,
	"ends_at" timestamp(6) with time zone NOT NULL,
	"points_per_message" integer DEFAULT 1 NOT NULL,
	"min_message_chars" integer DEFAULT 3 NOT NULL,
	"bucket_minutes" integer DEFAULT 10 NOT NULL,
	"max_messages_per_bucket" integer DEFAULT 10 NOT NULL,
	"dedupe_identical" boolean DEFAULT true NOT NULL,
	"draw_seed" text,
	"drawn_at" timestamp(6) with time zone,
	"drawn_by" uuid,
	"entrants_at_draw" integer,
	"tickets_at_draw" integer,
	"created_by" uuid,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_raffle_prizes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"round_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"amount_usd" numeric(20, 2) NOT NULL,
	"label" text,
	"winner_user_id" text,
	"winner_username" text,
	"winner_tickets" integer,
	"winning_ticket" bigint,
	"paid_at" timestamp(6) with time zone,
	"paid_by" uuid,
	"ledger_tx_id" text,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_raffle_prizes_round_position_unique" UNIQUE("position","round_id")
);
--> statement-breakpoint
CREATE TABLE "chat_raffle_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"round_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"username" text,
	"message_count" integer DEFAULT 0 NOT NULL,
	"base_points" integer DEFAULT 0 NOT NULL,
	"adjustment_points" integer DEFAULT 0 NOT NULL,
	"tickets" integer DEFAULT 0 NOT NULL,
	"ticket_start" bigint DEFAULT 0 NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_raffle_entries_round_user_unique" UNIQUE("round_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "chat_raffle_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"round_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"points" integer NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_stepup_used" (
	"jti" text PRIMARY KEY NOT NULL,
	"admin_user_id" uuid NOT NULL,
	"used_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_profiles" (
	"admin_user_id" uuid PRIMARY KEY NOT NULL,
	"display_name" text,
	"title" text,
	"bio" text,
	"accent" text DEFAULT 'blue' NOT NULL,
	"points_total" integer DEFAULT 0 NOT NULL,
	"level" integer DEFAULT 1 NOT NULL,
	"quizzes_completed" integer DEFAULT 0 NOT NULL,
	"reviews_resolved" integer DEFAULT 0 NOT NULL,
	"last_seen_at" timestamp(6) with time zone,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_point_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_user_id" uuid NOT NULL,
	"points" integer NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" uuid,
	"reason" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"href" text,
	"metadata" jsonb,
	"read_at" timestamp(6) with time zone,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_notification_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_user_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"target" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"verified_at" timestamp(6) with time zone,
	"verification_code" text,
	"verification_sent_at" timestamp(6) with time zone,
	"verify_attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"last_sent_at" timestamp(6) with time zone,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_notification_prefs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"in_app" boolean DEFAULT true NOT NULL,
	"discord" boolean DEFAULT true NOT NULL,
	"telegram" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_quizzes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"points_per_correct" integer DEFAULT 1 NOT NULL,
	"pass_percent" integer DEFAULT 70 NOT NULL,
	"max_attempts" integer DEFAULT 1 NOT NULL,
	"time_limit_seconds" integer,
	"shuffle_questions" boolean DEFAULT false NOT NULL,
	"audience_roles" text[] DEFAULT '{}' NOT NULL,
	"created_by" uuid,
	"published_at" timestamp(6) with time zone,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_quiz_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quiz_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"prompt" text NOT NULL,
	"kind" text DEFAULT 'single' NOT NULL,
	"explanation" text,
	"points" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_quiz_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"label" text NOT NULL,
	"is_correct" boolean DEFAULT false NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_quiz_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quiz_id" uuid NOT NULL,
	"admin_user_id" uuid NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"max_score" integer DEFAULT 0 NOT NULL,
	"correct_count" integer DEFAULT 0 NOT NULL,
	"question_count" integer DEFAULT 0 NOT NULL,
	"points_awarded" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp(6) with time zone
);
--> statement-breakpoint
CREATE TABLE "staff_quiz_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"selected_option_ids" uuid[] DEFAULT '{}' NOT NULL,
	"is_correct" boolean DEFAULT false NOT NULL,
	"points_awarded" integer DEFAULT 0 NOT NULL,
	"answered_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "antifraud_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_user_id" text NOT NULL,
	"target_username" text,
	"status" text DEFAULT 'open' NOT NULL,
	"severity" text DEFAULT 'medium' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"risk_score" integer,
	"reason" text NOT NULL,
	"signals" text[] DEFAULT '{}' NOT NULL,
	"assigned_to" uuid,
	"opened_by" uuid,
	"resolution" text,
	"resolved_by" uuid,
	"resolved_at" timestamp(6) with time zone,
	"metadata" jsonb,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "antifraud_review_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_id" uuid NOT NULL,
	"admin_user_id" uuid,
	"kind" text DEFAULT 'note' NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "antifraud_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_id" text,
	"kind" text NOT NULL,
	"severity" text DEFAULT 'medium' NOT NULL,
	"risk_score" integer,
	"target_user_id" text,
	"target_username" text,
	"summary" text NOT NULL,
	"payload" jsonb,
	"review_id" uuid,
	"received_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admin_giveaway_actions" ADD CONSTRAINT "admin_giveaway_actions_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "admin_users" ADD CONSTRAINT "admin_users_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "public"."admin_roles"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "admin_notes" ADD CONSTRAINT "admin_notes_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "admin_audit_events" ADD CONSTRAINT "admin_audit_events_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "admin_gift_card_actions" ADD CONSTRAINT "admin_gift_card_actions_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "admin_voucher_actions" ADD CONSTRAINT "admin_voucher_actions_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "recurring_expenses" ADD CONSTRAINT "recurring_expenses_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "admin_shifts" ADD CONSTRAINT "admin_shifts_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "admin_shift_assignments" ADD CONSTRAINT "admin_shift_assignments_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "public"."admin_shifts"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "admin_shift_assignments" ADD CONSTRAINT "admin_shift_assignments_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "salary_employees" ADD CONSTRAINT "salary_employees_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "salary_payouts" ADD CONSTRAINT "salary_payouts_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "public"."salary_employees"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "salary_payouts" ADD CONSTRAINT "salary_payouts_paid_by_id_fkey" FOREIGN KEY ("paid_by_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "excluded_users" ADD CONSTRAINT "excluded_users_excluded_by_fkey" FOREIGN KEY ("excluded_by") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "employee_board_placements" ADD CONSTRAINT "employee_board_placements_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."employee_workspaces"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "employee_manager_workspaces" ADD CONSTRAINT "employee_manager_workspaces_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "public"."employee_managers"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "employee_manager_workspaces" ADD CONSTRAINT "employee_manager_workspaces_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."employee_workspaces"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "salary_payments" ADD CONSTRAINT "salary_payments_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "public"."salary_employees"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "admin_user_tags" ADD CONSTRAINT "admin_user_tags_set_by_admin_id_fkey" FOREIGN KEY ("set_by_admin_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "admin_excluded_user_balance_v2" ADD CONSTRAINT "admin_excluded_user_balance_v2_set_by_admin_id_fkey" FOREIGN KEY ("set_by_admin_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "roadmap_detail_fields" ADD CONSTRAINT "roadmap_detail_fields_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "public"."roadmap_items"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "roadmap_links" ADD CONSTRAINT "roadmap_links_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "public"."roadmap_items"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "roadmap_linear_links" ADD CONSTRAINT "roadmap_linear_links_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "public"."roadmap_items"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "admin_passkeys" ADD CONSTRAINT "admin_passkeys_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "admin_withdrawal_unlocks" ADD CONSTRAINT "admin_withdrawal_unlocks_unlocked_by_fkey" FOREIGN KEY ("unlocked_by") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "creator_reward_program_windows" ADD CONSTRAINT "creator_reward_program_windows_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "public"."creator_reward_programs"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "creator_reward_claims" ADD CONSTRAINT "creator_reward_claims_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "public"."creator_reward_programs"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "chat_raffle_rounds" ADD CONSTRAINT "chat_raffle_rounds_drawn_by_fkey" FOREIGN KEY ("drawn_by") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_raffle_rounds" ADD CONSTRAINT "chat_raffle_rounds_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_raffle_prizes" ADD CONSTRAINT "chat_raffle_prizes_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "public"."chat_raffle_rounds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_raffle_prizes" ADD CONSTRAINT "chat_raffle_prizes_paid_by_fkey" FOREIGN KEY ("paid_by") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_raffle_entries" ADD CONSTRAINT "chat_raffle_entries_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "public"."chat_raffle_rounds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_raffle_adjustments" ADD CONSTRAINT "chat_raffle_adjustments_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "public"."chat_raffle_rounds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_raffle_adjustments" ADD CONSTRAINT "chat_raffle_adjustments_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_point_events" ADD CONSTRAINT "staff_point_events_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_notifications" ADD CONSTRAINT "staff_notifications_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_notification_channels" ADD CONSTRAINT "staff_notification_channels_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_notification_prefs" ADD CONSTRAINT "staff_notification_prefs_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_quiz_questions" ADD CONSTRAINT "staff_quiz_questions_quiz_id_fkey" FOREIGN KEY ("quiz_id") REFERENCES "public"."staff_quizzes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_quiz_options" ADD CONSTRAINT "staff_quiz_options_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "public"."staff_quiz_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_quiz_attempts" ADD CONSTRAINT "staff_quiz_attempts_quiz_id_fkey" FOREIGN KEY ("quiz_id") REFERENCES "public"."staff_quizzes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_quiz_attempts" ADD CONSTRAINT "staff_quiz_attempts_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_quiz_answers" ADD CONSTRAINT "staff_quiz_answers_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "public"."staff_quiz_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_quiz_answers" ADD CONSTRAINT "staff_quiz_answers_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "public"."staff_quiz_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "antifraud_review_notes" ADD CONSTRAINT "antifraud_review_notes_review_id_fkey" FOREIGN KEY ("review_id") REFERENCES "public"."antifraud_reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "antifraud_signals" ADD CONSTRAINT "antifraud_signals_review_id_fkey" FOREIGN KEY ("review_id") REFERENCES "public"."antifraud_reviews"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "creator_webhooks_target_user_id_idx" ON "creator_webhooks" USING btree ("target_user_id" text_ops);--> statement-breakpoint
CREATE INDEX "creator_deals_target_user_id_idx" ON "creator_deals" USING btree ("target_user_id" text_ops);--> statement-breakpoint
CREATE INDEX "admin_giveaway_actions_created_at_idx" ON "admin_giveaway_actions" USING btree ("created_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "admin_giveaway_actions_target_user_id_idx" ON "admin_giveaway_actions" USING btree ("target_user_id" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "admin_users_email_key" ON "admin_users" USING btree ("email" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "admin_users_username_key" ON "admin_users" USING btree ("username" text_ops);--> statement-breakpoint
CREATE INDEX "admin_sessions_active_partial_idx" ON "admin_sessions" USING btree ("expires_at" timestamptz_ops) WHERE (logged_out_at IS NULL);--> statement-breakpoint
CREATE INDEX "admin_audit_events_admin_user_id_idx" ON "admin_audit_events" USING btree ("admin_user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "admin_audit_events_created_at_idx" ON "admin_audit_events" USING btree ("created_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "admin_audit_events_event_type_idx" ON "admin_audit_events" USING btree ("event_type" text_ops);--> statement-breakpoint
CREATE INDEX "admin_audit_events_target_user_id_idx" ON "admin_audit_events" USING btree ("target_user_id" text_ops);--> statement-breakpoint
CREATE INDEX "admin_gift_card_actions_gift_card_id_idx" ON "admin_gift_card_actions" USING btree ("gift_card_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "admin_voucher_actions_voucher_id_idx" ON "admin_voucher_actions" USING btree ("voucher_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "webhook_deliveries_created_at_idx" ON "webhook_deliveries" USING btree ("created_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "webhook_deliveries_webhook_id_idx" ON "webhook_deliveries" USING btree ("webhook_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "creator_balance_fills_created_at_idx" ON "creator_balance_fills" USING btree ("created_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "creator_balance_fills_target_user_id_idx" ON "creator_balance_fills" USING btree ("target_user_id" text_ops);--> statement-breakpoint
CREATE INDEX "expenses_category_idx" ON "expenses" USING btree ("category" text_ops);--> statement-breakpoint
CREATE INDEX "expenses_date_idx" ON "expenses" USING btree ("date" date_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "admin_shifts_week_start_day_of_week_shift_slot_key" ON "admin_shifts" USING btree ("week_start" int4_ops,"day_of_week" timestamptz_ops,"shift_slot" int4_ops);--> statement-breakpoint
CREATE INDEX "admin_shifts_week_start_idx" ON "admin_shifts" USING btree ("week_start" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "admin_shift_assignments_admin_user_id_idx" ON "admin_shift_assignments" USING btree ("admin_user_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "admin_shift_assignments_shift_id_admin_user_id_key" ON "admin_shift_assignments" USING btree ("shift_id" uuid_ops,"admin_user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "salary_employees_active_idx" ON "salary_employees" USING btree ("active" bool_ops);--> statement-breakpoint
CREATE INDEX "salary_payouts_created_at_idx" ON "salary_payouts" USING btree ("created_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "salary_payouts_employee_id_idx" ON "salary_payouts" USING btree ("employee_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "salary_payouts_status_idx" ON "salary_payouts" USING btree ("status" text_ops);--> statement-breakpoint
CREATE INDEX "excluded_users_created_at_idx" ON "excluded_users" USING btree ("created_at" timestamptz_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "admin_leaderboard_sponsorship_leaderboard_id_key" ON "admin_leaderboard_sponsorship" USING btree ("leaderboard_id" text_ops);--> statement-breakpoint
CREATE INDEX "employee_board_placements_employee_id_idx" ON "employee_board_placements" USING btree ("employee_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "employee_board_placements_employee_id_workspace_id_key" ON "employee_board_placements" USING btree ("employee_id" uuid_ops,"workspace_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "employee_board_placements_workspace_id_idx" ON "employee_board_placements" USING btree ("workspace_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "employee_manager_workspaces_manager_id_idx" ON "employee_manager_workspaces" USING btree ("manager_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "employee_manager_workspaces_workspace_id_idx" ON "employee_manager_workspaces" USING btree ("workspace_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "salary_payments_employee_id_idx" ON "salary_payments" USING btree ("employee_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "salary_payments_paid_at_idx" ON "salary_payments" USING btree ("paid_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "admin_changelog_entries_published_at_idx" ON "admin_changelog_entries" USING btree ("published_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "admin_user_tags_tag_idx" ON "admin_user_tags" USING btree ("tag" text_ops);--> statement-breakpoint
CREATE INDEX "admin_user_tags_target_user_id_idx" ON "admin_user_tags" USING btree ("target_user_id" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "admin_user_tags_user_tag_unique" ON "admin_user_tags" USING btree ("target_user_id" text_ops,"tag" text_ops);--> statement-breakpoint
CREATE INDEX "admin_balance_adjustment_wipes_user_id_idx" ON "admin_balance_adjustment_wipes" USING btree ("user_id" text_ops);--> statement-breakpoint
CREATE INDEX "admin_balance_adjustment_wipes_wiped_at_idx" ON "admin_balance_adjustment_wipes" USING btree ("wiped_at" timestamp_ops);--> statement-breakpoint
CREATE INDEX "admin_account_wipes_user_id_idx" ON "admin_account_wipes" USING btree ("user_id" text_ops);--> statement-breakpoint
CREATE INDEX "admin_account_wipes_wiped_at_idx" ON "admin_account_wipes" USING btree ("wiped_at" timestamp_ops);--> statement-breakpoint
CREATE INDEX "admin_balance_adjustment_meta_category_idx" ON "admin_balance_adjustment_meta" USING btree ("category" text_ops);--> statement-breakpoint
CREATE INDEX "admin_balance_adjustment_meta_created_at_idx" ON "admin_balance_adjustment_meta" USING btree ("created_at" timestamp_ops);--> statement-breakpoint
CREATE INDEX "admin_balance_adjustment_meta_ledger_tx_id_idx" ON "admin_balance_adjustment_meta" USING btree ("ledger_tx_id" text_ops);--> statement-breakpoint
CREATE INDEX "admin_balance_adjustment_meta_target_user_id_idx" ON "admin_balance_adjustment_meta" USING btree ("target_user_id" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "admin_leaderboard_creator_paid_leaderboard_id_key" ON "admin_leaderboard_creator_paid" USING btree ("leaderboard_id" text_ops);--> statement-breakpoint
CREATE INDEX "admin_excluded_user_balance_v2_set_at_idx" ON "admin_excluded_user_balance_v2" USING btree ("set_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "kick_profiles_last_fetched_at_idx" ON "kick_profiles" USING btree ("last_fetched_at" timestamptz_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "kick_profiles_username_key" ON "kick_profiles" USING btree ("username" text_ops);--> statement-breakpoint
CREATE INDEX "kick_streams_username_started_idx" ON "kick_streams" USING btree ("username" timestamptz_ops,"started_at" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "kick_streams_username_stream_unique" ON "kick_streams" USING btree ("username" text_ops,"kick_stream_id" text_ops);--> statement-breakpoint
CREATE INDEX "twitter_profiles_last_fetched_at_idx" ON "twitter_profiles" USING btree ("last_fetched_at" timestamptz_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "twitter_profiles_username_key" ON "twitter_profiles" USING btree ("username" text_ops);--> statement-breakpoint
CREATE INDEX "tweets_username_mentions_posted_idx" ON "tweets" USING btree ("username" text_ops,"mentions_us" bool_ops,"posted_at" text_ops);--> statement-breakpoint
CREATE INDEX "tweets_username_posted_idx" ON "tweets" USING btree ("username" timestamptz_ops,"posted_at" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "tweets_username_tweet_id_key" ON "tweets" USING btree ("username" text_ops,"tweet_id" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "tweets_username_tweet_unique" ON "tweets" USING btree ("username" text_ops,"tweet_id" text_ops);--> statement-breakpoint
CREATE INDEX "twitter_mentions_posted_idx" ON "twitter_mentions" USING btree ("posted_at" timestamptz_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "twitter_mentions_tweet_unique" ON "twitter_mentions" USING btree ("tweet_id" text_ops);--> statement-breakpoint
CREATE INDEX "twitter_mentions_username_posted_idx" ON "twitter_mentions" USING btree ("username" text_ops,"posted_at" text_ops);--> statement-breakpoint
CREATE INDEX "creator_onboarding_checklist_completed_idx" ON "creator_onboarding_checklist" USING btree ("completed_at" timestamptz_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "creator_onboarding_checklist_target_user_id_key" ON "creator_onboarding_checklist" USING btree ("target_user_id" text_ops);--> statement-breakpoint
CREATE INDEX "creator_crm_account_owner_idx" ON "creator_crm" USING btree ("account_owner_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "creator_crm_stage_idx" ON "creator_crm" USING btree ("stage" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "creator_crm_target_user_id_key" ON "creator_crm" USING btree ("target_user_id" text_ops);--> statement-breakpoint
CREATE INDEX "creator_alerts_active_idx" ON "creator_alerts" USING btree ("dismissed_at" timestamptz_ops,"severity" timestamptz_ops,"created_at" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "creator_alerts_dedupe_key_key" ON "creator_alerts" USING btree ("dedupe_key" text_ops);--> statement-breakpoint
CREATE INDEX "creator_alerts_target_user_idx" ON "creator_alerts" USING btree ("target_user_id" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "creator_session_meta_session_id_key" ON "creator_session_meta" USING btree ("session_id" text_ops);--> statement-breakpoint
CREATE INDEX "creator_session_meta_target_user_idx" ON "creator_session_meta" USING btree ("target_user_id" text_ops);--> statement-breakpoint
CREATE INDEX "admin_deleted_users_deleted_at_idx" ON "admin_deleted_users" USING btree ("deleted_at" timestamp_ops);--> statement-breakpoint
CREATE INDEX "admin_deleted_users_expires_at_idx" ON "admin_deleted_users" USING btree ("expires_at" timestamp_ops);--> statement-breakpoint
CREATE INDEX "pack_set_assignments_pack_set_idx" ON "pack_set_assignments" USING btree ("pack_set" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "admin_roles_name_key" ON "admin_roles" USING btree ("name" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "admin_roles_system_key_key" ON "admin_roles" USING btree ("system_key" enum_ops);--> statement-breakpoint
CREATE INDEX "roadmap_items_active_idx" ON "roadmap_items" USING btree ("archived_at" timestamptz_ops,"start_date" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "roadmap_items_range_idx" ON "roadmap_items" USING btree ("start_date" timestamptz_ops,"end_date" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "roadmap_detail_fields_item_idx" ON "roadmap_detail_fields" USING btree ("item_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "roadmap_links_item_idx" ON "roadmap_links" USING btree ("item_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "roadmap_linear_links_item_idx" ON "roadmap_linear_links" USING btree ("item_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "roadmap_linear_links_item_issue_key" ON "roadmap_linear_links" USING btree ("item_id" text_ops,"linear_issue_id" text_ops);--> statement-breakpoint
CREATE INDEX "admin_passkeys_admin_user_id_idx" ON "admin_passkeys" USING btree ("admin_user_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "pack_risk_scores_pack_id_key" ON "pack_risk_scores" USING btree ("pack_id" text_ops);--> statement-breakpoint
CREATE INDEX "pack_retune_drafts_created_at_idx" ON "pack_retune_drafts" USING btree ("created_at" timestamptz_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "pack_retune_drafts_one_pending_per_pack" ON "pack_retune_drafts" USING btree ("pack_id" uuid_ops) WHERE (status = 'draft'::text);--> statement-breakpoint
CREATE INDEX "pack_retune_drafts_pack_id_idx" ON "pack_retune_drafts" USING btree ("pack_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "pack_retune_drafts_status_edited_idx" ON "pack_retune_drafts" USING btree ("status" timestamptz_ops,"last_edited_at" text_ops);--> statement-breakpoint
CREATE INDEX "admin_withdrawal_unlocks_unlocked_at_idx" ON "admin_withdrawal_unlocks" USING btree ("unlocked_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "pack_state_snapshots_action_pack_idx" ON "pack_state_snapshots" USING btree ("action" text_ops,"pack_id" text_ops);--> statement-breakpoint
CREATE INDEX "pack_state_snapshots_pack_captured_idx" ON "pack_state_snapshots" USING btree ("pack_id" text_ops,"captured_at" text_ops);--> statement-breakpoint
CREATE INDEX "api_keys_created_at_idx" ON "api_keys" USING btree ("created_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "api_keys_is_active_idx" ON "api_keys" USING btree ("is_active" bool_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_prefix_key" ON "api_keys" USING btree ("prefix" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "discord_verifications_discord_user_id_key" ON "discord_verifications" USING btree ("discord_user_id" text_ops);--> statement-breakpoint
CREATE INDEX "discord_verifications_first_verified_idx" ON "discord_verifications" USING btree ("first_verified_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "discord_verifications_user_id_idx" ON "discord_verifications" USING btree ("user_id" text_ops);--> statement-breakpoint
CREATE INDEX "creator_reward_programs_creator_idx" ON "creator_reward_programs" USING btree ("creator_user_id" text_ops);--> statement-breakpoint
CREATE INDEX "creator_reward_programs_is_active_idx" ON "creator_reward_programs" USING btree ("is_active" bool_ops);--> statement-breakpoint
CREATE INDEX "creator_reward_program_windows_program_idx" ON "creator_reward_program_windows" USING btree ("program_id" timestamptz_ops,"started_at" timestamptz_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "creator_reward_claims_one_pending_per_user" ON "creator_reward_claims" USING btree ("program_id" uuid_ops,"user_id" text_ops,"leg" uuid_ops) WHERE (status = 'pending'::text);--> statement-breakpoint
CREATE INDEX "creator_reward_claims_program_user_idx" ON "creator_reward_claims" USING btree ("program_id" uuid_ops,"user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "creator_reward_claims_status_requested_idx" ON "creator_reward_claims" USING btree ("status" timestamptz_ops,"requested_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "creator_reward_claims_user_idx" ON "creator_reward_claims" USING btree ("user_id" text_ops);--> statement-breakpoint
CREATE INDEX "chat_raffle_rounds_ends_at_idx" ON "chat_raffle_rounds" USING btree ("ends_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "chat_raffle_rounds_status_idx" ON "chat_raffle_rounds" USING btree ("status" text_ops);--> statement-breakpoint
CREATE INDEX "chat_raffle_prizes_round_idx" ON "chat_raffle_prizes" USING btree ("round_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "chat_raffle_entries_round_position_idx" ON "chat_raffle_entries" USING btree ("round_id" uuid_ops,"position" uuid_ops);--> statement-breakpoint
CREATE INDEX "chat_raffle_adjustments_round_idx" ON "chat_raffle_adjustments" USING btree ("round_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "chat_raffle_adjustments_round_user_idx" ON "chat_raffle_adjustments" USING btree ("round_id" text_ops,"user_id" text_ops);--> statement-breakpoint
CREATE INDEX "admin_stepup_used_used_at_idx" ON "admin_stepup_used" USING btree ("used_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "staff_profiles_points_idx" ON "staff_profiles" USING btree ("points_total" int4_ops);--> statement-breakpoint
CREATE INDEX "staff_point_events_created_idx" ON "staff_point_events" USING btree ("created_at" timestamptz_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "staff_point_events_source_uniq" ON "staff_point_events" USING btree ("source_kind" text_ops,"source_id" text_ops) WHERE ((source_id IS NOT NULL) AND (source_kind <> 'manual'::text));--> statement-breakpoint
CREATE INDEX "staff_point_events_user_created_idx" ON "staff_point_events" USING btree ("admin_user_id" timestamptz_ops,"created_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "staff_notifications_user_created_idx" ON "staff_notifications" USING btree ("admin_user_id" timestamptz_ops,"created_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "staff_notifications_user_unread_idx" ON "staff_notifications" USING btree ("admin_user_id" uuid_ops) WHERE (read_at IS NULL);--> statement-breakpoint
CREATE UNIQUE INDEX "staff_notification_channels_user_channel_uniq" ON "staff_notification_channels" USING btree ("admin_user_id" text_ops,"channel" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "staff_notification_prefs_user_kind_uniq" ON "staff_notification_prefs" USING btree ("admin_user_id" text_ops,"kind" text_ops);--> statement-breakpoint
CREATE INDEX "staff_quizzes_status_created_idx" ON "staff_quizzes" USING btree ("status" text_ops,"created_at" text_ops);--> statement-breakpoint
CREATE INDEX "staff_quiz_questions_quiz_position_idx" ON "staff_quiz_questions" USING btree ("quiz_id" int4_ops,"position" int4_ops);--> statement-breakpoint
CREATE INDEX "staff_quiz_options_question_position_idx" ON "staff_quiz_options" USING btree ("question_id" int4_ops,"position" int4_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "staff_quiz_attempts_open_uniq" ON "staff_quiz_attempts" USING btree ("quiz_id" uuid_ops,"admin_user_id" uuid_ops) WHERE (status = 'in_progress'::text);--> statement-breakpoint
CREATE INDEX "staff_quiz_attempts_quiz_idx" ON "staff_quiz_attempts" USING btree ("quiz_id" uuid_ops,"submitted_at" uuid_ops);--> statement-breakpoint
CREATE INDEX "staff_quiz_attempts_user_started_idx" ON "staff_quiz_attempts" USING btree ("admin_user_id" uuid_ops,"started_at" timestamptz_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "staff_quiz_answers_attempt_question_uniq" ON "staff_quiz_answers" USING btree ("attempt_id" uuid_ops,"question_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "antifraud_reviews_assigned_idx" ON "antifraud_reviews" USING btree ("assigned_to" uuid_ops,"created_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "antifraud_reviews_created_idx" ON "antifraud_reviews" USING btree ("created_at" timestamptz_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "antifraud_reviews_open_target_uniq" ON "antifraud_reviews" USING btree ("target_user_id" text_ops) WHERE (status = ANY (ARRAY['open'::text, 'in_review'::text]));--> statement-breakpoint
CREATE INDEX "antifraud_reviews_status_created_idx" ON "antifraud_reviews" USING btree ("status" timestamptz_ops,"created_at" text_ops);--> statement-breakpoint
CREATE INDEX "antifraud_reviews_target_idx" ON "antifraud_reviews" USING btree ("target_user_id" text_ops);--> statement-breakpoint
CREATE INDEX "antifraud_review_notes_review_created_idx" ON "antifraud_review_notes" USING btree ("review_id" timestamptz_ops,"created_at" timestamptz_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "antifraud_signals_external_uniq" ON "antifraud_signals" USING btree ("external_id" text_ops) WHERE (external_id IS NOT NULL);--> statement-breakpoint
CREATE INDEX "antifraud_signals_received_idx" ON "antifraud_signals" USING btree ("received_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "antifraud_signals_target_idx" ON "antifraud_signals" USING btree ("target_user_id" text_ops);
*/