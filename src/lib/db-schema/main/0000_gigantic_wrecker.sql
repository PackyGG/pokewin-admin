-- Current sql file was generated after introspecting the database
-- If you want to run this migration please uncomment this code before executing migrations
/*
CREATE TYPE "public"."affiliate_leaderboard_approval_status" AS ENUM('pending', 'approved', 'rejected', 'awaiting_funding');--> statement-breakpoint
CREATE TYPE "public"."affiliate_payout_status" AS ENUM('pending', 'processing', 'paid', 'failed');--> statement-breakpoint
CREATE TYPE "public"."affiliate_usage_type" AS ENUM('signup', 'deposit', 'wager');--> statement-breakpoint
CREATE TYPE "public"."audit_event_type" AS ENUM('login', 'login_failed', 'logout', 'register', 'register_failed', 'session_started', 'session_expired', 'kill_all_sessions', 'rate_limited', 'two_factor_enabled', 'two_factor_disabled', 'email_verification_sent', 'forgot_password_request', 'password_changed', 'password_reset', 'username_changed', 'email_updated', 'settings_changed', 'account_locked', 'account_unlocked', 'account_banned', 'account_unbanned', 'alt_account_detected', 'chat_muted', 'chat_unmuted', 'chat_banned', 'chat_unbanned', 'chat_message_deleted', 'chat_message_pinned', 'chat_message_unpinned', 'country_blocked', 'locked_deposits_crypto', 'locked_deposits_fiat', 'withdrawals_crypto_locked', 'withdrawals_crypto_unlocked', 'withdrawals_items_locked', 'withdrawals_items_unlocked', 'inventory_sales_locked', 'inventory_sales_unlocked', 'exchanges_locked', 'exchanges_unlocked', 'openings_locked', 'openings_unlocked', 'crypto_withdrawal_processed', 'error', 'admin_withdrawal_cancelled', 'admin_withdrawal_completed', 'admin_withdrawal_failed', 'affiliate_leaderboard_submitted', 'affiliate_leaderboard_approved', 'affiliate_leaderboard_rejected', 'affiliate_leaderboard_edited', 'affiliate_leaderboard_sponsored', 'affiliate_leaderboard_cancelled', 'affiliate_leaderboard_prize_claimed', 'creator_social_submitted', 'creator_social_approved', 'creator_social_rejected', 'creator_social_removed', 'role_changed', 'self_excluded', 'affiliate_leaderboard_hard_deleted', 'affiliate_leaderboard_claim_frozen', 'affiliate_leaderboard_claim_unfrozen', 'kyc_required', 'kyc_admin_reviewed', 'kyc_provider_result_received');--> statement-breakpoint
CREATE TYPE "public"."balance_currency" AS ENUM('real', 'coin');--> statement-breakpoint
CREATE TYPE "public"."battle_double_down_result" AS ENUM('win', 'lose');--> statement-breakpoint
CREATE TYPE "public"."battle_double_down_status" AS ENUM('offered', 'accepted', 'resolved', 'expired');--> statement-breakpoint
CREATE TYPE "public"."battle_mode" AS ENUM('normal', 'jackpot', 'group', 'hp_rush', 'lowest');--> statement-breakpoint
CREATE TYPE "public"."battle_status" AS ENUM('waiting', 'in_progress', 'animating', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."card_withdrawal_method" AS ENUM('physical', 'crypto', 'balance');--> statement-breakpoint
CREATE TYPE "public"."card_withdrawal_status" AS ENUM('pending', 'processing', 'shipped', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."challenge_claim_status" AS ENUM('eligible', 'claimed');--> statement-breakpoint
CREATE TYPE "public"."challenge_percent_op" AS ENUM('lte', 'gte', 'eq');--> statement-breakpoint
CREATE TYPE "public"."challenge_requirement_kind" AS ENUM('pack_pull', 'upgrader');--> statement-breakpoint
CREATE TYPE "public"."challenge_status" AS ENUM('active', 'inactive', 'archived');--> statement-breakpoint
CREATE TYPE "public"."challenge_type" AS ENUM('pack_pull', 'upgrader');--> statement-breakpoint
CREATE TYPE "public"."chat_message_embed_type" AS ENUM('battle');--> statement-breakpoint
CREATE TYPE "public"."coin_transaction_type" AS ENUM('coin_deposit_grant', 'coin_pack_bet', 'coin_pack_payout', 'coin_battle_bet', 'coin_battle_payout', 'coin_battle_refund', 'coin_upgrader_bet', 'coin_upgrader_payout', 'coin_admin_adjustment', 'coin_rain_tip', 'coin_rain_win', 'coin_keno_bet', 'coin_keno_payout');--> statement-breakpoint
CREATE TYPE "public"."creator_deal_status" AS ENUM('scheduled', 'active', 'completed', 'terminated');--> statement-breakpoint
CREATE TYPE "public"."creator_multiplier_deal_status" AS ENUM('pending_deposit', 'funded', 'live', 'pending_review', 'flagged', 'approved', 'rejected', 'cancelled', 'completed');--> statement-breakpoint
CREATE TYPE "public"."creator_pending_conversion_source" AS ENUM('battle_win', 'battle_refund');--> statement-breakpoint
CREATE TYPE "public"."creator_pending_conversion_status" AS ENUM('pending', 'claimed');--> statement-breakpoint
CREATE TYPE "public"."creator_social_platform" AS ENUM('twitch', 'kick', 'youtube', 'x', 'instagram', 'tiktok', 'discord');--> statement-breakpoint
CREATE TYPE "public"."creator_social_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."creator_stream_session_status" AS ENUM('active', 'ended', 'converted');--> statement-breakpoint
CREATE TYPE "public"."fingerprint_event_type" AS ENUM('login', 'signup');--> statement-breakpoint
CREATE TYPE "public"."game_session_result" AS ENUM('win', 'lose', 'draw');--> statement-breakpoint
CREATE TYPE "public"."game_type" AS ENUM('pack', 'battle', 'upgrader', 'battle_double_down', 'keno');--> statement-breakpoint
CREATE TYPE "public"."gift_card_region" AS ENUM('NA', 'EU');--> statement-breakpoint
CREATE TYPE "public"."keno_risk" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."kyc_admin_decision" AS ENUM('pending', 'safe', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."kyc_status" AS ENUM('none', 'pending', 'on_hold', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."ledger_transaction_status" AS ENUM('pending', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."ledger_transaction_type" AS ENUM('deposit', 'pack_opening', 'battle_bet', 'battle_sponsorship', 'battle_refund', 'card_sale', 'reward_card_sale', 'card_exchange', 'exchange_excess_to_voucher', 'exchange_excess_credit', 'battle_excess_to_voucher', 'voucher_redeemed', 'voucher_exchange', 'deposit_bonus', 'vault_lock', 'vault_unlock', 'race_prize', 'gift_card_redeemed', 'promo_code_redeemed', 'rakeback_claim', 'balance_reward_claim', 'affiliate_claim', 'withdrawal_shipping_fee', 'admin_balance_adjustment', 'rain_tip', 'rain_win', 'creator_tip', 'waitlist_prize', 'pack_borrow_to_voucher', 'card_withdrawal', 'creator_deal_fill_grant', 'creator_fill_activation', 'creator_fill_spend_tip', 'creator_fill_spend_battle', 'creator_fill_refund', 'creator_fill_conversion', 'creator_fill_forfeiture', 'affiliate_leaderboard_creation', 'affiliate_leaderboard_refund', 'affiliate_leaderboard_prize', 'creator_multiplier_deposit_lock', 'creator_multiplier_deposit_topup', 'creator_multiplier_platform_credit', 'creator_multiplier_spend_wager', 'creator_multiplier_spend_tip', 'creator_multiplier_spend_battle', 'creator_multiplier_refund', 'creator_multiplier_settlement_payout', 'creator_multiplier_settlement_deposit_return', 'creator_multiplier_forfeiture', 'creator_lb_deposit', 'upgrader_bet', 'upgrader_payout', 'balance_withdrawal', 'challenge_prize', 'xp_purchase', 'keno_bet', 'keno_payout');--> statement-breakpoint
CREATE TYPE "public"."notification_category" AS ENUM('transaction', 'rewards', 'system', 'news');--> statement-breakpoint
CREATE TYPE "public"."pack_tag" AS ENUM('%1', '%5', '%10', '50/50', 'onepiece');--> statement-breakpoint
CREATE TYPE "public"."race_type" AS ENUM('daily', 'weekly', 'monthly');--> statement-breakpoint
CREATE TYPE "public"."raffle_status" AS ENUM('active', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."rain_status" AS ENUM('active', 'drawing', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."rakeback_type" AS ENUM('daily', 'weekly', 'monthly');--> statement-breakpoint
CREATE TYPE "public"."region_code" AS ENUM('NA', 'EU');--> statement-breakpoint
CREATE TYPE "public"."reward_type" AS ENUM('one_time', 'daily', 'balance');--> statement-breakpoint
CREATE TYPE "public"."source_type" AS ENUM('pack', 'reward', 'battle', 'exchange', 'raffle', 'upgrader');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('user', 'support', 'admin', 'creator');--> statement-breakpoint
CREATE TYPE "public"."voucher_origin" AS ENUM('exchange_excess_to_voucher', 'battle_excess_to_voucher', 'pack_borrow_to_voucher', 'creator_fill_conversion', 'creator_multiplier_payout', 'upgrader_excess_to_voucher', 'battle_double_down_payout');--> statement-breakpoint
CREATE TABLE "affiliate_code_queue" (
	"user_id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "battles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"mode" "battle_mode" NOT NULL,
	"pack_ids" text[] NOT NULL,
	"teams" integer NOT NULL,
	"players_per_team" integer NOT NULL,
	"status" "battle_status" NOT NULL,
	"bet_amount" numeric(20, 2) NOT NULL,
	"winner_team" integer,
	"server_seed" text NOT NULL,
	"server_seed_hash" text NOT NULL,
	"eos_block_hash" text,
	"region_code" "region_code" DEFAULT 'NA' NOT NULL,
	"additional_settings" text[] DEFAULT '{}' NOT NULL,
	"animation_complete_at" timestamp,
	"password" text,
	"sponsorship_percentage" integer DEFAULT 0 NOT NULL,
	"sponsorship_amount_paid" numeric(20, 2) DEFAULT '0' NOT NULL,
	"borrow_percentage" integer DEFAULT 0 NOT NULL,
	"total_unpacked" numeric(20, 2),
	"pending_distribution_data" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"affiliated_only" boolean DEFAULT false NOT NULL,
	"affiliated_min_wager" numeric(20, 2) DEFAULT '0' NOT NULL,
	"currency" "balance_currency" DEFAULT 'real' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "battle_backgrounds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(100) NOT NULL,
	"image_url" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "battle_backgrounds_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "country_restrictions" (
	"country_code" text PRIMARY KEY NOT NULL,
	"blocked" boolean DEFAULT false NOT NULL,
	"physical_withdrawal" boolean DEFAULT true NOT NULL,
	"digital_withdrawal" boolean DEFAULT true NOT NULL,
	"gift_card_deposit" boolean DEFAULT true NOT NULL,
	"promo_code_deposit" boolean DEFAULT true NOT NULL,
	"locked_deposits_crypto" text[] DEFAULT '{}' NOT NULL,
	"locked_deposits_fiat" text[] DEFAULT '{}' NOT NULL,
	"locked_withdrawals_crypto" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deposit_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"vault_id" uuid NOT NULL,
	"asset_id" text NOT NULL,
	"address" text NOT NULL,
	"tag" text,
	"legacy_address" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rewards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"pack_ids" uuid[],
	"metadata" jsonb,
	"type" "reward_type" DEFAULT 'one_time' NOT NULL,
	"level_required" integer DEFAULT 0 NOT NULL,
	"cash_amount" numeric(10, 2),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"daily_unlock_percentage" numeric(6, 4),
	CONSTRAINT "rewards_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "provably_fair_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"game_session_id" uuid NOT NULL,
	"battle_id" uuid,
	"inventory_item_id" uuid,
	"client_seed" text NOT NULL,
	"server_seed" text,
	"server_seed_hash" text NOT NULL,
	"nonce" integer NOT NULL,
	"cursor" integer DEFAULT 0 NOT NULL,
	"ticket" integer NOT NULL,
	"result_hash" text NOT NULL,
	"result_metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipping_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"phone_country_code" text NOT NULL,
	"phone_number" text NOT NULL,
	"address_line_1" text NOT NULL,
	"address_line_2" text,
	"city" text NOT NULL,
	"zip_code" text NOT NULL,
	"state_province" text,
	"country" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "shipping_addresses_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "affiliate_leaderboard_prize_tiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"leaderboard_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"prize_amount_usd" numeric(20, 2) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "affiliate_leaderboard_prize_tiers_unique" UNIQUE("leaderboard_id","position")
);
--> statement-breakpoint
CREATE TABLE "creator_stream_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deal_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"status" "creator_stream_session_status" DEFAULT 'active' NOT NULL,
	"activated_at" timestamp DEFAULT now() NOT NULL,
	"first_bet_at" timestamp,
	"ended_at" timestamp,
	"converted_at" timestamp,
	"fill_loaded_usd" numeric(20, 2) NOT NULL,
	"fill_spent_usd" numeric(20, 2) DEFAULT '0' NOT NULL,
	"fill_refunded_usd" numeric(20, 2) DEFAULT '0' NOT NULL,
	"fill_remaining_usd" numeric(20, 2) NOT NULL,
	"ending_balance_usd" numeric(20, 2),
	"conversion_rate_bps_snapshot" integer,
	"converted_to_raw_usd" numeric(20, 2),
	"activation_ledger_id" uuid,
	"conversion_ledger_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"tips_spent_this_session_usd" numeric(20, 2) DEFAULT '0' NOT NULL,
	"sponsorship_spent_this_session_usd" numeric(20, 2) DEFAULT '0' NOT NULL,
	"auto_end_at" timestamp,
	CONSTRAINT "creator_stream_sessions_fill_non_negative" CHECK ((fill_loaded_usd >= (0)::numeric) AND (fill_spent_usd >= (0)::numeric) AND (fill_refunded_usd >= (0)::numeric) AND (fill_remaining_usd >= (0)::numeric)),
	CONSTRAINT "creator_stream_sessions_conversion_snapshot_range" CHECK ((conversion_rate_bps_snapshot IS NULL) OR ((conversion_rate_bps_snapshot >= 0) AND (conversion_rate_bps_snapshot <= 10000))),
	CONSTRAINT "creator_stream_sessions_spend_counters_non_negative" CHECK ((tips_spent_this_session_usd >= (0)::numeric) AND (sponsorship_spent_this_session_usd >= (0)::numeric))
);
--> statement-breakpoint
CREATE TABLE "creator_deals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"week_start_utc" timestamp NOT NULL,
	"week_end_utc" timestamp NOT NULL,
	"status" "creator_deal_status" DEFAULT 'scheduled' NOT NULL,
	"fills_allowed" integer NOT NULL,
	"fills_used" integer DEFAULT 0 NOT NULL,
	"per_fill_amount_usd" numeric(20, 2) NOT NULL,
	"conversion_rate_bps" integer NOT NULL,
	"cooldown_minutes" integer DEFAULT 240 NOT NULL,
	"max_tip_per_stream_usd" numeric(20, 2) NOT NULL,
	"max_tip_per_user_usd" numeric(20, 2) NOT NULL,
	"max_sponsored_battle_usd" numeric(20, 2) NOT NULL,
	"allow_site_leaderboards" boolean DEFAULT false NOT NULL,
	"allow_code_leaderboards" boolean DEFAULT false NOT NULL,
	"terms" jsonb,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"max_sponsorship_per_stream_usd" numeric(20, 2) NOT NULL,
	"total_withdraw_cap_usd" numeric(20, 2),
	"withdraw_cap_used_usd" numeric(20, 2) DEFAULT '0' NOT NULL,
	CONSTRAINT "creator_deals_user_week_unique" UNIQUE("user_id","week_start_utc"),
	CONSTRAINT "creator_deals_week_range" CHECK (week_end_utc > week_start_utc),
	CONSTRAINT "creator_deals_fills_allowed_positive" CHECK (fills_allowed > 0),
	CONSTRAINT "creator_deals_fills_used_range" CHECK ((fills_used >= 0) AND (fills_used <= fills_allowed)),
	CONSTRAINT "creator_deals_per_fill_amount_positive" CHECK (per_fill_amount_usd > (0)::numeric),
	CONSTRAINT "creator_deals_conversion_rate_range" CHECK ((conversion_rate_bps >= 0) AND (conversion_rate_bps <= 10000)),
	CONSTRAINT "creator_deals_cooldown_non_negative" CHECK (cooldown_minutes >= 0),
	CONSTRAINT "creator_deals_tip_limits_non_negative" CHECK ((max_tip_per_stream_usd >= (0)::numeric) AND (max_tip_per_user_usd >= (0)::numeric) AND (max_sponsored_battle_usd >= (0)::numeric)),
	CONSTRAINT "creator_deals_withdraw_cap_non_negative" CHECK ((total_withdraw_cap_usd IS NULL) OR (total_withdraw_cap_usd >= (0)::numeric)),
	CONSTRAINT "creator_deals_withdraw_cap_used_non_negative" CHECK (withdraw_cap_used_usd >= (0)::numeric),
	CONSTRAINT "creator_deals_withdraw_cap_used_within_total" CHECK ((total_withdraw_cap_usd IS NULL) OR (withdraw_cap_used_usd <= total_withdraw_cap_usd))
);
--> statement-breakpoint
CREATE TABLE "pinned_chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"pinned_by" text NOT NULL,
	"pinned_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "pinned_chat_messages_message_id_unique" UNIQUE("message_id")
);
--> statement-breakpoint
CREATE TABLE "_affiliate_migrations" (
	"name" text PRIMARY KEY NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "creator_multiplier_deals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"status" "creator_multiplier_deal_status" DEFAULT 'pending_deposit' NOT NULL,
	"required_deposit_usd" numeric(20, 2) NOT NULL,
	"multiplier_bps" integer NOT NULL,
	"withdrawable_bps" integer DEFAULT 2000 NOT NULL,
	"wager_requirement_bps" integer DEFAULT 10000 NOT NULL,
	"max_total_wager_usd" numeric(20, 2),
	"max_payout_usd" numeric(20, 2),
	"min_session_duration_seconds" integer DEFAULT 1800 NOT NULL,
	"min_bet_count" integer DEFAULT 20 NOT NULL,
	"min_wager_to_funding_ratio_bps" integer DEFAULT 5000 NOT NULL,
	"terms_text" text NOT NULL,
	"terms_version" text NOT NULL,
	"tos_accepted_at" timestamp,
	"tos_accepted_ip" text,
	"deposit_locked_at" timestamp,
	"activated_at" timestamp,
	"ended_at" timestamp,
	"auto_end_at" timestamp,
	"reviewed_at" timestamp,
	"settled_at" timestamp,
	"user_funding_usd" numeric(20, 2),
	"platform_funding_usd" numeric(20, 2),
	"total_loaded_usd" numeric(20, 2),
	"fill_spent_usd" numeric(20, 2) DEFAULT '0' NOT NULL,
	"fill_refunded_usd" numeric(20, 2) DEFAULT '0' NOT NULL,
	"fill_remaining_usd" numeric(20, 2),
	"wager_accumulated_usd" numeric(20, 2) DEFAULT '0' NOT NULL,
	"bet_count" integer DEFAULT 0 NOT NULL,
	"tips_spent_this_session_usd" numeric(20, 2) DEFAULT '0' NOT NULL,
	"sponsorship_spent_this_session_usd" numeric(20, 2) DEFAULT '0' NOT NULL,
	"ending_balance_usd" numeric(20, 2),
	"kick_vod_url" text,
	"kick_vod_required" boolean DEFAULT true NOT NULL,
	"flagged_reasons" jsonb,
	"review_decision" text,
	"review_reason" text,
	"reviewed_by" text,
	"withdrawable_voucher_usd" numeric(20, 2),
	"forfeited_usd" numeric(20, 2),
	"deposit_refunded_usd" numeric(20, 2),
	"deposit_forfeited_usd" numeric(20, 2),
	"payout_voucher_id" uuid,
	"deposit_ledger_id" uuid,
	"settlement_ledger_id" uuid,
	"state_log" jsonb,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"auto_renew" boolean DEFAULT true NOT NULL,
	CONSTRAINT "creator_multiplier_deals_required_deposit_positive" CHECK (required_deposit_usd > (0)::numeric),
	CONSTRAINT "creator_multiplier_deals_multiplier_min" CHECK (multiplier_bps >= 10000),
	CONSTRAINT "creator_multiplier_deals_withdrawable_bps_range" CHECK ((withdrawable_bps >= 0) AND (withdrawable_bps <= 10000)),
	CONSTRAINT "creator_multiplier_deals_wager_req_non_negative" CHECK (wager_requirement_bps >= 0),
	CONSTRAINT "creator_multiplier_deals_max_total_wager_non_neg" CHECK ((max_total_wager_usd IS NULL) OR (max_total_wager_usd >= (0)::numeric)),
	CONSTRAINT "creator_multiplier_deals_max_payout_non_neg" CHECK ((max_payout_usd IS NULL) OR (max_payout_usd >= (0)::numeric)),
	CONSTRAINT "creator_multiplier_deals_fill_remaining_non_neg" CHECK ((fill_remaining_usd IS NULL) OR (fill_remaining_usd >= (0)::numeric)),
	CONSTRAINT "creator_multiplier_deals_fill_spent_non_neg" CHECK (fill_spent_usd >= (0)::numeric),
	CONSTRAINT "creator_multiplier_deals_bet_count_non_neg" CHECK (bet_count >= 0)
);
--> statement-breakpoint
CREATE TABLE "upgrader_games" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"bet_amount" numeric(20, 2) NOT NULL,
	"won_amount" numeric(20, 2) NOT NULL,
	"cashout_multiplier" numeric(10, 4) NOT NULL,
	"win_percentage" numeric(5, 2) NOT NULL,
	"segments" jsonb NOT NULL,
	"bet_ledger_tx_id" uuid,
	"payout_ledger_tx_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"target_card_id" uuid,
	"awarded_inventory_item_id" uuid,
	"voucher_id" uuid
);
--> statement-breakpoint
CREATE TABLE "user_wager_requirements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"wager_requirement_bps" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"bonus_wager_requirement_bps" integer,
	"affiliate_wager_requirement_bps" integer,
	"rakeback_wager_requirement_bps" integer,
	"tips_wager_requirement_bps" integer,
	"admin_adjustment_wager_requirement_bps" integer,
	"affiliate_leaderboard_wager_requirement_bps" integer,
	CONSTRAINT "user_wager_requirements_user_id_key" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "game_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text,
	"bot_id" uuid,
	"game_type" "game_type" NOT NULL,
	"game_id" uuid NOT NULL,
	"bet_amount" numeric(20, 2) NOT NULL,
	"result" "game_session_result",
	"bet_ledger_tx_id" uuid,
	"user_reward_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"race_eligible" boolean DEFAULT true NOT NULL,
	"currency" "balance_currency" DEFAULT 'real' NOT NULL,
	"weighted_bet_amount" numeric(20, 2),
	"bet_from_race_prize" numeric(20, 2) DEFAULT '0' NOT NULL,
	"bet_from_bonus_other" numeric(20, 2) DEFAULT '0' NOT NULL,
	"bet_from_rakeback" numeric(20, 2) DEFAULT '0' NOT NULL,
	"bet_from_affiliate" numeric(20, 2) DEFAULT '0' NOT NULL,
	"bet_from_tips" numeric(20, 2) DEFAULT '0' NOT NULL,
	"rakeback_eligible" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "affiliate_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"code" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "affiliate_codes_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "challenge_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"challenge_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"status" "challenge_claim_status" DEFAULT 'eligible' NOT NULL,
	"eligible_at" timestamp DEFAULT now() NOT NULL,
	"claimed_at" timestamp,
	"source_game_session_id" text,
	"prize_ledger_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "challenge_claims_challenge_user_unique" UNIQUE("challenge_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "affiliate_payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"affiliate_user_id" text NOT NULL,
	"amount_usd" numeric(20, 2) DEFAULT '0' NOT NULL,
	"status" "affiliate_payout_status" DEFAULT 'pending' NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "challenge_requirements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"challenge_id" uuid NOT NULL,
	"kind" "challenge_requirement_kind" NOT NULL,
	"pack_id" uuid,
	"card_id" uuid,
	"win_percentage" numeric(5, 2),
	"percent_op" "challenge_percent_op",
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"min_bet_usd" numeric(20, 2),
	"min_multiplier" numeric(10, 4),
	CONSTRAINT "challenge_requirements_shape" CHECK (((kind = 'pack_pull'::challenge_requirement_kind) AND (pack_id IS NOT NULL) AND (card_id IS NOT NULL)) OR ((kind = 'upgrader'::challenge_requirement_kind) AND (min_bet_usd IS NOT NULL) AND (min_multiplier IS NOT NULL)) OR ((kind = 'upgrader'::challenge_requirement_kind) AND (card_id IS NOT NULL) AND (win_percentage IS NOT NULL) AND (percent_op IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE "balances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"available_balance" numeric(20, 2) DEFAULT '0' NOT NULL,
	"locked_balance" numeric(20, 2) DEFAULT '0' NOT NULL,
	"total_deposited" numeric(20, 2) DEFAULT '0' NOT NULL,
	"total_withdrawn" numeric(20, 2) DEFAULT '0' NOT NULL,
	"total_wagered" numeric(20, 2) DEFAULT '0' NOT NULL,
	"total_won" numeric(20, 2) DEFAULT '0' NOT NULL,
	"shards" integer DEFAULT 0 NOT NULL,
	"last_transaction_id" uuid,
	"unlock_at" timestamp,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"active_stream_session_id" uuid,
	"active_multiplier_deal_id" uuid,
	"coin_available_balance" numeric(20, 2) DEFAULT '0' NOT NULL,
	"coin_total_wagered" numeric(20, 2) DEFAULT '0' NOT NULL,
	"coin_total_won" numeric(20, 2) DEFAULT '0' NOT NULL,
	"total_bonus_won" numeric(20, 2) DEFAULT '0' NOT NULL,
	"wager_requirement_progress" numeric(20, 2) DEFAULT '0' NOT NULL,
	"total_affiliate_won" numeric(20, 2) DEFAULT '0' NOT NULL,
	"total_rakeback_won" numeric(20, 2) DEFAULT '0' NOT NULL,
	"total_tips_won" numeric(20, 2) DEFAULT '0' NOT NULL,
	"shard_wager_progress" numeric(20, 2) DEFAULT '0' NOT NULL,
	"unwagered_race_prize_usd" numeric(20, 2) DEFAULT '0' NOT NULL,
	"unwagered_bonus_other_usd" numeric(20, 2) DEFAULT '0' NOT NULL,
	"unwagered_rakeback_usd" numeric(20, 2) DEFAULT '0' NOT NULL,
	"unwagered_affiliate_usd" numeric(20, 2) DEFAULT '0' NOT NULL,
	"unwagered_tips_usd" numeric(20, 2) DEFAULT '0' NOT NULL,
	"wager_requirement_remaining" numeric(20, 2) DEFAULT '0' NOT NULL,
	CONSTRAINT "balances_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "affiliate_level_configs" (
	"level" integer PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"commission_rate" numeric(5, 4) NOT NULL,
	"updated_at" timestamp(6) NOT NULL,
	"threshold" numeric(20, 2) DEFAULT '0' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "affiliate_clicks" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" varchar(20) NOT NULL,
	"user_agent" text,
	"ip" varchar(45) NOT NULL,
	"country" varchar(100) DEFAULT 'unknown' NOT NULL,
	"region" varchar(100) DEFAULT 'unknown' NOT NULL,
	"city" varchar(100) DEFAULT 'unknown' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "active_seeds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"client_seed" text NOT NULL,
	"server_seed" text,
	"server_seed_hash" text,
	"nonce" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "active_seeds_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"image_url" text NOT NULL,
	"price" numeric(20, 2) NOT NULL,
	"price_raw" numeric(20, 2) NOT NULL,
	"hp" integer DEFAULT 0,
	"rarity" text,
	"artist" text,
	"card_number" text,
	"type" text DEFAULT 'card' NOT NULL,
	"tcgplayer_id" integer,
	"set_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "cards_tcgplayer_id_unique" UNIQUE("tcgplayer_id")
);
--> statement-breakpoint
CREATE TABLE "affiliate_accounts" (
	"user_id" text PRIMARY KEY NOT NULL,
	"total_referred" integer DEFAULT 0 NOT NULL,
	"total_wager_volume_usd" numeric(20, 2) DEFAULT '0' NOT NULL,
	"total_earned_usd" numeric(20, 2) DEFAULT '0' NOT NULL,
	"available_usd" numeric(20, 2) DEFAULT '0' NOT NULL,
	"total_paid_out_usd" numeric(20, 2) DEFAULT '0' NOT NULL,
	"total_bonus_distributed_usd" numeric(20, 2) DEFAULT '0' NOT NULL,
	"last_payout_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"event_type" "audit_event_type" NOT NULL,
	"ip" "inet",
	"user_agent" text,
	"country" text,
	"country_code" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"accountId" text NOT NULL,
	"providerId" text NOT NULL,
	"accessToken" text,
	"refreshToken" text,
	"accessTokenExpiresAt" timestamp,
	"refreshTokenExpiresAt" timestamp,
	"scope" text,
	"idToken" text,
	"password" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp,
	CONSTRAINT "account_accountId_unique" UNIQUE("accountId")
);
--> statement-breakpoint
CREATE TABLE "bots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" varchar(50) NOT NULL,
	"image_url" text,
	"total_wagered_usd" numeric(20, 2) DEFAULT '0' NOT NULL,
	"total_won_usd" numeric(20, 2) DEFAULT '0' NOT NULL,
	"total_lost_usd" numeric(20, 2) DEFAULT '0' NOT NULL,
	"battles_played" integer DEFAULT 0 NOT NULL,
	"battles_won" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "bots_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "card_withdrawal_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"method" "card_withdrawal_method" NOT NULL,
	"inventory_item_ids" uuid[] DEFAULT '{}' NOT NULL,
	"voucher_ids" uuid[] DEFAULT '{}' NOT NULL,
	"total_value_usd" numeric(20, 2) NOT NULL,
	"shipping_address_snapshot" jsonb,
	"shipping_fee_usd" numeric(10, 2),
	"tracking_number" text,
	"carrier" text,
	"crypto_asset" text,
	"crypto_amount" numeric(20, 8),
	"exchange_rate" numeric(20, 8),
	"destination_address" text,
	"fireblocks_tx_id" text,
	"tx_hash" text,
	"status" "card_withdrawal_status" DEFAULT 'pending' NOT NULL,
	"failure_reason" text,
	"requested_at" timestamp DEFAULT now() NOT NULL,
	"processing_at" timestamp,
	"shipped_at" timestamp,
	"completed_at" timestamp,
	"failed_at" timestamp,
	"cancelled_at" timestamp,
	"processed_by" text,
	"shipped_by" text,
	"requires_confirmation" boolean DEFAULT false NOT NULL,
	"confirmation_reason" text,
	"confirmed_at" timestamp,
	"confirmed_by" text,
	"ip_address" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "card_withdrawal_requests_fireblocks_tx_id_unique" UNIQUE("fireblocks_tx_id")
);
--> statement-breakpoint
CREATE TABLE "packs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(60) NOT NULL,
	"slug" varchar(60) NOT NULL,
	"description" text,
	"image_url" text,
	"active" boolean DEFAULT true NOT NULL,
	"pack_type" text DEFAULT 'official' NOT NULL,
	"cards_per_open" integer DEFAULT 5 NOT NULL,
	"difficulty" real,
	"tags" "pack_tag"[],
	"price" numeric(20, 2) NOT NULL,
	"total_openings" bigint DEFAULT 0 NOT NULL,
	"total_revenue" numeric(20, 2) DEFAULT '0' NOT NULL,
	"total_payout" numeric(20, 2) DEFAULT '0' NOT NULL,
	"actual_rtp" numeric(10, 4) DEFAULT '0' NOT NULL,
	"actual_house_edge" numeric(10, 4) DEFAULT '0' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"shard_cost" integer,
	CONSTRAINT "packs_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "fingerprints" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"visitor_id" text NOT NULL,
	"request_id" text NOT NULL,
	"confidence" real NOT NULL,
	"event_type" "fingerprint_event_type" NOT NULL,
	"suspected_alt_triggered" boolean DEFAULT false NOT NULL,
	"ip" "inet",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gift_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(32),
	"code_hash" varchar(64),
	"value" numeric(20, 2) NOT NULL,
	"region" "gift_card_region" NOT NULL,
	"redeemed_at" timestamp,
	"redeemed_by_user_id" text,
	"ledger_tx_id" uuid,
	"expires_at" timestamp,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"type" "ledger_transaction_type" NOT NULL,
	"amount" numeric(20, 2) NOT NULL,
	"balance_before" numeric(20, 2) NOT NULL,
	"balance_after" numeric(20, 2) NOT NULL,
	"game_session_id" uuid,
	"crypto_asset" text,
	"crypto_amount" numeric(20, 8),
	"exchange_rate" numeric(20, 8),
	"fireblocks_tx_id" text,
	"external_tx_id" text,
	"blockchain_tx_hash" text,
	"source_address" text,
	"destination_address" text,
	"deposit_address_id" uuid,
	"status" "ledger_transaction_status" NOT NULL,
	"failure_reason" text,
	"description" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_transactions_external_tx_id_unique" UNIQUE("external_tx_id"),
	CONSTRAINT "ledger_transactions_fireblocks_tx_id_unique" UNIQUE("fireblocks_tx_id")
);
--> statement-breakpoint
CREATE TABLE "pack_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pack_id" uuid NOT NULL,
	"card_id" uuid NOT NULL,
	"weight" integer DEFAULT 1 NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"color" text,
	"animation" boolean DEFAULT false NOT NULL,
	CONSTRAINT "pack_cards_pack_id_card_id_unique" UNIQUE("card_id","pack_id")
);
--> statement-breakpoint
CREATE TABLE "creator_withdrawal_limits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"currency_limit_amount" numeric(20, 2),
	"currency_limit_start_date" timestamp,
	"currency_limit_reset_days" integer,
	"percentage_limit" numeric(5, 4),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "creator_withdrawal_limits_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "pack_favorites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"pack_id" uuid NOT NULL,
	"favorited_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "pack_favorites_user_id_pack_id_unique" UNIQUE("pack_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "rains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"base_amount_usd" numeric(10, 2) DEFAULT '0.50' NOT NULL,
	"tip_amount_usd" numeric(10, 2) DEFAULT '0' NOT NULL,
	"total_pool_usd" numeric(10, 2) DEFAULT '0.50' NOT NULL,
	"status" "rain_status" DEFAULT 'active' NOT NULL,
	"starts_at" timestamp NOT NULL,
	"ends_at" timestamp NOT NULL,
	"participant_count" integer DEFAULT 0 NOT NULL,
	"winner_user_id" text,
	"winner_entry_id" uuid,
	"completed_at" timestamp,
	"server_seed" text,
	"server_seed_hash" text,
	"client_seed" text,
	"winning_ticket" integer,
	"result_hash" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"currency" "balance_currency" DEFAULT 'real' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "race_leaderboard_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"race_type" "race_type" NOT NULL,
	"period_start" date NOT NULL,
	"position" integer NOT NULL,
	"wagered_usd" numeric(20, 2) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"period_end" timestamp,
	"prize_amount_usd" numeric(20, 2),
	CONSTRAINT "race_leaderboard_snapshots_user_id_race_type_period_start_uniqu" UNIQUE("period_start","race_type","user_id")
);
--> statement-breakpoint
CREATE TABLE "race_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"race_type" "race_type" NOT NULL,
	"race_period_start" date NOT NULL,
	"position" integer NOT NULL,
	"prize_amount_usd" numeric(20, 2) NOT NULL,
	"claimed_at" timestamp DEFAULT now() NOT NULL,
	"ledger_tx_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "race_claims_user_id_race_type_race_period_start_unique" UNIQUE("race_period_start","race_type","user_id")
);
--> statement-breakpoint
CREATE TABLE "promo_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code_hash" varchar(64) NOT NULL,
	"value" numeric(20, 2) NOT NULL,
	"region" "gift_card_region" NOT NULL,
	"minimum_level" integer DEFAULT 0 NOT NULL,
	"minimum_wager_amount" numeric(20, 2) DEFAULT '0' NOT NULL,
	"wager_period_days" integer DEFAULT 0 NOT NULL,
	"minimum_account_age_days" integer DEFAULT 0 NOT NULL,
	"requires_discord" boolean DEFAULT true NOT NULL,
	"max_uses" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"minimum_deposit_amount" numeric(20, 2) DEFAULT '0' NOT NULL,
	"required_affiliate_code" text,
	"maximum_account_age_hours" integer DEFAULT 0 NOT NULL,
	"minimum_recent_deposit_amount" numeric(20, 2) DEFAULT '0' NOT NULL,
	"recent_deposit_period_minutes" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rakeback_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "rakeback_type" NOT NULL,
	"percentage" numeric(10, 6) NOT NULL,
	"expiration_days" integer NOT NULL,
	"display_name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"early_claim_payout_percent" numeric(5, 2) DEFAULT '70' NOT NULL,
	"early_claim_cooldown_seconds" integer DEFAULT 30 NOT NULL,
	CONSTRAINT "rakeback_config_type_unique" UNIQUE("type")
);
--> statement-breakpoint
CREATE TABLE "raffles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text,
	"status" "raffle_status" DEFAULT 'active' NOT NULL,
	"prizes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"min_points_per_entry" integer,
	"max_points_per_entry" integer,
	"starts_at" timestamp DEFAULT now() NOT NULL,
	"ends_at" timestamp NOT NULL,
	"winner_user_id" text,
	"winner_entry_id" uuid,
	"participant_count" integer DEFAULT 0 NOT NULL,
	"total_entries" integer DEFAULT 0 NOT NULL,
	"completed_at" timestamp,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "race_prize_tiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"race_type" "race_type" NOT NULL,
	"position" integer NOT NULL,
	"prize_amount_usd" numeric(20, 2) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "race_prize_tiers_race_type_position_unique" UNIQUE("position","race_type")
);
--> statement-breakpoint
CREATE TABLE "rain_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rain_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"turnstile_verified_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "rain_entries_rain_id_user_id_unique" UNIQUE("rain_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "rain_tips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rain_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"amount_usd" numeric(10, 2) NOT NULL,
	"ledger_tx_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "promo_code_redemptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"promo_code_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"ip_address" varchar(45) NOT NULL,
	"ledger_tx_id" uuid,
	"redeemed_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "promo_code_redemptions_user_unique" UNIQUE("promo_code_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"series" text NOT NULL,
	"image_url" text NOT NULL,
	"language" text NOT NULL,
	"release_date" timestamp,
	"tcgplayer_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "sets_tcgplayer_id_unique" UNIQUE("tcgplayer_id")
);
--> statement-breakpoint
CREATE TABLE "two_factor" (
	"id" text PRIMARY KEY NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_config" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_feature_locks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"locked_deposits_crypto" text[] DEFAULT '{}' NOT NULL,
	"locked_deposits_fiat" text[] DEFAULT '{}' NOT NULL,
	"locked_deposits_at" timestamp,
	"locked_deposits_by" text,
	"locked_deposits_reason" text,
	"locked_withdrawals_crypto" text[] DEFAULT '{}' NOT NULL,
	"locked_withdrawals_items" boolean DEFAULT false NOT NULL,
	"locked_withdrawals_at" timestamp,
	"locked_withdrawals_by" text,
	"locked_withdrawals_reason" text,
	"locked_inventory_sales" boolean DEFAULT false NOT NULL,
	"locked_inventory_sales_at" timestamp,
	"locked_inventory_sales_by" text,
	"locked_exchanges" boolean DEFAULT false NOT NULL,
	"locked_exchanges_at" timestamp,
	"locked_exchanges_by" text,
	"locked_openings" boolean DEFAULT false NOT NULL,
	"locked_openings_at" timestamp,
	"locked_openings_by" text,
	"locked_vault" boolean DEFAULT false NOT NULL,
	"locked_vault_at" timestamp,
	"locked_vault_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_feature_locks_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "vaults" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"fireblocks_vault_id" text,
	"name" text NOT NULL,
	"customer_ref_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "vaults_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "user_mutes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"muted_by" text NOT NULL,
	"reason" text,
	"expires_at" timestamp,
	"unmuted_at" timestamp,
	"unmuted_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seed_rotation_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"old_client_seed" text NOT NULL,
	"old_server_seed" text NOT NULL,
	"old_server_seed_hash" text NOT NULL,
	"old_nonce" integer NOT NULL,
	"new_client_seed" text NOT NULL,
	"new_server_seed_hash" text NOT NULL,
	"rotated_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_packs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"pack_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid,
	"opened_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_rewards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"reward_id" uuid NOT NULL,
	"granted_at" timestamp DEFAULT now() NOT NULL,
	"opened_at" timestamp,
	"metadata" jsonb,
	"daily_period_start" timestamp,
	"daily_unlock_xp_baseline" integer,
	"last_claimed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vault_lock_times" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hours" integer NOT NULL,
	"label" varchar(50) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "vault_lock_times_hours_unique" UNIQUE("hours")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"token" text NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"ipAddress" text,
	"userAgent" text,
	"country" text,
	"country_code" text,
	"city" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "wager_period_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"period_type" "rakeback_type" NOT NULL,
	"period_start" date NOT NULL,
	"wagered_usd" numeric(20, 2) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "wager_period_snapshots_user_id_period_type_period_start_unique" UNIQUE("period_start","period_type","user_id")
);
--> statement-breakpoint
CREATE TABLE "creator_session_pending_conversions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"deal_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"source" "creator_pending_conversion_source" NOT NULL,
	"amount_usd" numeric(20, 2) NOT NULL,
	"battle_id" uuid,
	"game_session_id" uuid,
	"conversion_rate_bps_snapshot" integer NOT NULL,
	"status" "creator_pending_conversion_status" DEFAULT 'pending' NOT NULL,
	"claimed_at" timestamp,
	"claim_ledger_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "creator_session_pending_conversions_amount_non_negative" CHECK (amount_usd >= (0)::numeric),
	CONSTRAINT "creator_session_pending_conversions_rate_range" CHECK ((conversion_rate_bps_snapshot >= 0) AND (conversion_rate_bps_snapshot <= 10000))
);
--> statement-breakpoint
CREATE TABLE "affiliate_leaderboard_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"leaderboard_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"position" integer NOT NULL,
	"total_wagered_usd" numeric(20, 2) NOT NULL,
	"prize_amount_usd" numeric(20, 2) DEFAULT '0' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "affiliate_leaderboard_snapshots_unique" UNIQUE("leaderboard_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "affiliate_leaderboards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"creator_user_id" text NOT NULL,
	"title" text NOT NULL,
	"affiliate_codes" text[] DEFAULT '{}' NOT NULL,
	"start_date" timestamp NOT NULL,
	"end_date" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"creator_prize_usd" numeric(20, 2) NOT NULL,
	"site_bonus_usd" numeric(20, 2) DEFAULT '0' NOT NULL,
	"approval_status" "affiliate_leaderboard_approval_status" DEFAULT 'pending' NOT NULL,
	"approved_at" timestamp,
	"approved_by" text,
	"rejection_reason" text,
	"cancelled_at" timestamp,
	"cancelled_by" text,
	"refunded_at" timestamp,
	"refund_amount_usd" numeric(20, 2),
	"creation_ledger_tx_id" uuid,
	"refund_ledger_tx_id" uuid,
	"co_creator_user_ids" text[] DEFAULT '{}' NOT NULL,
	"paid_manually" boolean DEFAULT false NOT NULL,
	"payout_note" text
);
--> statement-breakpoint
CREATE TABLE "raffle_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"raffle_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"points_spent" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "raffle_entries_raffle_id_user_id_unique" UNIQUE("raffle_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "vouchers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"value" numeric(20, 2) NOT NULL,
	"origin" "voucher_origin" NOT NULL,
	"origin_id" uuid,
	"description" text,
	"claimed_at" timestamp,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "battle_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"battle_id" uuid NOT NULL,
	"game_session_id" uuid NOT NULL,
	"user_id" text,
	"bot_id" uuid,
	"team_number" integer NOT NULL,
	"team_position" integer DEFAULT 0 NOT NULL,
	"client_seed" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"borrow_percentage" integer DEFAULT 0 NOT NULL,
	"source_session_id" uuid,
	CONSTRAINT "battle_participants_game_session_id_unique" UNIQUE("game_session_id")
);
--> statement-breakpoint
CREATE TABLE "affiliate_leaderboard_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"leaderboard_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"prize_amount_usd" numeric(20, 2) NOT NULL,
	"ledger_tx_id" uuid NOT NULL,
	"claimed_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "affiliate_leaderboard_claims_unique" UNIQUE("leaderboard_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "creator_socials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"platform" "creator_social_platform" NOT NULL,
	"username" text NOT NULL,
	"url" text,
	"status" "creator_social_status" DEFAULT 'pending' NOT NULL,
	"submitted_at" timestamp DEFAULT now() NOT NULL,
	"reviewed_at" timestamp,
	"reviewed_by" text,
	"rejection_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "creator_socials_user_platform_unique" UNIQUE("platform","user_id")
);
--> statement-breakpoint
CREATE TABLE "leaderboard_funding_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"leaderboard_id" uuid NOT NULL,
	"creator_user_id" text NOT NULL,
	"vault_id" uuid NOT NULL,
	"asset_id" text NOT NULL,
	"address" text NOT NULL,
	"tag" text,
	"amount_usd" numeric(20, 2) NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"funded_at" timestamp,
	"creation_ledger_tx_id" uuid,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"content" text NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp,
	"deleted_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"reply_to_id" uuid,
	"embed_type" "chat_message_embed_type",
	"embed_battle_id" uuid,
	"embed_data" jsonb
);
--> statement-breakpoint
CREATE TABLE "user_inventory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"card_id" uuid NOT NULL,
	"value_at_obtained" numeric(20, 2) NOT NULL,
	"item_region" "region_code" DEFAULT 'NA' NOT NULL,
	"source_type" "source_type" NOT NULL,
	"source_id" uuid,
	"obtained_at" timestamp DEFAULT now() NOT NULL,
	"sold_at" timestamp,
	"exchanged_at" timestamp,
	"withdrawal_locked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"pull_chance" numeric(12, 10),
	"pull_pack_id" uuid
);
--> statement-breakpoint
CREATE TABLE "user_battle_limits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"max_value_usd" numeric(20, 2),
	"base_bet_limit_usd" numeric(20, 2),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_battle_limits_user_id_key" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "rakeback_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"rakeback_type" "rakeback_type" NOT NULL,
	"period_start" date NOT NULL,
	"wagered_amount_usd" numeric(20, 2) NOT NULL,
	"rakeback_amount_usd" numeric(20, 2) NOT NULL,
	"claimed_at" timestamp DEFAULT now(),
	"ledger_tx_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"claimed_through" timestamp,
	"last_preclaim_at" timestamp,
	"is_finalized" boolean DEFAULT true NOT NULL,
	CONSTRAINT "rakeback_claims_user_id_rakeback_type_period_start_unique" UNIQUE("period_start","rakeback_type","user_id")
);
--> statement-breakpoint
CREATE TABLE "upgrader_output_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"card_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"color" text
);
--> statement-breakpoint
CREATE TABLE "affiliate_leaderboard_claim_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"leaderboard_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"reason" text NOT NULL,
	"created_by" text NOT NULL,
	"released_at" timestamp,
	"released_by" text,
	"release_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "race_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"race_type" "race_type" NOT NULL,
	"starts_at" timestamp NOT NULL,
	"ends_at" timestamp NOT NULL,
	"auto_renew" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"claims_frozen" boolean DEFAULT false NOT NULL,
	"claims_unfrozen_at" timestamp,
	"claims_unfrozen_by" text
);
--> statement-breakpoint
CREATE TABLE "user_statistics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"opened_packs_count" integer DEFAULT 0 NOT NULL,
	"battles_played" integer DEFAULT 0 NOT NULL,
	"xp" integer DEFAULT 0 NOT NULL,
	"level" integer DEFAULT 0 NOT NULL,
	"current_day_start" date DEFAULT (date_trunc('day' NOT NULL,
	"current_day_wagered_usd" numeric(20, 2) DEFAULT '0' NOT NULL,
	"current_week_start" date DEFAULT (date_trunc('week' NOT NULL,
	"current_week_wagered_usd" numeric(20, 2) DEFAULT '0' NOT NULL,
	"current_month_start" date DEFAULT (date_trunc('month' NOT NULL,
	"current_month_wagered_usd" numeric(20, 2) DEFAULT '0' NOT NULL,
	"last_wagered_at" timestamp,
	"weekly_wager_count" integer DEFAULT 0 NOT NULL,
	"is_profile_private" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"upgrader_games_played" integer DEFAULT 0 NOT NULL,
	"purchased_xp" integer DEFAULT 0 NOT NULL,
	"keno_games_played" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "user_statistics_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "race_claim_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"race_type" "race_type" NOT NULL,
	"race_period_start" date NOT NULL,
	"reason" text NOT NULL,
	"created_by" text NOT NULL,
	"released_at" timestamp,
	"released_by" text,
	"release_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coin_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"type" "coin_transaction_type" NOT NULL,
	"amount" numeric(20, 2) NOT NULL,
	"balance_before" numeric(20, 2) NOT NULL,
	"balance_after" numeric(20, 2) NOT NULL,
	"game_session_id" uuid,
	"description" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "affiliate_code_usages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"affiliate_user_id" text NOT NULL,
	"code" text NOT NULL,
	"referred_user_id" text NOT NULL,
	"deposit_amount_usd" numeric(20, 2) DEFAULT '0' NOT NULL,
	"referrer_cut_usd" numeric(20, 2) DEFAULT '0' NOT NULL,
	"user_bonus_usd" numeric(20, 2) DEFAULT '0' NOT NULL,
	"status" text DEFAULT 'completed' NOT NULL,
	"usage_type" "affiliate_usage_type" DEFAULT 'deposit' NOT NULL,
	"wager_amount_usd" numeric(20, 2) DEFAULT '0' NOT NULL,
	"game_session_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"leaderboard_eligible" boolean DEFAULT true NOT NULL,
	"weighted_wager_amount_usd" numeric(20, 2)
);
--> statement-breakpoint
CREATE TABLE "challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"game_type" "game_type" NOT NULL,
	"type" "challenge_type" NOT NULL,
	"status" "challenge_status" DEFAULT 'active' NOT NULL,
	"prize_amount" numeric(20, 2) NOT NULL,
	"max_claims" integer DEFAULT 1 NOT NULL,
	"claimed_count" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "challenges_claimed_within_cap" CHECK (claimed_count <= max_claims),
	CONSTRAINT "challenges_prize_ceiling" CHECK ((prize_amount > (0)::numeric) AND (prize_amount <= (100000)::numeric)),
	CONSTRAINT "challenges_max_claims_ceiling" CHECK ((max_claims > 0) AND (max_claims <= 100000))
);
--> statement-breakpoint
CREATE TABLE "monitor_event_settings" (
	"event_name" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "battle_double_down_offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"battle_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"game_session_id" uuid NOT NULL,
	"won_amount_usd" numeric(20, 2) NOT NULL,
	"server_seed" text,
	"server_seed_hash" text NOT NULL,
	"ticket" integer,
	"result" "battle_double_down_result",
	"status" "battle_double_down_status" DEFAULT 'offered' NOT NULL,
	"won_voucher_id" uuid,
	"expires_at" timestamp NOT NULL,
	"accepted_at" timestamp,
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"name" text,
	"username" text,
	"display_username" text,
	"two_factor_enabled" boolean DEFAULT false,
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"country" text,
	"country_code" text,
	"continent_code" text DEFAULT 'NA' NOT NULL,
	"state" text,
	"city" text,
	"signup_ip" text,
	"affiliate_code" text,
	"affiliate_code_expires_at" timestamp,
	"affiliate_code_active" boolean DEFAULT false,
	"affiliate_bonus_opted_in" boolean DEFAULT false,
	"referred_by" text,
	"api_key" text,
	"is_locked" boolean DEFAULT false NOT NULL,
	"locked_reason" text,
	"locked_at" timestamp,
	"locked_until" timestamp,
	"locked_by" text,
	"is_banned" boolean DEFAULT false NOT NULL,
	"banned_reason" text,
	"banned_at" timestamp,
	"banned_by" text,
	"is_suspected_alt" boolean DEFAULT false NOT NULL,
	"suspected_alt_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"affiliate_bonus_expires_at" timestamp,
	"is_self_excluded" boolean DEFAULT false NOT NULL,
	"self_excluded_reason" text,
	"self_excluded_at" timestamp,
	"self_excluded_until" timestamp,
	"roles" "user_role"[] DEFAULT '{}' NOT NULL,
	CONSTRAINT "user_api_key_unique" UNIQUE("api_key"),
	CONSTRAINT "user_email_unique" UNIQUE("email"),
	CONSTRAINT "user_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"category" "notification_category" NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" text,
	"read_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "announcements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category" "notification_category" NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"audience_roles" text[],
	"starts_at" timestamp DEFAULT now() NOT NULL,
	"ends_at" timestamp,
	"created_by" text,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "keno_games" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"risk" "keno_risk" NOT NULL,
	"selected_numbers" jsonb NOT NULL,
	"drawn_numbers" jsonb NOT NULL,
	"hits" integer NOT NULL,
	"result_multiplier" numeric(10, 4) NOT NULL,
	"bet_amount" numeric(20, 2) NOT NULL,
	"won_amount" numeric(20, 2) NOT NULL,
	"bet_ledger_tx_id" uuid,
	"payout_ledger_tx_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_kyc" (
	"user_id" text PRIMARY KEY NOT NULL,
	"kyc_required" boolean DEFAULT false NOT NULL,
	"kyc_required_at" timestamp,
	"kyc_required_by" text,
	"kyc_required_reason" text,
	"verification_cycle" integer DEFAULT 0 NOT NULL,
	"admin_decision" "kyc_admin_decision" DEFAULT 'pending' NOT NULL,
	"admin_reviewed_at" timestamp,
	"admin_reviewed_by" text,
	"applicant_id" text,
	"level_name" text,
	"status" "kyc_status" DEFAULT 'none' NOT NULL,
	"review_answer" text,
	"reject_type" text,
	"moderation_comment" text,
	"last_webhook_created_at" timestamp,
	"last_webhook_digest" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_kyc_applicant_id_key" UNIQUE("applicant_id"),
	CONSTRAINT "user_kyc_cycle_non_negative" CHECK (verification_cycle >= 0)
);
--> statement-breakpoint
CREATE TABLE "sumsub_webhook_events" (
	"digest" text PRIMARY KEY NOT NULL,
	"applicant_id" text,
	"external_user_id" text,
	"event_type" text NOT NULL,
	"provider_created_at" timestamp NOT NULL,
	"received_at" timestamp DEFAULT now() NOT NULL,
	"processed_at" timestamp,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_provider_fees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deposit_intent_id" uuid NOT NULL,
	"provider_payment_id" text NOT NULL,
	"fee_key" text NOT NULL,
	"fee_type" text NOT NULL,
	"fee_name" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"raw_payload" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "payment_provider_fee_non_negative" CHECK (amount_cents >= 0)
);
--> statement-breakpoint
CREATE TABLE "fiat_deposit_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"currency" text NOT NULL,
	"requested_amount_cents" integer NOT NULL,
	"credited_amount_cents" integer NOT NULL,
	"actual_customer_total_cents" integer,
	"provider_net_amount_cents" integer,
	"status" text NOT NULL,
	"client_idempotency_key" text NOT NULL,
	"provider_checkout_id" text,
	"provider_payment_id" text,
	"provider_payment_status" text,
	"completed_ledger_id" uuid,
	"pricing_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provider_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"failure_reason" text,
	"paid_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "fiat_deposit_credited_amount_positive" CHECK (credited_amount_cents > 0),
	CONSTRAINT "fiat_deposit_status_valid" CHECK (status = ANY (ARRAY['created'::text, 'checkout_creating'::text, 'checkout_ready'::text, 'pending'::text, 'review'::text, 'completed'::text, 'failed'::text, 'canceled'::text, 'partially_refunded'::text, 'refunded'::text, 'disputed'::text])),
	CONSTRAINT "fiat_deposit_actual_total_non_negative" CHECK ((actual_customer_total_cents IS NULL) OR (actual_customer_total_cents >= 0)),
	CONSTRAINT "fiat_deposit_provider_valid" CHECK (provider = 'whop'::text),
	CONSTRAINT "fiat_deposit_requested_amount_positive" CHECK (requested_amount_cents > 0)
);
--> statement-breakpoint
CREATE TABLE "payment_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"provider_resource_id" text,
	"payload" jsonb NOT NULL,
	"processing_status" text DEFAULT 'received' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"received_at" timestamp DEFAULT now() NOT NULL,
	"processed_at" timestamp,
	CONSTRAINT "payment_webhook_processing_status_valid" CHECK (processing_status = ANY (ARRAY['received'::text, 'processing'::text, 'processed'::text, 'failed'::text])),
	CONSTRAINT "payment_webhook_attempt_count_non_negative" CHECK (attempt_count >= 0),
	CONSTRAINT "payment_webhook_provider_valid" CHECK (provider = 'whop'::text)
);
--> statement-breakpoint
CREATE TABLE "announcement_reads" (
	"announcement_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"read_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "announcement_reads_pkey" PRIMARY KEY("announcement_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "affiliate_code_queue" ADD CONSTRAINT "affiliate_code_queue_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "battles" ADD CONSTRAINT "battles_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_addresses" ADD CONSTRAINT "deposit_addresses_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_addresses" ADD CONSTRAINT "deposit_addresses_vault_id_vaults_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."vaults"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provably_fair_results" ADD CONSTRAINT "provably_fair_results_battle_id_battles_id_fk" FOREIGN KEY ("battle_id") REFERENCES "public"."battles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provably_fair_results" ADD CONSTRAINT "provably_fair_results_game_session_id_game_sessions_id_fk" FOREIGN KEY ("game_session_id") REFERENCES "public"."game_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provably_fair_results" ADD CONSTRAINT "provably_fair_results_inventory_item_id_user_inventory_id_fk" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."user_inventory"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_addresses" ADD CONSTRAINT "shipping_addresses_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_leaderboard_prize_tiers" ADD CONSTRAINT "affiliate_leaderboard_prize_tiers_leaderboard_id_fkey" FOREIGN KEY ("leaderboard_id") REFERENCES "public"."affiliate_leaderboards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_stream_sessions" ADD CONSTRAINT "creator_stream_sessions_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "public"."creator_deals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_stream_sessions" ADD CONSTRAINT "creator_stream_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_stream_sessions" ADD CONSTRAINT "creator_stream_sessions_activation_ledger_id_fkey" FOREIGN KEY ("activation_ledger_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_stream_sessions" ADD CONSTRAINT "creator_stream_sessions_conversion_ledger_id_fkey" FOREIGN KEY ("conversion_ledger_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_deals" ADD CONSTRAINT "creator_deals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_deals" ADD CONSTRAINT "creator_deals_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pinned_chat_messages" ADD CONSTRAINT "pinned_chat_messages_message_id_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pinned_chat_messages" ADD CONSTRAINT "pinned_chat_messages_pinned_by_user_id_fk" FOREIGN KEY ("pinned_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_multiplier_deals" ADD CONSTRAINT "creator_multiplier_deals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_multiplier_deals" ADD CONSTRAINT "creator_multiplier_deals_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_multiplier_deals" ADD CONSTRAINT "creator_multiplier_deals_deposit_ledger_id_fkey" FOREIGN KEY ("deposit_ledger_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_multiplier_deals" ADD CONSTRAINT "creator_multiplier_deals_settlement_ledger_id_fkey" FOREIGN KEY ("settlement_ledger_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_multiplier_deals" ADD CONSTRAINT "creator_multiplier_deals_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upgrader_games" ADD CONSTRAINT "upgrader_games_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upgrader_games" ADD CONSTRAINT "upgrader_games_target_card_id_fk" FOREIGN KEY ("target_card_id") REFERENCES "public"."cards"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_wager_requirements" ADD CONSTRAINT "user_wager_requirements_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_sessions" ADD CONSTRAINT "game_sessions_bet_ledger_tx_id_ledger_transactions_id_fk" FOREIGN KEY ("bet_ledger_tx_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_sessions" ADD CONSTRAINT "game_sessions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_codes" ADD CONSTRAINT "affiliate_codes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenge_claims" ADD CONSTRAINT "challenge_claims_challenge_id_fkey" FOREIGN KEY ("challenge_id") REFERENCES "public"."challenges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenge_claims" ADD CONSTRAINT "challenge_claims_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenge_claims" ADD CONSTRAINT "challenge_claims_prize_ledger_id_fkey" FOREIGN KEY ("prize_ledger_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_payouts" ADD CONSTRAINT "affiliate_payouts_affiliate_user_id_user_id_fk" FOREIGN KEY ("affiliate_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenge_requirements" ADD CONSTRAINT "challenge_requirements_challenge_id_fkey" FOREIGN KEY ("challenge_id") REFERENCES "public"."challenges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balances" ADD CONSTRAINT "balances_active_stream_session_id_fkey" FOREIGN KEY ("active_stream_session_id") REFERENCES "public"."creator_stream_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balances" ADD CONSTRAINT "balances_last_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("last_transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balances" ADD CONSTRAINT "balances_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "active_seeds" ADD CONSTRAINT "active_seeds_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_accounts" ADD CONSTRAINT "affiliate_accounts_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_withdrawal_requests" ADD CONSTRAINT "card_withdrawal_requests_confirmed_by_user_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_withdrawal_requests" ADD CONSTRAINT "card_withdrawal_requests_processed_by_user_id_fk" FOREIGN KEY ("processed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_withdrawal_requests" ADD CONSTRAINT "card_withdrawal_requests_shipped_by_user_id_fk" FOREIGN KEY ("shipped_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_withdrawal_requests" ADD CONSTRAINT "card_withdrawal_requests_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fingerprints" ADD CONSTRAINT "fingerprints_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_cards" ADD CONSTRAINT "gift_cards_ledger_tx_id_ledger_transactions_id_fk" FOREIGN KEY ("ledger_tx_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_cards" ADD CONSTRAINT "gift_cards_redeemed_by_user_id_user_id_fk" FOREIGN KEY ("redeemed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_deposit_address_id_deposit_addresses_id_fk" FOREIGN KEY ("deposit_address_id") REFERENCES "public"."deposit_addresses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_game_session_id_game_sessions_id_fk" FOREIGN KEY ("game_session_id") REFERENCES "public"."game_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pack_cards" ADD CONSTRAINT "pack_cards_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pack_cards" ADD CONSTRAINT "pack_cards_pack_id_packs_id_fk" FOREIGN KEY ("pack_id") REFERENCES "public"."packs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_withdrawal_limits" ADD CONSTRAINT "creator_withdrawal_limits_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pack_favorites" ADD CONSTRAINT "pack_favorites_pack_id_packs_id_fk" FOREIGN KEY ("pack_id") REFERENCES "public"."packs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pack_favorites" ADD CONSTRAINT "pack_favorites_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rains" ADD CONSTRAINT "rains_winner_user_id_user_id_fk" FOREIGN KEY ("winner_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "race_leaderboard_snapshots" ADD CONSTRAINT "race_leaderboard_snapshots_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "race_claims" ADD CONSTRAINT "race_claims_ledger_tx_id_ledger_transactions_id_fk" FOREIGN KEY ("ledger_tx_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "race_claims" ADD CONSTRAINT "race_claims_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raffles" ADD CONSTRAINT "raffles_winner_user_id_user_id_fk" FOREIGN KEY ("winner_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rain_entries" ADD CONSTRAINT "rain_entries_rain_id_rains_id_fk" FOREIGN KEY ("rain_id") REFERENCES "public"."rains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rain_entries" ADD CONSTRAINT "rain_entries_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rain_tips" ADD CONSTRAINT "rain_tips_rain_id_rains_id_fk" FOREIGN KEY ("rain_id") REFERENCES "public"."rains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rain_tips" ADD CONSTRAINT "rain_tips_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_code_redemptions" ADD CONSTRAINT "promo_code_redemptions_ledger_tx_id_ledger_transactions_id_fk" FOREIGN KEY ("ledger_tx_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_code_redemptions" ADD CONSTRAINT "promo_code_redemptions_promo_code_id_promo_codes_id_fk" FOREIGN KEY ("promo_code_id") REFERENCES "public"."promo_codes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_code_redemptions" ADD CONSTRAINT "promo_code_redemptions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_feature_locks" ADD CONSTRAINT "user_feature_locks_locked_deposits_by_user_id_fk" FOREIGN KEY ("locked_deposits_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_feature_locks" ADD CONSTRAINT "user_feature_locks_locked_exchanges_by_user_id_fk" FOREIGN KEY ("locked_exchanges_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_feature_locks" ADD CONSTRAINT "user_feature_locks_locked_inventory_sales_by_user_id_fk" FOREIGN KEY ("locked_inventory_sales_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_feature_locks" ADD CONSTRAINT "user_feature_locks_locked_openings_by_user_id_fk" FOREIGN KEY ("locked_openings_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_feature_locks" ADD CONSTRAINT "user_feature_locks_locked_vault_by_user_id_fk" FOREIGN KEY ("locked_vault_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_feature_locks" ADD CONSTRAINT "user_feature_locks_locked_withdrawals_by_user_id_fk" FOREIGN KEY ("locked_withdrawals_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_feature_locks" ADD CONSTRAINT "user_feature_locks_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vaults" ADD CONSTRAINT "vaults_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_mutes" ADD CONSTRAINT "user_mutes_muted_by_user_id_fk" FOREIGN KEY ("muted_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_mutes" ADD CONSTRAINT "user_mutes_unmuted_by_user_id_fk" FOREIGN KEY ("unmuted_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_mutes" ADD CONSTRAINT "user_mutes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seed_rotation_history" ADD CONSTRAINT "seed_rotation_history_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_packs" ADD CONSTRAINT "user_packs_pack_id_packs_id_fk" FOREIGN KEY ("pack_id") REFERENCES "public"."packs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_packs" ADD CONSTRAINT "user_packs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_rewards" ADD CONSTRAINT "user_rewards_reward_id_rewards_id_fk" FOREIGN KEY ("reward_id") REFERENCES "public"."rewards"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_rewards" ADD CONSTRAINT "user_rewards_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wager_period_snapshots" ADD CONSTRAINT "wager_period_snapshots_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_session_pending_conversions" ADD CONSTRAINT "creator_session_pending_conversions_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."creator_stream_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_session_pending_conversions" ADD CONSTRAINT "creator_session_pending_conversions_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "public"."creator_deals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_session_pending_conversions" ADD CONSTRAINT "creator_session_pending_conversions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_session_pending_conversions" ADD CONSTRAINT "creator_session_pending_conversions_claim_ledger_id_fkey" FOREIGN KEY ("claim_ledger_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_leaderboard_snapshots" ADD CONSTRAINT "affiliate_leaderboard_snapshots_leaderboard_id_fkey" FOREIGN KEY ("leaderboard_id") REFERENCES "public"."affiliate_leaderboards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_leaderboard_snapshots" ADD CONSTRAINT "affiliate_leaderboard_snapshots_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_leaderboards" ADD CONSTRAINT "affiliate_leaderboards_creator_user_id_fkey" FOREIGN KEY ("creator_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raffle_entries" ADD CONSTRAINT "raffle_entries_raffle_id_raffles_id_fk" FOREIGN KEY ("raffle_id") REFERENCES "public"."raffles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raffle_entries" ADD CONSTRAINT "raffle_entries_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "battle_participants" ADD CONSTRAINT "battle_participants_source_session_id_fkey" FOREIGN KEY ("source_session_id") REFERENCES "public"."creator_stream_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "battle_participants" ADD CONSTRAINT "battle_participants_battle_id_battles_id_fk" FOREIGN KEY ("battle_id") REFERENCES "public"."battles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "battle_participants" ADD CONSTRAINT "battle_participants_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "battle_participants" ADD CONSTRAINT "battle_participants_game_session_id_game_sessions_id_fk" FOREIGN KEY ("game_session_id") REFERENCES "public"."game_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "battle_participants" ADD CONSTRAINT "battle_participants_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_leaderboard_claims" ADD CONSTRAINT "affiliate_leaderboard_claims_leaderboard_id_fkey" FOREIGN KEY ("leaderboard_id") REFERENCES "public"."affiliate_leaderboards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_leaderboard_claims" ADD CONSTRAINT "affiliate_leaderboard_claims_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_leaderboard_claims" ADD CONSTRAINT "affiliate_leaderboard_claims_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "public"."affiliate_leaderboard_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_socials" ADD CONSTRAINT "creator_socials_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_socials" ADD CONSTRAINT "creator_socials_reviewed_by_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leaderboard_funding_addresses" ADD CONSTRAINT "leaderboard_funding_addresses_leaderboard_id_fkey" FOREIGN KEY ("leaderboard_id") REFERENCES "public"."affiliate_leaderboards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leaderboard_funding_addresses" ADD CONSTRAINT "leaderboard_funding_addresses_creator_user_id_fkey" FOREIGN KEY ("creator_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leaderboard_funding_addresses" ADD CONSTRAINT "leaderboard_funding_addresses_vault_id_fkey" FOREIGN KEY ("vault_id") REFERENCES "public"."vaults"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_reply_to_id_fk" FOREIGN KEY ("reply_to_id") REFERENCES "public"."chat_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_embed_battle_id_fkey" FOREIGN KEY ("embed_battle_id") REFERENCES "public"."battles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_deleted_by_user_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_inventory" ADD CONSTRAINT "user_inventory_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_battle_limits" ADD CONSTRAINT "user_battle_limits_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rakeback_claims" ADD CONSTRAINT "rakeback_claims_ledger_tx_id_ledger_transactions_id_fk" FOREIGN KEY ("ledger_tx_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rakeback_claims" ADD CONSTRAINT "rakeback_claims_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upgrader_output_cards" ADD CONSTRAINT "upgrader_output_cards_card_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_leaderboard_claim_holds" ADD CONSTRAINT "affiliate_leaderboard_claim_holds_leaderboard_id_fkey" FOREIGN KEY ("leaderboard_id") REFERENCES "public"."affiliate_leaderboards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_leaderboard_claim_holds" ADD CONSTRAINT "affiliate_leaderboard_claim_holds_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_statistics" ADD CONSTRAINT "user_statistics_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "race_claim_holds" ADD CONSTRAINT "race_claim_holds_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coin_transactions" ADD CONSTRAINT "coin_transactions_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coin_transactions" ADD CONSTRAINT "coin_transactions_game_session_id_fk" FOREIGN KEY ("game_session_id") REFERENCES "public"."game_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_code_usages" ADD CONSTRAINT "affiliate_code_usages_affiliate_user_id_user_id_fk" FOREIGN KEY ("affiliate_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_code_usages" ADD CONSTRAINT "affiliate_code_usages_game_session_id_game_sessions_id_fk" FOREIGN KEY ("game_session_id") REFERENCES "public"."game_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_code_usages" ADD CONSTRAINT "affiliate_code_usages_referred_user_id_user_id_fk" FOREIGN KEY ("referred_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "battle_double_down_offers" ADD CONSTRAINT "battle_double_down_offers_battle_id_fk" FOREIGN KEY ("battle_id") REFERENCES "public"."battles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "battle_double_down_offers" ADD CONSTRAINT "battle_double_down_offers_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "battle_double_down_offers" ADD CONSTRAINT "battle_double_down_offers_game_session_id_fk" FOREIGN KEY ("game_session_id") REFERENCES "public"."game_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "keno_games" ADD CONSTRAINT "keno_games_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_kyc" ADD CONSTRAINT "user_kyc_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_provider_fees" ADD CONSTRAINT "payment_provider_fees_deposit_intent_id_fkey" FOREIGN KEY ("deposit_intent_id") REFERENCES "public"."fiat_deposit_intents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiat_deposit_intents" ADD CONSTRAINT "fiat_deposit_intents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiat_deposit_intents" ADD CONSTRAINT "fiat_deposit_intents_completed_ledger_id_fkey" FOREIGN KEY ("completed_ledger_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcement_reads" ADD CONSTRAINT "announcement_reads_announcement_id_fkey" FOREIGN KEY ("announcement_id") REFERENCES "public"."announcements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcement_reads" ADD CONSTRAINT "announcement_reads_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_battles_status_created_at" ON "battles" USING btree ("status" enum_ops,"created_at" timestamp_ops);--> statement-breakpoint
CREATE INDEX "idx_battles_user_id_status_created_at" ON "battles" USING btree ("user_id" enum_ops,"status" text_ops,"created_at" text_ops);--> statement-breakpoint
CREATE INDEX "idx_pf_inventory_item_id" ON "provably_fair_results" USING btree ("inventory_item_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_pf_result_metadata_gin" ON "provably_fair_results" USING gin ("result_metadata" jsonb_path_ops);--> statement-breakpoint
CREATE INDEX "idx_pf_result_metadata_pack_id_created_at" ON "provably_fair_results" USING btree (((result_metadata ->> 'pack_id'::text)) timestamp_ops,created_at text_ops);--> statement-breakpoint
CREATE INDEX "idx_pf_results_battle_id" ON "provably_fair_results" USING btree ("battle_id" uuid_ops) WHERE (battle_id IS NOT NULL);--> statement-breakpoint
CREATE INDEX "idx_pf_results_game_session_id" ON "provably_fair_results" USING btree ("game_session_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "affiliate_leaderboard_prize_tiers_leaderboard_idx" ON "affiliate_leaderboard_prize_tiers" USING btree ("leaderboard_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "creator_stream_sessions_auto_end_sweep_idx" ON "creator_stream_sessions" USING btree ("auto_end_at" timestamp_ops) WHERE ((status = 'active'::creator_stream_session_status) AND (auto_end_at IS NOT NULL));--> statement-breakpoint
CREATE INDEX "creator_stream_sessions_deal_idx" ON "creator_stream_sessions" USING btree ("deal_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "creator_stream_sessions_user_activated_idx" ON "creator_stream_sessions" USING btree ("user_id" text_ops,"activated_at" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "creator_stream_sessions_user_active_unique" ON "creator_stream_sessions" USING btree ("user_id" text_ops) WHERE (status = 'active'::creator_stream_session_status);--> statement-breakpoint
CREATE INDEX "creator_deals_user_status_idx" ON "creator_deals" USING btree ("user_id" text_ops,"status" text_ops);--> statement-breakpoint
CREATE INDEX "creator_deals_week_start_idx" ON "creator_deals" USING btree ("week_start_utc" timestamp_ops);--> statement-breakpoint
CREATE INDEX "creator_multiplier_deals_auto_end_idx" ON "creator_multiplier_deals" USING btree ("auto_end_at" timestamp_ops);--> statement-breakpoint
CREATE INDEX "creator_multiplier_deals_status_idx" ON "creator_multiplier_deals" USING btree ("status" enum_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "creator_multiplier_deals_user_active_unique" ON "creator_multiplier_deals" USING btree ("user_id" text_ops) WHERE (status = ANY (ARRAY['funded'::creator_multiplier_deal_status, 'live'::creator_multiplier_deal_status, 'pending_review'::creator_multiplier_deal_status, 'flagged'::creator_multiplier_deal_status]));--> statement-breakpoint
CREATE INDEX "creator_multiplier_deals_user_status_idx" ON "creator_multiplier_deals" USING btree ("user_id" text_ops,"status" text_ops);--> statement-breakpoint
CREATE INDEX "idx_upgrader_games_user_id_created_at" ON "upgrader_games" USING btree ("user_id" text_ops,"created_at" text_ops);--> statement-breakpoint
CREATE INDEX "user_wager_requirements_user_id_idx" ON "user_wager_requirements" USING btree ("user_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_game_sessions_bet_ledger_tx_id" ON "game_sessions" USING btree ("bet_ledger_tx_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_game_sessions_created_at_user_bet" ON "game_sessions" USING btree ("created_at" timestamp_ops,"user_id" timestamp_ops,"bet_amount" timestamp_ops) WHERE (user_id IS NOT NULL);--> statement-breakpoint
CREATE INDEX "idx_gs_game_id" ON "game_sessions" USING btree ("game_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_gs_game_type_created_at" ON "game_sessions" USING btree ("game_type" timestamp_ops,"created_at" enum_ops);--> statement-breakpoint
CREATE INDEX "idx_gs_user_id_created_at" ON "game_sessions" USING btree ("user_id" text_ops,"created_at" text_ops);--> statement-breakpoint
CREATE INDEX "idx_affiliate_codes_user_created_at" ON "affiliate_codes" USING btree ("user_id" text_ops,"created_at" text_ops);--> statement-breakpoint
CREATE INDEX "challenge_claims_user_status_idx" ON "challenge_claims" USING btree ("user_id" text_ops,"status" text_ops);--> statement-breakpoint
CREATE INDEX "challenge_requirements_challenge_idx" ON "challenge_requirements" USING btree ("challenge_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "challenge_requirements_kind_thresholds_idx" ON "challenge_requirements" USING btree ("kind" enum_ops,"min_bet_usd" enum_ops,"min_multiplier" enum_ops);--> statement-breakpoint
CREATE INDEX "challenge_requirements_pack_card_idx" ON "challenge_requirements" USING btree ("kind" enum_ops,"pack_id" enum_ops,"card_id" enum_ops);--> statement-breakpoint
CREATE INDEX "balances_active_stream_session_idx" ON "balances" USING btree ("active_stream_session_id" uuid_ops) WHERE (active_stream_session_id IS NOT NULL);--> statement-breakpoint
CREATE INDEX "idx_affiliate_clicks_code" ON "affiliate_clicks" USING btree ("code" text_ops);--> statement-breakpoint
CREATE INDEX "idx_affiliate_clicks_created_at" ON "affiliate_clicks" USING btree ("created_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_affiliate_clicks_ip" ON "affiliate_clicks" USING btree ("ip" text_ops);--> statement-breakpoint
CREATE INDEX "idx_cards_card_number" ON "cards" USING btree ("card_number" text_ops);--> statement-breakpoint
CREATE INDEX "idx_cards_set_id_created_at" ON "cards" USING btree ("set_id" timestamp_ops,"created_at" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_cards_type" ON "cards" USING btree ("type" text_ops);--> statement-breakpoint
CREATE INDEX "idx_account_user_id" ON "account" USING btree ("userId" text_ops);--> statement-breakpoint
CREATE INDEX "idx_cwr_status_completed_at" ON "card_withdrawal_requests" USING btree ("status" timestamp_ops,"completed_at" enum_ops);--> statement-breakpoint
CREATE INDEX "idx_cwr_user_id_status" ON "card_withdrawal_requests" USING btree ("user_id" text_ops,"status" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "idx_fingerprints_request_id" ON "fingerprints" USING btree ("request_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_fingerprints_user_id" ON "fingerprints" USING btree ("user_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_fingerprints_user_id_created_at" ON "fingerprints" USING btree ("user_id" text_ops,"created_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_fingerprints_visitor_id" ON "fingerprints" USING btree ("visitor_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_ledger_tx_created_at" ON "ledger_transactions" USING btree ("created_at" timestamp_ops);--> statement-breakpoint
CREATE INDEX "idx_ledger_tx_deposit_created_at" ON "ledger_transactions" USING btree ("created_at" timestamp_ops) WHERE (type = 'deposit'::ledger_transaction_type);--> statement-breakpoint
CREATE INDEX "idx_ledger_tx_game_session_id" ON "ledger_transactions" USING btree ("game_session_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_ledger_tx_metadata_affiliate_code" ON "ledger_transactions" USING btree (upper((metadata ->> 'affiliate_code'::text)) text_ops);--> statement-breakpoint
CREATE INDEX "idx_ledger_tx_status_type_created_at" ON "ledger_transactions" USING btree ("status" timestamp_ops,"type" enum_ops,"created_at" enum_ops);--> statement-breakpoint
CREATE INDEX "idx_ledger_tx_user_created_at" ON "ledger_transactions" USING btree ("user_id" text_ops,"created_at" timestamp_ops);--> statement-breakpoint
CREATE INDEX "idx_ledger_tx_user_created_at_completed" ON "ledger_transactions" USING btree ("user_id" timestamp_ops,"created_at" timestamp_ops) WHERE (status = 'completed'::ledger_transaction_status);--> statement-breakpoint
CREATE INDEX "idx_ledger_tx_user_type_status_created_at" ON "ledger_transactions" USING btree ("user_id" enum_ops,"type" text_ops,"status" enum_ops,"created_at" text_ops);--> statement-breakpoint
CREATE INDEX "idx_ledger_user_deposit_created" ON "ledger_transactions" USING btree ("user_id" text_ops,"created_at" timestamp_ops) WHERE ((type = 'deposit'::ledger_transaction_type) AND (status = 'completed'::ledger_transaction_status));--> statement-breakpoint
CREATE INDEX "race_snapshots_leaderboard_idx" ON "race_leaderboard_snapshots" USING btree ("race_type" int4_ops,"period_start" enum_ops,"position" date_ops);--> statement-breakpoint
CREATE INDEX "rain_tips_rain_id_idx" ON "rain_tips" USING btree ("rain_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_session_user_id" ON "session" USING btree ("userId" text_ops);--> statement-breakpoint
CREATE INDEX "creator_pending_conversions_session_idx" ON "creator_session_pending_conversions" USING btree ("session_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "creator_pending_conversions_user_status_idx" ON "creator_session_pending_conversions" USING btree ("user_id" text_ops,"status" text_ops);--> statement-breakpoint
CREATE INDEX "affiliate_leaderboard_snapshots_leaderboard_idx" ON "affiliate_leaderboard_snapshots" USING btree ("leaderboard_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "affiliate_leaderboard_snapshots_leaderboard_position_idx" ON "affiliate_leaderboard_snapshots" USING btree ("leaderboard_id" uuid_ops,"position" uuid_ops);--> statement-breakpoint
CREATE INDEX "affiliate_leaderboard_snapshots_user_idx" ON "affiliate_leaderboard_snapshots" USING btree ("user_id" text_ops);--> statement-breakpoint
CREATE INDEX "affiliate_leaderboards_active_idx" ON "affiliate_leaderboards" USING btree ("start_date" timestamp_ops,"end_date" timestamp_ops);--> statement-breakpoint
CREATE INDEX "affiliate_leaderboards_co_creators_gin_idx" ON "affiliate_leaderboards" USING gin ("co_creator_user_ids" array_ops);--> statement-breakpoint
CREATE INDEX "affiliate_leaderboards_creator_idx" ON "affiliate_leaderboards" USING btree ("creator_user_id" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "affiliate_leaderboards_creator_pending_unique" ON "affiliate_leaderboards" USING btree ("creator_user_id" text_ops) WHERE (approval_status = 'pending'::affiliate_leaderboard_approval_status);--> statement-breakpoint
CREATE INDEX "affiliate_leaderboards_creator_status_idx" ON "affiliate_leaderboards" USING btree ("creator_user_id" enum_ops,"approval_status" text_ops);--> statement-breakpoint
CREATE INDEX "affiliate_leaderboards_status_active_idx" ON "affiliate_leaderboards" USING btree ("approval_status" enum_ops,"start_date" timestamp_ops,"end_date" timestamp_ops);--> statement-breakpoint
CREATE INDEX "idx_vouchers_origin_created_at" ON "vouchers" USING btree ("origin" timestamp_ops,"created_at" enum_ops);--> statement-breakpoint
CREATE INDEX "idx_vouchers_origin_id" ON "vouchers" USING btree ("origin_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_vouchers_unclaimed_by_user" ON "vouchers" USING btree ("user_id" text_ops) WHERE (claimed_at IS NULL);--> statement-breakpoint
CREATE INDEX "idx_vouchers_user_id" ON "vouchers" USING btree ("user_id" text_ops);--> statement-breakpoint
CREATE INDEX "battle_participants_source_session_idx" ON "battle_participants" USING btree ("source_session_id" uuid_ops) WHERE (source_session_id IS NOT NULL);--> statement-breakpoint
CREATE INDEX "idx_battle_participants_battle_id" ON "battle_participants" USING btree ("battle_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_battle_participants_user_id_created_at" ON "battle_participants" USING btree ("user_id" timestamp_ops,"created_at" timestamp_ops) WHERE (user_id IS NOT NULL);--> statement-breakpoint
CREATE UNIQUE INDEX "affiliate_leaderboard_claims_leaderboard_user_unique" ON "affiliate_leaderboard_claims" USING btree ("leaderboard_id" text_ops,"user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "affiliate_leaderboard_claims_user_idx" ON "affiliate_leaderboard_claims" USING btree ("user_id" text_ops);--> statement-breakpoint
CREATE INDEX "creator_socials_status_idx" ON "creator_socials" USING btree ("status" enum_ops);--> statement-breakpoint
CREATE INDEX "creator_socials_user_status_idx" ON "creator_socials" USING btree ("user_id" text_ops,"status" text_ops);--> statement-breakpoint
CREATE INDEX "leaderboard_funding_addresses_address_asset_status_idx" ON "leaderboard_funding_addresses" USING btree ("address" text_ops,"asset_id" text_ops,"status" text_ops);--> statement-breakpoint
CREATE INDEX "leaderboard_funding_addresses_creator_status_idx" ON "leaderboard_funding_addresses" USING btree ("creator_user_id" text_ops,"status" text_ops);--> statement-breakpoint
CREATE INDEX "idx_chat_messages_created_at_user_id" ON "chat_messages" USING btree ("created_at" timestamp_ops,"user_id" timestamp_ops) WHERE (is_deleted = false);--> statement-breakpoint
CREATE INDEX "idx_chat_messages_embed_battle_id_created_at" ON "chat_messages" USING btree ("embed_battle_id" uuid_ops,"created_at" timestamp_ops);--> statement-breakpoint
CREATE INDEX "idx_chat_messages_reply_to_id" ON "chat_messages" USING btree ("reply_to_id" uuid_ops) WHERE (reply_to_id IS NOT NULL);--> statement-breakpoint
CREATE INDEX "idx_user_inv_card_id" ON "user_inventory" USING btree ("card_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_user_inv_open_by_user" ON "user_inventory" USING btree ("user_id" text_ops) WHERE ((sold_at IS NULL) AND (exchanged_at IS NULL) AND (withdrawal_locked_at IS NULL));--> statement-breakpoint
CREATE INDEX "idx_user_inv_owned_by_user" ON "user_inventory" USING btree ("user_id" text_ops) WHERE ((sold_at IS NULL) AND (exchanged_at IS NULL));--> statement-breakpoint
CREATE INDEX "idx_user_inventory_obtained_at" ON "user_inventory" USING btree ("obtained_at" timestamp_ops);--> statement-breakpoint
CREATE INDEX "idx_user_inventory_user_id_obtained_at" ON "user_inventory" USING btree ("user_id" text_ops,"obtained_at" text_ops);--> statement-breakpoint
CREATE INDEX "user_battle_limits_user_id_idx" ON "user_battle_limits" USING btree ("user_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_upgrader_output_cards_enabled" ON "upgrader_output_cards" USING btree ("enabled" bool_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_upgrader_output_cards_card_id" ON "upgrader_output_cards" USING btree ("card_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "affiliate_leaderboard_claim_holds_active_unique" ON "affiliate_leaderboard_claim_holds" USING btree ("leaderboard_id" text_ops,"user_id" text_ops) WHERE (released_at IS NULL);--> statement-breakpoint
CREATE INDEX "affiliate_leaderboard_claim_holds_leaderboard_idx" ON "affiliate_leaderboard_claim_holds" USING btree ("leaderboard_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "race_periods_active_per_type_idx" ON "race_periods" USING btree ("race_type" enum_ops) WHERE (status = 'active'::text);--> statement-breakpoint
CREATE INDEX "race_periods_recently_ended_idx" ON "race_periods" USING btree ("race_type" text_ops,"status" text_ops,"ends_at" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "race_claim_holds_active_unique" ON "race_claim_holds" USING btree ("user_id" date_ops,"race_type" date_ops,"race_period_start" date_ops) WHERE (released_at IS NULL);--> statement-breakpoint
CREATE INDEX "race_claim_holds_period_idx" ON "race_claim_holds" USING btree ("race_type" date_ops,"race_period_start" date_ops);--> statement-breakpoint
CREATE INDEX "idx_coin_transactions_user_id_created_at" ON "coin_transactions" USING btree ("user_id" text_ops,"created_at" text_ops);--> statement-breakpoint
CREATE INDEX "idx_acu_referred_user_created_at" ON "affiliate_code_usages" USING btree ("referred_user_id" text_ops,"created_at" timestamp_ops);--> statement-breakpoint
CREATE INDEX "idx_acu_upper_code" ON "affiliate_code_usages" USING btree (upper(code) text_ops);--> statement-breakpoint
CREATE INDEX "idx_affiliate_code_usages_affiliate_referred" ON "affiliate_code_usages" USING btree ("affiliate_user_id" text_ops,"referred_user_id" text_ops);--> statement-breakpoint
CREATE INDEX "challenges_game_type_status_idx" ON "challenges" USING btree ("game_type" enum_ops,"status" enum_ops);--> statement-breakpoint
CREATE INDEX "idx_battle_double_down_offers_status_expires" ON "battle_double_down_offers" USING btree ("status" enum_ops,"expires_at" timestamp_ops);--> statement-breakpoint
CREATE INDEX "idx_battle_double_down_offers_user_status" ON "battle_double_down_offers" USING btree ("user_id" text_ops,"status" enum_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_battle_double_down_offers_battle_user" ON "battle_double_down_offers" USING btree ("battle_id" uuid_ops,"user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_user_created_at" ON "user" USING btree ("created_at" text_ops,"id" timestamp_ops);--> statement-breakpoint
CREATE INDEX "idx_user_lower_display_username_prefix" ON "user" USING btree (lower(display_username) text_pattern_ops);--> statement-breakpoint
CREATE INDEX "idx_user_lower_email_prefix" ON "user" USING btree (lower(email) text_pattern_ops);--> statement-breakpoint
CREATE INDEX "idx_user_lower_name_prefix" ON "user" USING btree (lower(name) text_pattern_ops);--> statement-breakpoint
CREATE INDEX "idx_user_lower_username_prefix" ON "user" USING btree (lower(username) text_pattern_ops);--> statement-breakpoint
CREATE INDEX "idx_user_referred_by" ON "user" USING btree ("referred_by" text_ops) WHERE (referred_by IS NOT NULL);--> statement-breakpoint
CREATE INDEX "idx_user_role_banned_locked" ON "user" USING btree ("role" bool_ops,"is_banned" bool_ops,"is_locked" bool_ops);--> statement-breakpoint
CREATE INDEX "idx_user_signup_ip" ON "user" USING btree ("signup_ip" text_ops);--> statement-breakpoint
CREATE INDEX "notifications_user_created_idx" ON "notifications" USING btree ("user_id" text_ops,"created_at" timestamp_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_user_dedupe_uq" ON "notifications" USING btree ("user_id" text_ops,"dedupe_key" text_ops) WHERE (dedupe_key IS NOT NULL);--> statement-breakpoint
CREATE INDEX "notifications_user_unread_idx" ON "notifications" USING btree ("user_id" text_ops) WHERE (read_at IS NULL);--> statement-breakpoint
CREATE INDEX "announcements_active_idx" ON "announcements" USING btree ("starts_at" timestamp_ops) WHERE (revoked_at IS NULL);--> statement-breakpoint
CREATE INDEX "idx_keno_games_user_id_created_at" ON "keno_games" USING btree ("user_id" text_ops,"created_at" text_ops);--> statement-breakpoint
CREATE INDEX "idx_sumsub_webhook_events_applicant_created" ON "sumsub_webhook_events" USING btree ("applicant_id" text_ops,"provider_created_at" text_ops);--> statement-breakpoint
CREATE INDEX "idx_sumsub_webhook_events_external_user_created" ON "sumsub_webhook_events" USING btree ("external_user_id" timestamp_ops,"provider_created_at" timestamp_ops);--> statement-breakpoint
CREATE INDEX "idx_payment_provider_fees_payment" ON "payment_provider_fees" USING btree ("provider_payment_id" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_payment_provider_fees_intent_key" ON "payment_provider_fees" USING btree ("deposit_intent_id" text_ops,"fee_key" text_ops);--> statement-breakpoint
CREATE INDEX "idx_fiat_deposit_intents_status_updated" ON "fiat_deposit_intents" USING btree ("status" timestamp_ops,"updated_at" text_ops);--> statement-breakpoint
CREATE INDEX "idx_fiat_deposit_intents_user_created" ON "fiat_deposit_intents" USING btree ("user_id" text_ops,"created_at" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_fiat_deposit_intents_provider_checkout" ON "fiat_deposit_intents" USING btree ("provider" text_ops,"provider_checkout_id" text_ops) WHERE (provider_checkout_id IS NOT NULL);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_fiat_deposit_intents_provider_payment" ON "fiat_deposit_intents" USING btree ("provider" text_ops,"provider_payment_id" text_ops) WHERE (provider_payment_id IS NOT NULL);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_fiat_deposit_intents_user_idempotency" ON "fiat_deposit_intents" USING btree ("user_id" text_ops,"client_idempotency_key" text_ops);--> statement-breakpoint
CREATE INDEX "idx_payment_webhook_events_resource" ON "payment_webhook_events" USING btree ("provider" text_ops,"provider_resource_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_payment_webhook_events_status_received" ON "payment_webhook_events" USING btree ("processing_status" timestamp_ops,"received_at" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_payment_webhook_events_provider_event" ON "payment_webhook_events" USING btree ("provider" text_ops,"provider_event_id" text_ops);--> statement-breakpoint
CREATE VIEW "public"."pg_stat_statements_info" AS (SELECT dealloc, stats_reset FROM pg_stat_statements_info() pg_stat_statements_info(dealloc, stats_reset));--> statement-breakpoint
CREATE VIEW "public"."pg_stat_statements" AS (SELECT userid, dbid, toplevel, queryid, query, plans, total_plan_time, min_plan_time, max_plan_time, mean_plan_time, stddev_plan_time, calls, total_exec_time, min_exec_time, max_exec_time, mean_exec_time, stddev_exec_time, rows, shared_blks_hit, shared_blks_read, shared_blks_dirtied, shared_blks_written, local_blks_hit, local_blks_read, local_blks_dirtied, local_blks_written, temp_blks_read, temp_blks_written, shared_blk_read_time, shared_blk_write_time, local_blk_read_time, local_blk_write_time, temp_blk_read_time, temp_blk_write_time, wal_records, wal_fpi, wal_bytes, wal_buffers_full, jit_functions, jit_generation_time, jit_inlining_count, jit_inlining_time, jit_optimization_count, jit_optimization_time, jit_emission_count, jit_emission_time, jit_deform_count, jit_deform_time, parallel_workers_to_launch, parallel_workers_launched, stats_since, minmax_stats_since FROM pg_stat_statements(true) pg_stat_statements(userid, dbid, toplevel, queryid, query, plans, total_plan_time, min_plan_time, max_plan_time, mean_plan_time, stddev_plan_time, calls, total_exec_time, min_exec_time, max_exec_time, mean_exec_time, stddev_exec_time, rows, shared_blks_hit, shared_blks_read, shared_blks_dirtied, shared_blks_written, local_blks_hit, local_blks_read, local_blks_dirtied, local_blks_written, temp_blks_read, temp_blks_written, shared_blk_read_time, shared_blk_write_time, local_blk_read_time, local_blk_write_time, temp_blk_read_time, temp_blk_write_time, wal_records, wal_fpi, wal_bytes, wal_buffers_full, jit_functions, jit_generation_time, jit_inlining_count, jit_inlining_time, jit_optimization_count, jit_optimization_time, jit_emission_count, jit_emission_time, jit_deform_count, jit_deform_time, parallel_workers_to_launch, parallel_workers_launched, stats_since, minmax_stats_since));
*/