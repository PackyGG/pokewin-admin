import { pgTable, foreignKey, text, timestamp, jsonb, index, uuid, integer, numeric, boolean, unique, varchar, uniqueIndex, check, type AnyPgColumn, serial, inet, real, bigint, date, primaryKey, pgView, doublePrecision, pgEnum, customType } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

const oid = customType<{ data: number }>({
	dataType() {
		return "oid";
	},
});

export const affiliate_leaderboard_approval_status = pgEnum("affiliate_leaderboard_approval_status", ['pending', 'approved', 'rejected', 'awaiting_funding'])
export const affiliate_payout_status = pgEnum("affiliate_payout_status", ['pending', 'processing', 'paid', 'failed'])
export const affiliate_usage_type = pgEnum("affiliate_usage_type", ['signup', 'deposit', 'wager'])
export const audit_event_type = pgEnum("audit_event_type", ['login', 'login_failed', 'logout', 'register', 'register_failed', 'session_started', 'session_expired', 'kill_all_sessions', 'rate_limited', 'two_factor_enabled', 'two_factor_disabled', 'email_verification_sent', 'forgot_password_request', 'password_changed', 'password_reset', 'username_changed', 'email_updated', 'settings_changed', 'account_locked', 'account_unlocked', 'account_banned', 'account_unbanned', 'alt_account_detected', 'chat_muted', 'chat_unmuted', 'chat_banned', 'chat_unbanned', 'chat_message_deleted', 'chat_message_pinned', 'chat_message_unpinned', 'country_blocked', 'locked_deposits_crypto', 'locked_deposits_fiat', 'withdrawals_crypto_locked', 'withdrawals_crypto_unlocked', 'withdrawals_items_locked', 'withdrawals_items_unlocked', 'inventory_sales_locked', 'inventory_sales_unlocked', 'exchanges_locked', 'exchanges_unlocked', 'openings_locked', 'openings_unlocked', 'crypto_withdrawal_processed', 'error', 'admin_withdrawal_cancelled', 'admin_withdrawal_completed', 'admin_withdrawal_failed', 'affiliate_leaderboard_submitted', 'affiliate_leaderboard_approved', 'affiliate_leaderboard_rejected', 'affiliate_leaderboard_edited', 'affiliate_leaderboard_sponsored', 'affiliate_leaderboard_cancelled', 'affiliate_leaderboard_prize_claimed', 'creator_social_submitted', 'creator_social_approved', 'creator_social_rejected', 'creator_social_removed', 'role_changed', 'self_excluded', 'affiliate_leaderboard_hard_deleted', 'affiliate_leaderboard_claim_frozen', 'affiliate_leaderboard_claim_unfrozen', 'kyc_required', 'kyc_admin_reviewed', 'kyc_provider_result_received'])
export const balance_currency = pgEnum("balance_currency", ['real', 'coin'])
export const battle_double_down_result = pgEnum("battle_double_down_result", ['win', 'lose'])
export const battle_double_down_status = pgEnum("battle_double_down_status", ['offered', 'accepted', 'resolved', 'expired'])
export const battle_mode = pgEnum("battle_mode", ['normal', 'jackpot', 'group', 'hp_rush', 'lowest'])
export const battle_status = pgEnum("battle_status", ['waiting', 'in_progress', 'animating', 'completed', 'cancelled'])
export const card_withdrawal_method = pgEnum("card_withdrawal_method", ['physical', 'crypto', 'balance'])
export const card_withdrawal_status = pgEnum("card_withdrawal_status", ['pending', 'processing', 'shipped', 'completed', 'failed', 'cancelled'])
export const challenge_claim_status = pgEnum("challenge_claim_status", ['eligible', 'claimed'])
export const challenge_percent_op = pgEnum("challenge_percent_op", ['lte', 'gte', 'eq'])
export const challenge_requirement_kind = pgEnum("challenge_requirement_kind", ['pack_pull', 'upgrader'])
export const challenge_status = pgEnum("challenge_status", ['active', 'inactive', 'archived'])
export const challenge_type = pgEnum("challenge_type", ['pack_pull', 'upgrader'])
export const chat_message_embed_type = pgEnum("chat_message_embed_type", ['battle'])
export const coin_transaction_type = pgEnum("coin_transaction_type", ['coin_deposit_grant', 'coin_pack_bet', 'coin_pack_payout', 'coin_battle_bet', 'coin_battle_payout', 'coin_battle_refund', 'coin_upgrader_bet', 'coin_upgrader_payout', 'coin_admin_adjustment', 'coin_rain_tip', 'coin_rain_win', 'coin_keno_bet', 'coin_keno_payout'])
export const creator_deal_status = pgEnum("creator_deal_status", ['scheduled', 'active', 'completed', 'terminated'])
export const creator_multiplier_deal_status = pgEnum("creator_multiplier_deal_status", ['pending_deposit', 'funded', 'live', 'pending_review', 'flagged', 'approved', 'rejected', 'cancelled', 'completed'])
export const creator_pending_conversion_source = pgEnum("creator_pending_conversion_source", ['battle_win', 'battle_refund'])
export const creator_pending_conversion_status = pgEnum("creator_pending_conversion_status", ['pending', 'claimed'])
export const creator_social_platform = pgEnum("creator_social_platform", ['twitch', 'kick', 'youtube', 'x', 'instagram', 'tiktok', 'discord'])
export const creator_social_status = pgEnum("creator_social_status", ['pending', 'approved', 'rejected'])
export const creator_stream_session_status = pgEnum("creator_stream_session_status", ['active', 'ended', 'converted'])
export const fingerprint_event_type = pgEnum("fingerprint_event_type", ['login', 'signup'])
export const game_session_result = pgEnum("game_session_result", ['win', 'lose', 'draw'])
export const game_type = pgEnum("game_type", ['pack', 'battle', 'upgrader', 'battle_double_down', 'keno'])
export const gift_card_region = pgEnum("gift_card_region", ['NA', 'EU'])
export const keno_risk = pgEnum("keno_risk", ['low', 'medium', 'high'])
export const kyc_admin_decision = pgEnum("kyc_admin_decision", ['pending', 'safe', 'rejected'])
export const kyc_status = pgEnum("kyc_status", ['none', 'pending', 'on_hold', 'approved', 'rejected'])
export const ledger_transaction_status = pgEnum("ledger_transaction_status", ['pending', 'completed', 'failed'])
export const ledger_transaction_type = pgEnum("ledger_transaction_type", ['deposit', 'pack_opening', 'battle_bet', 'battle_sponsorship', 'battle_refund', 'card_sale', 'reward_card_sale', 'card_exchange', 'exchange_excess_to_voucher', 'exchange_excess_credit', 'battle_excess_to_voucher', 'voucher_redeemed', 'voucher_exchange', 'deposit_bonus', 'vault_lock', 'vault_unlock', 'race_prize', 'gift_card_redeemed', 'promo_code_redeemed', 'rakeback_claim', 'balance_reward_claim', 'affiliate_claim', 'withdrawal_shipping_fee', 'admin_balance_adjustment', 'rain_tip', 'rain_win', 'creator_tip', 'waitlist_prize', 'pack_borrow_to_voucher', 'card_withdrawal', 'creator_deal_fill_grant', 'creator_fill_activation', 'creator_fill_spend_tip', 'creator_fill_spend_battle', 'creator_fill_refund', 'creator_fill_conversion', 'creator_fill_forfeiture', 'affiliate_leaderboard_creation', 'affiliate_leaderboard_refund', 'affiliate_leaderboard_prize', 'creator_multiplier_deposit_lock', 'creator_multiplier_deposit_topup', 'creator_multiplier_platform_credit', 'creator_multiplier_spend_wager', 'creator_multiplier_spend_tip', 'creator_multiplier_spend_battle', 'creator_multiplier_refund', 'creator_multiplier_settlement_payout', 'creator_multiplier_settlement_deposit_return', 'creator_multiplier_forfeiture', 'creator_lb_deposit', 'upgrader_bet', 'upgrader_payout', 'balance_withdrawal', 'challenge_prize', 'xp_purchase', 'keno_bet', 'keno_payout'])
export const notification_category = pgEnum("notification_category", ['transaction', 'rewards', 'system', 'news'])
export const pack_tag = pgEnum("pack_tag", ['%1', '%5', '%10', '50/50', 'onepiece'])
export const race_type = pgEnum("race_type", ['daily', 'weekly', 'monthly'])
export const raffle_status = pgEnum("raffle_status", ['active', 'completed', 'cancelled'])
export const rain_status = pgEnum("rain_status", ['active', 'drawing', 'completed', 'cancelled'])
export const rakeback_type = pgEnum("rakeback_type", ['daily', 'weekly', 'monthly'])
export const region_code = pgEnum("region_code", ['NA', 'EU'])
export const reward_type = pgEnum("reward_type", ['one_time', 'daily', 'balance'])
export const source_type = pgEnum("source_type", ['pack', 'reward', 'battle', 'exchange', 'raffle', 'upgrader'])
export const user_role = pgEnum("user_role", ['user', 'support', 'admin', 'creator'])
export const voucher_origin = pgEnum("voucher_origin", ['exchange_excess_to_voucher', 'battle_excess_to_voucher', 'pack_borrow_to_voucher', 'creator_fill_conversion', 'creator_multiplier_payout', 'upgrader_excess_to_voucher', 'battle_double_down_payout'])


export const affiliate_code_queue = pgTable("affiliate_code_queue", {
	user_id: text().primaryKey().notNull(),
	code: text().notNull(),
	expires_at: timestamp({ mode: 'string' }).notNull(),
	metadata: jsonb(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [user.id],
			name: "affiliate_code_queue_user_id_user_id_fk"
		}).onDelete("cascade"),
]);

export const battles = pgTable("battles", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	user_id: text().notNull(),
	mode: battle_mode().notNull(),
	pack_ids: text().array().notNull(),
	teams: integer().notNull(),
	players_per_team: integer().notNull(),
	status: battle_status().notNull(),
	bet_amount: numeric({ precision: 20, scale:  2 }).notNull(),
	winner_team: integer(),
	server_seed: text().notNull(),
	server_seed_hash: text().notNull(),
	eos_block_hash: text(),
	region_code: region_code().default('NA').notNull(),
	additional_settings: text().array().default(sql`'{}'::text[]`).notNull(),
	animation_complete_at: timestamp({ mode: 'string' }),
	password: text(),
	sponsorship_percentage: integer().default(0).notNull(),
	sponsorship_amount_paid: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	borrow_percentage: integer().default(0).notNull(),
	total_unpacked: numeric({ precision: 20, scale:  2 }),
	pending_distribution_data: jsonb(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	affiliated_only: boolean().default(false).notNull(),
	affiliated_min_wager: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	currency: balance_currency().default('real').notNull(),
}, (table) => [
	index("idx_battles_status_created_at").using("btree", table.status.asc().nullsLast().op("enum_ops"), table.created_at.asc().nullsLast().op("timestamp_ops")),
	index("idx_battles_user_id_status_created_at").using("btree", table.user_id.asc().nullsLast().op("enum_ops"), table.status.asc().nullsLast().op("text_ops"), table.created_at.desc().nullsFirst().op("text_ops")),
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [user.id],
			name: "battles_user_id_user_id_fk"
		}).onDelete("cascade"),
]);

export const battle_backgrounds = pgTable("battle_backgrounds", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: varchar({ length: 100 }).notNull(),
	image_url: text().notNull(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	unique("battle_backgrounds_name_unique").on(table.name),
]);

export const country_restrictions = pgTable("country_restrictions", {
	country_code: text().primaryKey().notNull(),
	blocked: boolean().default(false).notNull(),
	physical_withdrawal: boolean().default(true).notNull(),
	digital_withdrawal: boolean().default(true).notNull(),
	gift_card_deposit: boolean().default(true).notNull(),
	promo_code_deposit: boolean().default(true).notNull(),
	locked_deposits_crypto: text().array().default(sql`'{}'::text[]`).notNull(),
	locked_deposits_fiat: text().array().default(sql`'{}'::text[]`).notNull(),
	locked_withdrawals_crypto: text().array().default(sql`'{}'::text[]`).notNull(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
});

export const deposit_addresses = pgTable("deposit_addresses", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	user_id: text().notNull(),
	vault_id: uuid().notNull(),
	asset_id: text().notNull(),
	address: text().notNull(),
	tag: text(),
	legacy_address: text(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [user.id],
			name: "deposit_addresses_user_id_user_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.vault_id],
			foreignColumns: [vaults.id],
			name: "deposit_addresses_vault_id_vaults_id_fk"
		}).onDelete("cascade"),
]);

export const rewards = pgTable("rewards", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	slug: text().notNull(),
	name: text().notNull(),
	pack_ids: uuid().array(),
	metadata: jsonb(),
	type: reward_type().default('one_time').notNull(),
	level_required: integer().default(0).notNull(),
	cash_amount: numeric({ precision: 10, scale:  2 }),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	daily_unlock_percentage: numeric({ precision: 6, scale:  4 }),
}, (table) => [
	unique("rewards_slug_unique").on(table.slug),
]);

export const provably_fair_results = pgTable("provably_fair_results", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	game_session_id: uuid().notNull(),
	battle_id: uuid(),
	inventory_item_id: uuid(),
	client_seed: text().notNull(),
	server_seed: text(),
	server_seed_hash: text().notNull(),
	nonce: integer().notNull(),
	cursor: integer().default(0).notNull(),
	ticket: integer().notNull(),
	result_hash: text().notNull(),
	result_metadata: jsonb(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_pf_inventory_item_id").using("btree", table.inventory_item_id.asc().nullsLast().op("uuid_ops")),
	index("idx_pf_result_metadata_gin").using("gin", table.result_metadata.asc().nullsLast().op("jsonb_path_ops")),
	index("idx_pf_result_metadata_pack_id_created_at").using("btree", sql`((result_metadata ->> 'pack_id'::text))`, sql`created_at`),
	index("idx_pf_results_battle_id").using("btree", table.battle_id.asc().nullsLast().op("uuid_ops")).where(sql`(battle_id IS NOT NULL)`),
	index("idx_pf_results_game_session_id").using("btree", table.game_session_id.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.battle_id],
			foreignColumns: [battles.id],
			name: "provably_fair_results_battle_id_battles_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.game_session_id],
			foreignColumns: [game_sessions.id],
			name: "provably_fair_results_game_session_id_game_sessions_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.inventory_item_id],
			foreignColumns: [user_inventory.id],
			name: "provably_fair_results_inventory_item_id_user_inventory_id_fk"
		}).onDelete("cascade"),
]);

export const shipping_addresses = pgTable("shipping_addresses", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	user_id: text().notNull(),
	first_name: text().notNull(),
	last_name: text().notNull(),
	phone_country_code: text().notNull(),
	phone_number: text().notNull(),
	address_line_1: text().notNull(),
	address_line_2: text(),
	city: text().notNull(),
	zip_code: text().notNull(),
	state_province: text(),
	country: text().notNull(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [user.id],
			name: "shipping_addresses_user_id_user_id_fk"
		}).onDelete("cascade"),
	unique("shipping_addresses_user_id_unique").on(table.user_id),
]);

export const verification = pgTable("verification", {
	id: text().primaryKey().notNull(),
	identifier: text().notNull(),
	value: text().notNull(),
	expires_at: timestamp({ mode: 'string' }).notNull(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
});

export const affiliate_leaderboard_prize_tiers = pgTable("affiliate_leaderboard_prize_tiers", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	leaderboard_id: uuid().notNull(),
	position: integer().notNull(),
	prize_amount_usd: numeric({ precision: 20, scale:  2 }).notNull(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("affiliate_leaderboard_prize_tiers_leaderboard_idx").using("btree", table.leaderboard_id.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.leaderboard_id],
			foreignColumns: [affiliate_leaderboards.id],
			name: "affiliate_leaderboard_prize_tiers_leaderboard_id_fkey"
		}).onDelete("cascade"),
	unique("affiliate_leaderboard_prize_tiers_unique").on(table.leaderboard_id, table.position),
]);

export const creator_stream_sessions = pgTable("creator_stream_sessions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	deal_id: uuid().notNull(),
	user_id: text().notNull(),
	status: creator_stream_session_status().default('active').notNull(),
	activated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	first_bet_at: timestamp({ mode: 'string' }),
	ended_at: timestamp({ mode: 'string' }),
	converted_at: timestamp({ mode: 'string' }),
	fill_loaded_usd: numeric({ precision: 20, scale:  2 }).notNull(),
	fill_spent_usd: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	fill_refunded_usd: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	fill_remaining_usd: numeric({ precision: 20, scale:  2 }).notNull(),
	ending_balance_usd: numeric({ precision: 20, scale:  2 }),
	conversion_rate_bps_snapshot: integer(),
	converted_to_raw_usd: numeric({ precision: 20, scale:  2 }),
	activation_ledger_id: uuid(),
	conversion_ledger_id: uuid(),
	version: integer().default(1).notNull(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	tips_spent_this_session_usd: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	sponsorship_spent_this_session_usd: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	auto_end_at: timestamp({ mode: 'string' }),
}, (table) => [
	index("creator_stream_sessions_auto_end_sweep_idx").using("btree", table.auto_end_at.asc().nullsLast().op("timestamp_ops")).where(sql`((status = 'active'::creator_stream_session_status) AND (auto_end_at IS NOT NULL))`),
	index("creator_stream_sessions_deal_idx").using("btree", table.deal_id.asc().nullsLast().op("uuid_ops")),
	index("creator_stream_sessions_user_activated_idx").using("btree", table.user_id.asc().nullsLast().op("text_ops"), table.activated_at.asc().nullsLast().op("text_ops")),
	uniqueIndex("creator_stream_sessions_user_active_unique").using("btree", table.user_id.asc().nullsLast().op("text_ops")).where(sql`(status = 'active'::creator_stream_session_status)`),
	foreignKey({
			columns: [table.deal_id],
			foreignColumns: [creator_deals.id],
			name: "creator_stream_sessions_deal_id_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [user.id],
			name: "creator_stream_sessions_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.activation_ledger_id],
			foreignColumns: [ledger_transactions.id as AnyPgColumn],
			name: "creator_stream_sessions_activation_ledger_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.conversion_ledger_id],
			foreignColumns: [ledger_transactions.id],
			name: "creator_stream_sessions_conversion_ledger_id_fkey"
		}).onDelete("set null"),
	check("creator_stream_sessions_fill_non_negative", sql`(fill_loaded_usd >= (0)::numeric) AND (fill_spent_usd >= (0)::numeric) AND (fill_refunded_usd >= (0)::numeric) AND (fill_remaining_usd >= (0)::numeric)`),
	check("creator_stream_sessions_conversion_snapshot_range", sql`(conversion_rate_bps_snapshot IS NULL) OR ((conversion_rate_bps_snapshot >= 0) AND (conversion_rate_bps_snapshot <= 10000))`),
	check("creator_stream_sessions_spend_counters_non_negative", sql`(tips_spent_this_session_usd >= (0)::numeric) AND (sponsorship_spent_this_session_usd >= (0)::numeric)`),
]);

export const creator_deals = pgTable("creator_deals", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	user_id: text().notNull(),
	week_start_utc: timestamp({ mode: 'string' }).notNull(),
	week_end_utc: timestamp({ mode: 'string' }).notNull(),
	status: creator_deal_status().default('scheduled').notNull(),
	fills_allowed: integer().notNull(),
	fills_used: integer().default(0).notNull(),
	per_fill_amount_usd: numeric({ precision: 20, scale:  2 }).notNull(),
	conversion_rate_bps: integer().notNull(),
	cooldown_minutes: integer().default(240).notNull(),
	max_tip_per_stream_usd: numeric({ precision: 20, scale:  2 }).notNull(),
	max_tip_per_user_usd: numeric({ precision: 20, scale:  2 }).notNull(),
	max_sponsored_battle_usd: numeric({ precision: 20, scale:  2 }).notNull(),
	allow_site_leaderboards: boolean().default(false).notNull(),
	allow_code_leaderboards: boolean().default(false).notNull(),
	terms: jsonb(),
	created_by: text(),
	version: integer().default(1).notNull(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	max_sponsorship_per_stream_usd: numeric({ precision: 20, scale:  2 }).notNull(),
	total_withdraw_cap_usd: numeric({ precision: 20, scale:  2 }),
	withdraw_cap_used_usd: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
}, (table) => [
	index("creator_deals_user_status_idx").using("btree", table.user_id.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
	index("creator_deals_week_start_idx").using("btree", table.week_start_utc.asc().nullsLast().op("timestamp_ops")),
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [user.id],
			name: "creator_deals_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.created_by],
			foreignColumns: [user.id],
			name: "creator_deals_created_by_fkey"
		}).onDelete("set null"),
	unique("creator_deals_user_week_unique").on(table.user_id, table.week_start_utc),
	check("creator_deals_week_range", sql`week_end_utc > week_start_utc`),
	check("creator_deals_fills_allowed_positive", sql`fills_allowed > 0`),
	check("creator_deals_fills_used_range", sql`(fills_used >= 0) AND (fills_used <= fills_allowed)`),
	check("creator_deals_per_fill_amount_positive", sql`per_fill_amount_usd > (0)::numeric`),
	check("creator_deals_conversion_rate_range", sql`(conversion_rate_bps >= 0) AND (conversion_rate_bps <= 10000)`),
	check("creator_deals_cooldown_non_negative", sql`cooldown_minutes >= 0`),
	check("creator_deals_tip_limits_non_negative", sql`(max_tip_per_stream_usd >= (0)::numeric) AND (max_tip_per_user_usd >= (0)::numeric) AND (max_sponsored_battle_usd >= (0)::numeric)`),
	check("creator_deals_withdraw_cap_non_negative", sql`(total_withdraw_cap_usd IS NULL) OR (total_withdraw_cap_usd >= (0)::numeric)`),
	check("creator_deals_withdraw_cap_used_non_negative", sql`withdraw_cap_used_usd >= (0)::numeric`),
	check("creator_deals_withdraw_cap_used_within_total", sql`(total_withdraw_cap_usd IS NULL) OR (withdraw_cap_used_usd <= total_withdraw_cap_usd)`),
]);

export const pinned_chat_messages = pgTable("pinned_chat_messages", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	message_id: uuid().notNull(),
	pinned_by: text().notNull(),
	pinned_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.message_id],
			foreignColumns: [chat_messages.id],
			name: "pinned_chat_messages_message_id_chat_messages_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.pinned_by],
			foreignColumns: [user.id],
			name: "pinned_chat_messages_pinned_by_user_id_fk"
		}).onDelete("cascade"),
	unique("pinned_chat_messages_message_id_unique").on(table.message_id),
]);

export const _affiliate_migrations = pgTable("_affiliate_migrations", {
	name: text().primaryKey().notNull(),
	applied_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const creator_multiplier_deals = pgTable("creator_multiplier_deals", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	user_id: text().notNull(),
	status: creator_multiplier_deal_status().default('pending_deposit').notNull(),
	required_deposit_usd: numeric({ precision: 20, scale:  2 }).notNull(),
	multiplier_bps: integer().notNull(),
	withdrawable_bps: integer().default(2000).notNull(),
	wager_requirement_bps: integer().default(10000).notNull(),
	max_total_wager_usd: numeric({ precision: 20, scale:  2 }),
	max_payout_usd: numeric({ precision: 20, scale:  2 }),
	min_session_duration_seconds: integer().default(1800).notNull(),
	min_bet_count: integer().default(20).notNull(),
	min_wager_to_funding_ratio_bps: integer().default(5000).notNull(),
	terms_text: text().notNull(),
	terms_version: text().notNull(),
	tos_accepted_at: timestamp({ mode: 'string' }),
	tos_accepted_ip: text(),
	deposit_locked_at: timestamp({ mode: 'string' }),
	activated_at: timestamp({ mode: 'string' }),
	ended_at: timestamp({ mode: 'string' }),
	auto_end_at: timestamp({ mode: 'string' }),
	reviewed_at: timestamp({ mode: 'string' }),
	settled_at: timestamp({ mode: 'string' }),
	user_funding_usd: numeric({ precision: 20, scale:  2 }),
	platform_funding_usd: numeric({ precision: 20, scale:  2 }),
	total_loaded_usd: numeric({ precision: 20, scale:  2 }),
	fill_spent_usd: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	fill_refunded_usd: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	fill_remaining_usd: numeric({ precision: 20, scale:  2 }),
	wager_accumulated_usd: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	bet_count: integer().default(0).notNull(),
	tips_spent_this_session_usd: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	sponsorship_spent_this_session_usd: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	ending_balance_usd: numeric({ precision: 20, scale:  2 }),
	kick_vod_url: text(),
	kick_vod_required: boolean().default(true).notNull(),
	flagged_reasons: jsonb(),
	review_decision: text(),
	review_reason: text(),
	reviewed_by: text(),
	withdrawable_voucher_usd: numeric({ precision: 20, scale:  2 }),
	forfeited_usd: numeric({ precision: 20, scale:  2 }),
	deposit_refunded_usd: numeric({ precision: 20, scale:  2 }),
	deposit_forfeited_usd: numeric({ precision: 20, scale:  2 }),
	payout_voucher_id: uuid(),
	deposit_ledger_id: uuid(),
	settlement_ledger_id: uuid(),
	state_log: jsonb(),
	created_by: text(),
	version: integer().default(1).notNull(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	auto_renew: boolean().default(true).notNull(),
}, (table) => [
	index("creator_multiplier_deals_auto_end_idx").using("btree", table.auto_end_at.asc().nullsLast().op("timestamp_ops")),
	index("creator_multiplier_deals_status_idx").using("btree", table.status.asc().nullsLast().op("enum_ops")),
	uniqueIndex("creator_multiplier_deals_user_active_unique").using("btree", table.user_id.asc().nullsLast().op("text_ops")).where(sql`(status = ANY (ARRAY['funded'::creator_multiplier_deal_status, 'live'::creator_multiplier_deal_status, 'pending_review'::creator_multiplier_deal_status, 'flagged'::creator_multiplier_deal_status]))`),
	index("creator_multiplier_deals_user_status_idx").using("btree", table.user_id.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [user.id],
			name: "creator_multiplier_deals_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.reviewed_by],
			foreignColumns: [user.id],
			name: "creator_multiplier_deals_reviewed_by_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.deposit_ledger_id],
			foreignColumns: [ledger_transactions.id],
			name: "creator_multiplier_deals_deposit_ledger_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.settlement_ledger_id],
			foreignColumns: [ledger_transactions.id],
			name: "creator_multiplier_deals_settlement_ledger_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.created_by],
			foreignColumns: [user.id],
			name: "creator_multiplier_deals_created_by_fkey"
		}).onDelete("set null"),
	check("creator_multiplier_deals_required_deposit_positive", sql`required_deposit_usd > (0)::numeric`),
	check("creator_multiplier_deals_multiplier_min", sql`multiplier_bps >= 10000`),
	check("creator_multiplier_deals_withdrawable_bps_range", sql`(withdrawable_bps >= 0) AND (withdrawable_bps <= 10000)`),
	check("creator_multiplier_deals_wager_req_non_negative", sql`wager_requirement_bps >= 0`),
	check("creator_multiplier_deals_max_total_wager_non_neg", sql`(max_total_wager_usd IS NULL) OR (max_total_wager_usd >= (0)::numeric)`),
	check("creator_multiplier_deals_max_payout_non_neg", sql`(max_payout_usd IS NULL) OR (max_payout_usd >= (0)::numeric)`),
	check("creator_multiplier_deals_fill_remaining_non_neg", sql`(fill_remaining_usd IS NULL) OR (fill_remaining_usd >= (0)::numeric)`),
	check("creator_multiplier_deals_fill_spent_non_neg", sql`fill_spent_usd >= (0)::numeric`),
	check("creator_multiplier_deals_bet_count_non_neg", sql`bet_count >= 0`),
]);

export const upgrader_games = pgTable("upgrader_games", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	user_id: text().notNull(),
	bet_amount: numeric({ precision: 20, scale:  2 }).notNull(),
	won_amount: numeric({ precision: 20, scale:  2 }).notNull(),
	cashout_multiplier: numeric({ precision: 10, scale:  4 }).notNull(),
	win_percentage: numeric({ precision: 5, scale:  2 }).notNull(),
	segments: jsonb().notNull(),
	bet_ledger_tx_id: uuid(),
	payout_ledger_tx_id: uuid(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	target_card_id: uuid(),
	awarded_inventory_item_id: uuid(),
	voucher_id: uuid(),
}, (table) => [
	index("idx_upgrader_games_user_id_created_at").using("btree", table.user_id.asc().nullsLast().op("text_ops"), table.created_at.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [user.id],
			name: "upgrader_games_user_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.target_card_id],
			foreignColumns: [cards.id],
			name: "upgrader_games_target_card_id_fk"
		}).onDelete("set null"),
]);

export const user_wager_requirements = pgTable("user_wager_requirements", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	user_id: text().notNull(),
	wager_requirement_bps: integer().notNull(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	bonus_wager_requirement_bps: integer(),
	affiliate_wager_requirement_bps: integer(),
	rakeback_wager_requirement_bps: integer(),
	tips_wager_requirement_bps: integer(),
	admin_adjustment_wager_requirement_bps: integer(),
	affiliate_leaderboard_wager_requirement_bps: integer(),
}, (table) => [
	index("user_wager_requirements_user_id_idx").using("btree", table.user_id.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [user.id],
			name: "user_wager_requirements_user_id_fkey"
		}).onDelete("cascade"),
	unique("user_wager_requirements_user_id_key").on(table.user_id),
]);

export const game_sessions = pgTable("game_sessions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	user_id: text(),
	bot_id: uuid(),
	game_type: game_type().notNull(),
	game_id: uuid().notNull(),
	bet_amount: numeric({ precision: 20, scale:  2 }).notNull(),
	result: game_session_result(),
	bet_ledger_tx_id: uuid(),
	user_reward_id: uuid(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	race_eligible: boolean().default(true).notNull(),
	currency: balance_currency().default('real').notNull(),
	weighted_bet_amount: numeric({ precision: 20, scale:  2 }),
	bet_from_race_prize: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	bet_from_bonus_other: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	bet_from_rakeback: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	bet_from_affiliate: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	bet_from_tips: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	rakeback_eligible: boolean().default(true).notNull(),
}, (table) => [
	index("idx_game_sessions_bet_ledger_tx_id").using("btree", table.bet_ledger_tx_id.asc().nullsLast().op("uuid_ops")),
	index("idx_game_sessions_created_at_user_bet").using("btree", table.created_at.asc().nullsLast().op("timestamp_ops"), table.user_id.asc().nullsLast().op("timestamp_ops"), table.bet_amount.asc().nullsLast().op("timestamp_ops")).where(sql`(user_id IS NOT NULL)`),
	index("idx_gs_game_id").using("btree", table.game_id.asc().nullsLast().op("uuid_ops")),
	index("idx_gs_game_type_created_at").using("btree", table.game_type.asc().nullsLast().op("timestamp_ops"), table.created_at.desc().nullsFirst().op("enum_ops")),
	index("idx_gs_user_id_created_at").using("btree", table.user_id.asc().nullsLast().op("text_ops"), table.created_at.desc().nullsFirst().op("text_ops")),
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [user.id],
			name: "game_sessions_user_id_user_id_fk"
		}).onDelete("cascade"),
]);

export const affiliate_codes = pgTable("affiliate_codes", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	user_id: text().notNull(),
	code: text().notNull(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_affiliate_codes_user_created_at").using("btree", table.user_id.asc().nullsLast().op("text_ops"), table.created_at.desc().nullsFirst().op("text_ops")),
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [user.id],
			name: "affiliate_codes_user_id_user_id_fk"
		}).onDelete("cascade"),
	unique("affiliate_codes_code_unique").on(table.code),
]);

export const challenge_claims = pgTable("challenge_claims", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	challenge_id: uuid().notNull(),
	user_id: text().notNull(),
	status: challenge_claim_status().default('eligible').notNull(),
	eligible_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	claimed_at: timestamp({ mode: 'string' }),
	source_game_session_id: text(),
	prize_ledger_id: uuid(),
	version: integer().default(1).notNull(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("challenge_claims_user_status_idx").using("btree", table.user_id.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.challenge_id],
			foreignColumns: [challenges.id],
			name: "challenge_claims_challenge_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [user.id],
			name: "challenge_claims_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.prize_ledger_id],
			foreignColumns: [ledger_transactions.id],
			name: "challenge_claims_prize_ledger_id_fkey"
		}).onDelete("set null"),
	unique("challenge_claims_challenge_user_unique").on(table.challenge_id, table.user_id),
]);

export const affiliate_payouts = pgTable("affiliate_payouts", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	affiliate_user_id: text().notNull(),
	amount_usd: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	status: affiliate_payout_status().default('pending').notNull(),
	metadata: jsonb(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.affiliate_user_id],
			foreignColumns: [user.id],
			name: "affiliate_payouts_affiliate_user_id_user_id_fk"
		}).onDelete("cascade"),
]);

export const challenge_requirements = pgTable("challenge_requirements", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	challenge_id: uuid().notNull(),
	kind: challenge_requirement_kind().notNull(),
	pack_id: uuid(),
	card_id: uuid(),
	win_percentage: numeric({ precision: 5, scale:  2 }),
	percent_op: challenge_percent_op(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	min_bet_usd: numeric({ precision: 20, scale:  2 }),
	min_multiplier: numeric({ precision: 10, scale:  4 }),
}, (table) => [
	index("challenge_requirements_challenge_idx").using("btree", table.challenge_id.asc().nullsLast().op("uuid_ops")),
	index("challenge_requirements_kind_thresholds_idx").using("btree", table.kind.asc().nullsLast().op("enum_ops"), table.min_bet_usd.asc().nullsLast().op("enum_ops"), table.min_multiplier.asc().nullsLast().op("enum_ops")),
	index("challenge_requirements_pack_card_idx").using("btree", table.kind.asc().nullsLast().op("enum_ops"), table.pack_id.asc().nullsLast().op("enum_ops"), table.card_id.asc().nullsLast().op("enum_ops")),
	foreignKey({
			columns: [table.challenge_id],
			foreignColumns: [challenges.id],
			name: "challenge_requirements_challenge_id_fkey"
		}).onDelete("cascade"),
	check("challenge_requirements_shape", sql`((kind = 'pack_pull'::challenge_requirement_kind) AND (pack_id IS NOT NULL) AND (card_id IS NOT NULL)) OR ((kind = 'upgrader'::challenge_requirement_kind) AND (min_bet_usd IS NOT NULL) AND (min_multiplier IS NOT NULL)) OR ((kind = 'upgrader'::challenge_requirement_kind) AND (card_id IS NOT NULL) AND (win_percentage IS NOT NULL) AND (percent_op IS NOT NULL))`),
]);

export const balances = pgTable("balances", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	user_id: text().notNull(),
	available_balance: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	locked_balance: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	total_deposited: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	total_withdrawn: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	total_wagered: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	total_won: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	shards: integer().default(0).notNull(),
	last_transaction_id: uuid(),
	unlock_at: timestamp({ mode: 'string' }),
	version: integer().default(1).notNull(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	active_stream_session_id: uuid(),
	active_multiplier_deal_id: uuid(),
	coin_available_balance: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	coin_total_wagered: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	coin_total_won: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	total_bonus_won: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	wager_requirement_progress: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	total_affiliate_won: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	total_rakeback_won: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	total_tips_won: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	shard_wager_progress: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	unwagered_race_prize_usd: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	unwagered_bonus_other_usd: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	unwagered_rakeback_usd: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	unwagered_affiliate_usd: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	unwagered_tips_usd: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	wager_requirement_remaining: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
}, (table) => [
	index("balances_active_stream_session_idx").using("btree", table.active_stream_session_id.asc().nullsLast().op("uuid_ops")).where(sql`(active_stream_session_id IS NOT NULL)`),
	foreignKey({
			columns: [table.active_stream_session_id],
			foreignColumns: [creator_stream_sessions.id],
			name: "balances_active_stream_session_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.last_transaction_id],
			foreignColumns: [ledger_transactions.id],
			name: "balances_last_transaction_id_ledger_transactions_id_fk"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [user.id],
			name: "balances_user_id_user_id_fk"
		}).onDelete("cascade"),
	unique("balances_user_id_unique").on(table.user_id),
]);

export const affiliate_level_configs = pgTable("affiliate_level_configs", {
	level: integer().primaryKey().notNull(),
	label: text().notNull(),
	commission_rate: numeric({ precision: 5, scale:  4 }).notNull(),
	updated_at: timestamp({ precision: 6, mode: 'string' }).notNull(),
	threshold: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
});

export const affiliate_clicks = pgTable("affiliate_clicks", {
	id: serial().primaryKey().notNull(),
	code: varchar({ length: 20 }).notNull(),
	user_agent: text(),
	ip: varchar({ length: 45 }).notNull(),
	country: varchar({ length: 100 }).default('unknown').notNull(),
	region: varchar({ length: 100 }).default('unknown').notNull(),
	city: varchar({ length: 100 }).default('unknown').notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_affiliate_clicks_code").using("btree", table.code.asc().nullsLast().op("text_ops")),
	index("idx_affiliate_clicks_created_at").using("btree", table.created_at.asc().nullsLast().op("timestamptz_ops")),
	index("idx_affiliate_clicks_ip").using("btree", table.ip.asc().nullsLast().op("text_ops")),
]);

export const active_seeds = pgTable("active_seeds", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	user_id: text().notNull(),
	client_seed: text().notNull(),
	server_seed: text(),
	server_seed_hash: text(),
	nonce: integer().default(0).notNull(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [user.id],
			name: "active_seeds_user_id_user_id_fk"
		}).onDelete("cascade"),
	unique("active_seeds_user_id_unique").on(table.user_id),
]);

export const cards = pgTable("cards", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: text().notNull(),
	image_url: text().notNull(),
	price: numeric({ precision: 20, scale:  2 }).notNull(),
	price_raw: numeric({ precision: 20, scale:  2 }).notNull(),
	hp: integer().default(0),
	rarity: text(),
	artist: text(),
	card_number: text(),
	type: text().default('card').notNull(),
	tcgplayer_id: integer(),
	set_id: uuid(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_cards_card_number").using("btree", table.card_number.asc().nullsLast().op("text_ops")),
	index("idx_cards_set_id_created_at").using("btree", table.set_id.asc().nullsLast().op("timestamp_ops"), table.created_at.desc().nullsFirst().op("uuid_ops")),
	index("idx_cards_type").using("btree", table.type.asc().nullsLast().op("text_ops")),
	unique("cards_tcgplayer_id_unique").on(table.tcgplayer_id),
]);

export const affiliate_accounts = pgTable("affiliate_accounts", {
	user_id: text().primaryKey().notNull(),
	total_referred: integer().default(0).notNull(),
	total_wager_volume_usd: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	total_earned_usd: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	available_usd: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	total_paid_out_usd: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	total_bonus_distributed_usd: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	last_payout_at: timestamp({ mode: 'string' }),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [user.id],
			name: "affiliate_accounts_user_id_user_id_fk"
		}).onDelete("cascade"),
]);

export const audit_events = pgTable("audit_events", {
	id: text().primaryKey().notNull(),
	user_id: text(),
	event_type: audit_event_type().notNull(),
	ip: inet(),
	user_agent: text(),
	country: text(),
	country_code: text(),
	metadata: jsonb(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [user.id],
			name: "audit_events_user_id_user_id_fk"
		}).onDelete("set null"),
]);

export const account = pgTable("account", {
	id: text().primaryKey().notNull(),
	userId: text().notNull(),
	accountId: text().notNull(),
	providerId: text().notNull(),
	accessToken: text(),
	refreshToken: text(),
	accessTokenExpiresAt: timestamp({ mode: 'string' }),
	refreshTokenExpiresAt: timestamp({ mode: 'string' }),
	scope: text(),
	idToken: text(),
	password: text(),
	created_at: timestamp({ mode: 'string' }).defaultNow(),
	updated_at: timestamp({ mode: 'string' }),
}, (table) => [
	index("idx_account_user_id").using("btree", table.userId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [user.id],
			name: "account_userId_user_id_fk"
		}).onDelete("cascade"),
	unique("account_accountId_unique").on(table.accountId),
]);

export const bots = pgTable("bots", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	username: varchar({ length: 50 }).notNull(),
	image_url: text(),
	total_wagered_usd: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	total_won_usd: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	total_lost_usd: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	battles_played: integer().default(0).notNull(),
	battles_won: integer().default(0).notNull(),
	is_active: boolean().default(true).notNull(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	unique("bots_username_unique").on(table.username),
]);

export const card_withdrawal_requests = pgTable("card_withdrawal_requests", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	user_id: text().notNull(),
	method: card_withdrawal_method().notNull(),
	inventory_item_ids: uuid().array().default(sql`'{}'::uuid[]`).notNull(),
	voucher_ids: uuid().array().default(sql`'{}'::uuid[]`).notNull(),
	total_value_usd: numeric({ precision: 20, scale:  2 }).notNull(),
	shipping_address_snapshot: jsonb(),
	shipping_fee_usd: numeric({ precision: 10, scale:  2 }),
	tracking_number: text(),
	carrier: text(),
	crypto_asset: text(),
	crypto_amount: numeric({ precision: 20, scale:  8 }),
	exchange_rate: numeric({ precision: 20, scale:  8 }),
	destination_address: text(),
	fireblocks_tx_id: text(),
	tx_hash: text(),
	status: card_withdrawal_status().default('pending').notNull(),
	failure_reason: text(),
	requested_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	processing_at: timestamp({ mode: 'string' }),
	shipped_at: timestamp({ mode: 'string' }),
	completed_at: timestamp({ mode: 'string' }),
	failed_at: timestamp({ mode: 'string' }),
	cancelled_at: timestamp({ mode: 'string' }),
	processed_by: text(),
	shipped_by: text(),
	requires_confirmation: boolean().default(false).notNull(),
	confirmation_reason: text(),
	confirmed_at: timestamp({ mode: 'string' }),
	confirmed_by: text(),
	ip_address: text(),
	metadata: jsonb(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_cwr_status_completed_at").using("btree", table.status.asc().nullsLast().op("timestamp_ops"), table.completed_at.desc().nullsFirst().op("enum_ops")),
	index("idx_cwr_user_id_status").using("btree", table.user_id.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.confirmed_by],
			foreignColumns: [user.id],
			name: "card_withdrawal_requests_confirmed_by_user_id_fk"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.processed_by],
			foreignColumns: [user.id],
			name: "card_withdrawal_requests_processed_by_user_id_fk"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.shipped_by],
			foreignColumns: [user.id],
			name: "card_withdrawal_requests_shipped_by_user_id_fk"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [user.id],
			name: "card_withdrawal_requests_user_id_user_id_fk"
		}).onDelete("cascade"),
	unique("card_withdrawal_requests_fireblocks_tx_id_unique").on(table.fireblocks_tx_id),
]);

export const packs = pgTable("packs", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: varchar({ length: 60 }).notNull(),
	slug: varchar({ length: 60 }).notNull(),
	description: text(),
	image_url: text(),
	active: boolean().default(true).notNull(),
	pack_type: text().default('official').notNull(),
	cards_per_open: integer().default(5).notNull(),
	difficulty: real(),
	tags: pack_tag().array(),
	price: numeric({ precision: 20, scale:  2 }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	total_openings: bigint({ mode: "number" }).default(0).notNull(),
	total_revenue: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	total_payout: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	actual_rtp: numeric({ precision: 10, scale:  4 }).default('0').notNull(),
	actual_house_edge: numeric({ precision: 10, scale:  4 }).default('0').notNull(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	shard_cost: integer(),
}, (table) => [
	unique("packs_slug_unique").on(table.slug),
]);

export const fingerprints = pgTable("fingerprints", {
	id: text().primaryKey().notNull(),
	user_id: text(),
	visitor_id: text().notNull(),
	request_id: text().notNull(),
	confidence: real().notNull(),
	event_type: fingerprint_event_type().notNull(),
	suspected_alt_triggered: boolean().default(false).notNull(),
	ip: inet(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("idx_fingerprints_request_id").using("btree", table.request_id.asc().nullsLast().op("text_ops")),
	index("idx_fingerprints_user_id").using("btree", table.user_id.asc().nullsLast().op("text_ops")),
	index("idx_fingerprints_user_id_created_at").using("btree", table.user_id.asc().nullsLast().op("text_ops"), table.created_at.desc().nullsFirst().op("timestamptz_ops")),
	index("idx_fingerprints_visitor_id").using("btree", table.visitor_id.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [user.id],
			name: "fingerprints_user_id_user_id_fk"
		}).onDelete("set null"),
]);

export const gift_cards = pgTable("gift_cards", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	code: varchar({ length: 32 }),
	code_hash: varchar({ length: 64 }),
	value: numeric({ precision: 20, scale:  2 }).notNull(),
	region: gift_card_region().notNull(),
	redeemed_at: timestamp({ mode: 'string' }),
	redeemed_by_user_id: text(),
	ledger_tx_id: uuid(),
	expires_at: timestamp({ mode: 'string' }),
	metadata: jsonb(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.ledger_tx_id],
			foreignColumns: [ledger_transactions.id],
			name: "gift_cards_ledger_tx_id_ledger_transactions_id_fk"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.redeemed_by_user_id],
			foreignColumns: [user.id],
			name: "gift_cards_redeemed_by_user_id_user_id_fk"
		}).onDelete("set null"),
]);

export const ledger_transactions = pgTable("ledger_transactions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	user_id: text().notNull(),
	type: ledger_transaction_type().notNull(),
	amount: numeric({ precision: 20, scale:  2 }).notNull(),
	balance_before: numeric({ precision: 20, scale:  2 }).notNull(),
	balance_after: numeric({ precision: 20, scale:  2 }).notNull(),
	game_session_id: uuid(),
	crypto_asset: text(),
	crypto_amount: numeric({ precision: 20, scale:  8 }),
	exchange_rate: numeric({ precision: 20, scale:  8 }),
	fireblocks_tx_id: text(),
	external_tx_id: text(),
	blockchain_tx_hash: text(),
	source_address: text(),
	destination_address: text(),
	deposit_address_id: uuid(),
	status: ledger_transaction_status().notNull(),
	failure_reason: text(),
	description: text().notNull(),
	metadata: jsonb(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_ledger_tx_created_at").using("btree", table.created_at.desc().nullsFirst().op("timestamp_ops")),
	index("idx_ledger_tx_deposit_created_at").using("btree", table.created_at.desc().nullsFirst().op("timestamp_ops")).where(sql`(type = 'deposit'::ledger_transaction_type)`),
	index("idx_ledger_tx_game_session_id").using("btree", table.game_session_id.asc().nullsLast().op("uuid_ops")),
	index("idx_ledger_tx_metadata_affiliate_code").using("btree", sql`upper((metadata ->> 'affiliate_code'::text))`),
	index("idx_ledger_tx_status_type_created_at").using("btree", table.status.asc().nullsLast().op("timestamp_ops"), table.type.asc().nullsLast().op("enum_ops"), table.created_at.desc().nullsFirst().op("enum_ops")),
	index("idx_ledger_tx_user_created_at").using("btree", table.user_id.asc().nullsLast().op("text_ops"), table.created_at.desc().nullsFirst().op("timestamp_ops")),
	index("idx_ledger_tx_user_created_at_completed").using("btree", table.user_id.asc().nullsLast().op("timestamp_ops"), table.created_at.desc().nullsFirst().op("timestamp_ops")).where(sql`(status = 'completed'::ledger_transaction_status)`),
	index("idx_ledger_tx_user_type_status_created_at").using("btree", table.user_id.asc().nullsLast().op("enum_ops"), table.type.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("enum_ops"), table.created_at.desc().nullsFirst().op("text_ops")),
	index("idx_ledger_user_deposit_created").using("btree", table.user_id.asc().nullsLast().op("text_ops"), table.created_at.asc().nullsLast().op("timestamp_ops")).where(sql`((type = 'deposit'::ledger_transaction_type) AND (status = 'completed'::ledger_transaction_status))`),
	foreignKey({
			columns: [table.deposit_address_id],
			foreignColumns: [deposit_addresses.id],
			name: "ledger_transactions_deposit_address_id_deposit_addresses_id_fk"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.game_session_id],
			foreignColumns: [game_sessions.id as AnyPgColumn],
			name: "ledger_transactions_game_session_id_game_sessions_id_fk"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [user.id],
			name: "ledger_transactions_user_id_user_id_fk"
		}).onDelete("cascade"),
	unique("ledger_transactions_external_tx_id_unique").on(table.external_tx_id),
	unique("ledger_transactions_fireblocks_tx_id_unique").on(table.fireblocks_tx_id),
]);

export const pack_cards = pgTable("pack_cards", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	pack_id: uuid().notNull(),
	card_id: uuid().notNull(),
	weight: integer().default(1).notNull(),
	order: integer().default(0).notNull(),
	color: text(),
	animation: boolean().default(false).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.card_id],
			foreignColumns: [cards.id],
			name: "pack_cards_card_id_cards_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.pack_id],
			foreignColumns: [packs.id],
			name: "pack_cards_pack_id_packs_id_fk"
		}).onDelete("cascade"),
	unique("pack_cards_pack_id_card_id_unique").on(table.card_id, table.pack_id),
]);

export const creator_withdrawal_limits = pgTable("creator_withdrawal_limits", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	user_id: text().notNull(),
	currency_limit_amount: numeric({ precision: 20, scale:  2 }),
	currency_limit_start_date: timestamp({ mode: 'string' }),
	currency_limit_reset_days: integer(),
	percentage_limit: numeric({ precision: 5, scale:  4 }),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [user.id],
			name: "creator_withdrawal_limits_user_id_user_id_fk"
		}).onDelete("cascade"),
	unique("creator_withdrawal_limits_user_id_unique").on(table.user_id),
]);

export const pack_favorites = pgTable("pack_favorites", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	user_id: text().notNull(),
	pack_id: uuid().notNull(),
	favorited_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.pack_id],
			foreignColumns: [packs.id],
			name: "pack_favorites_pack_id_packs_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [user.id],
			name: "pack_favorites_user_id_user_id_fk"
		}).onDelete("cascade"),
	unique("pack_favorites_user_id_pack_id_unique").on(table.pack_id, table.user_id),
]);

export const rains = pgTable("rains", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	base_amount_usd: numeric({ precision: 10, scale:  2 }).default('0.50').notNull(),
	tip_amount_usd: numeric({ precision: 10, scale:  2 }).default('0').notNull(),
	total_pool_usd: numeric({ precision: 10, scale:  2 }).default('0.50').notNull(),
	status: rain_status().default('active').notNull(),
	starts_at: timestamp({ mode: 'string' }).notNull(),
	ends_at: timestamp({ mode: 'string' }).notNull(),
	participant_count: integer().default(0).notNull(),
	winner_user_id: text(),
	winner_entry_id: uuid(),
	completed_at: timestamp({ mode: 'string' }),
	server_seed: text(),
	server_seed_hash: text(),
	client_seed: text(),
	winning_ticket: integer(),
	result_hash: text(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	currency: balance_currency().default('real').notNull(),
}, (table) => [
	foreignKey({
			columns: [table.winner_user_id],
			foreignColumns: [user.id],
			name: "rains_winner_user_id_user_id_fk"
		}).onDelete("set null"),
]);

export const race_leaderboard_snapshots = pgTable("race_leaderboard_snapshots", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	user_id: text().notNull(),
	race_type: race_type().notNull(),
	period_start: date().notNull(),
	position: integer().notNull(),
	wagered_usd: numeric({ precision: 20, scale:  2 }).notNull(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	period_end: timestamp({ mode: 'string' }),
	prize_amount_usd: numeric({ precision: 20, scale:  2 }),
}, (table) => [
	index("race_snapshots_leaderboard_idx").using("btree", table.race_type.asc().nullsLast().op("int4_ops"), table.period_start.asc().nullsLast().op("enum_ops"), table.position.asc().nullsLast().op("date_ops")),
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [user.id],
			name: "race_leaderboard_snapshots_user_id_user_id_fk"
		}).onDelete("cascade"),
	unique("race_leaderboard_snapshots_user_id_race_type_period_start_uniqu").on(table.period_start, table.race_type, table.user_id),
]);

export const race_claims = pgTable("race_claims", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	user_id: text().notNull(),
	race_type: race_type().notNull(),
	race_period_start: date().notNull(),
	position: integer().notNull(),
	prize_amount_usd: numeric({ precision: 20, scale:  2 }).notNull(),
	claimed_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	ledger_tx_id: uuid(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.ledger_tx_id],
			foreignColumns: [ledger_transactions.id],
			name: "race_claims_ledger_tx_id_ledger_transactions_id_fk"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [user.id],
			name: "race_claims_user_id_user_id_fk"
		}).onDelete("cascade"),
	unique("race_claims_user_id_race_type_race_period_start_unique").on(table.race_period_start, table.race_type, table.user_id),
]);

export const promo_codes = pgTable("promo_codes", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	code_hash: varchar({ length: 64 }).notNull(),
	value: numeric({ precision: 20, scale:  2 }).notNull(),
	region: gift_card_region().notNull(),
	minimum_level: integer().default(0).notNull(),
	minimum_wager_amount: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	wager_period_days: integer().default(0).notNull(),
	minimum_account_age_days: integer().default(0).notNull(),
	requires_discord: boolean().default(true).notNull(),
	max_uses: integer().default(1).notNull(),
	expires_at: timestamp({ mode: 'string' }),
	metadata: jsonb(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	minimum_deposit_amount: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	required_affiliate_code: text(),
	maximum_account_age_hours: integer().default(0).notNull(),
	minimum_recent_deposit_amount: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	recent_deposit_period_minutes: integer().default(0).notNull(),
});

export const rakeback_config = pgTable("rakeback_config", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	type: rakeback_type().notNull(),
	percentage: numeric({ precision: 10, scale:  6 }).notNull(),
	expiration_days: integer().notNull(),
	display_name: text().notNull(),
	enabled: boolean().default(true).notNull(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	early_claim_payout_percent: numeric({ precision: 5, scale:  2 }).default('70').notNull(),
	early_claim_cooldown_seconds: integer().default(30).notNull(),
}, (table) => [
	unique("rakeback_config_type_unique").on(table.type),
]);

export const raffles = pgTable("raffles", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: varchar({ length: 100 }).notNull(),
	description: text(),
	status: raffle_status().default('active').notNull(),
	prizes: jsonb().default([]).notNull(),
	min_points_per_entry: integer(),
	max_points_per_entry: integer(),
	starts_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	ends_at: timestamp({ mode: 'string' }).notNull(),
	winner_user_id: text(),
	winner_entry_id: uuid(),
	participant_count: integer().default(0).notNull(),
	total_entries: integer().default(0).notNull(),
	completed_at: timestamp({ mode: 'string' }),
	metadata: jsonb(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.winner_user_id],
			foreignColumns: [user.id],
			name: "raffles_winner_user_id_user_id_fk"
		}).onDelete("set null"),
]);

export const race_prize_tiers = pgTable("race_prize_tiers", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	race_type: race_type().notNull(),
	position: integer().notNull(),
	prize_amount_usd: numeric({ precision: 20, scale:  2 }).notNull(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	unique("race_prize_tiers_race_type_position_unique").on(table.position, table.race_type),
]);

export const rain_entries = pgTable("rain_entries", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	rain_id: uuid().notNull(),
	user_id: text().notNull(),
	turnstile_verified_at: timestamp({ mode: 'string' }).notNull(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.rain_id],
			foreignColumns: [rains.id],
			name: "rain_entries_rain_id_rains_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [user.id],
			name: "rain_entries_user_id_user_id_fk"
		}).onDelete("cascade"),
	unique("rain_entries_rain_id_user_id_unique").on(table.rain_id, table.user_id),
]);

export const rain_tips = pgTable("rain_tips", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	rain_id: uuid().notNull(),
	user_id: text().notNull(),
	amount_usd: numeric({ precision: 10, scale:  2 }).notNull(),
	ledger_tx_id: uuid(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("rain_tips_rain_id_idx").using("btree", table.rain_id.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.rain_id],
			foreignColumns: [rains.id],
			name: "rain_tips_rain_id_rains_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [user.id],
			name: "rain_tips_user_id_user_id_fk"
		}).onDelete("cascade"),
]);

export const promo_code_redemptions = pgTable("promo_code_redemptions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	promo_code_id: uuid().notNull(),
	user_id: text().notNull(),
	ip_address: varchar({ length: 45 }).notNull(),
	ledger_tx_id: uuid(),
	redeemed_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.ledger_tx_id],
			foreignColumns: [ledger_transactions.id],
			name: "promo_code_redemptions_ledger_tx_id_ledger_transactions_id_fk"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.promo_code_id],
			foreignColumns: [promo_codes.id],
			name: "promo_code_redemptions_promo_code_id_promo_codes_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [user.id],
			name: "promo_code_redemptions_user_id_user_id_fk"
		}).onDelete("cascade"),
	unique("promo_code_redemptions_user_unique").on(table.promo_code_id, table.user_id),
]);

export const sets = pgTable("sets", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: text().notNull(),
	series: text().notNull(),
	image_url: text().notNull(),
	language: text().notNull(),
	release_date: timestamp({ mode: 'string' }),
	tcgplayer_id: integer().notNull(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	unique("sets_tcgplayer_id_unique").on(table.tcgplayer_id),
]);

export const two_factor = pgTable("two_factor", {
	id: text().primaryKey().notNull(),
	secret: text().notNull(),
	backup_codes: text().notNull(),
	user_id: text().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [user.id],
			name: "two_factor_user_id_user_id_fk"
		}).onDelete("cascade"),
]);

export const site_config = pgTable("site_config", {
	key: text().primaryKey().notNull(),
	value: text().notNull(),
	description: text(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
});

export const user_feature_locks = pgTable("user_feature_locks", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	user_id: text().notNull(),
	locked_deposits_crypto: text().array().default(sql`'{}'::text[]`).notNull(),
	locked_deposits_fiat: text().array().default(sql`'{}'::text[]`).notNull(),
	locked_deposits_at: timestamp({ mode: 'string' }),
	locked_deposits_by: text(),
	locked_deposits_reason: text(),
	locked_withdrawals_crypto: text().array().default(sql`'{}'::text[]`).notNull(),
	locked_withdrawals_items: boolean().default(false).notNull(),
	locked_withdrawals_at: timestamp({ mode: 'string' }),
	locked_withdrawals_by: text(),
	locked_withdrawals_reason: text(),
	locked_inventory_sales: boolean().default(false).notNull(),
	locked_inventory_sales_at: timestamp({ mode: 'string' }),
	locked_inventory_sales_by: text(),
	locked_exchanges: boolean().default(false).notNull(),
	locked_exchanges_at: timestamp({ mode: 'string' }),
	locked_exchanges_by: text(),
	locked_openings: boolean().default(false).notNull(),
	locked_openings_at: timestamp({ mode: 'string' }),
	locked_openings_by: text(),
	locked_vault: boolean().default(false).notNull(),
	locked_vault_at: timestamp({ mode: 'string' }),
	locked_vault_by: text(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.locked_deposits_by],
			foreignColumns: [user.id],
			name: "user_feature_locks_locked_deposits_by_user_id_fk"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.locked_exchanges_by],
			foreignColumns: [user.id],
			name: "user_feature_locks_locked_exchanges_by_user_id_fk"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.locked_inventory_sales_by],
			foreignColumns: [user.id],
			name: "user_feature_locks_locked_inventory_sales_by_user_id_fk"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.locked_openings_by],
			foreignColumns: [user.id],
			name: "user_feature_locks_locked_openings_by_user_id_fk"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.locked_vault_by],
			foreignColumns: [user.id],
			name: "user_feature_locks_locked_vault_by_user_id_fk"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.locked_withdrawals_by],
			foreignColumns: [user.id],
			name: "user_feature_locks_locked_withdrawals_by_user_id_fk"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [user.id],
			name: "user_feature_locks_user_id_user_id_fk"
		}).onDelete("cascade"),
	unique("user_feature_locks_user_id_unique").on(table.user_id),
]);

export const vaults = pgTable("vaults", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	user_id: text().notNull(),
	fireblocks_vault_id: text(),
	name: text().notNull(),
	customer_ref_id: text(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [user.id],
			name: "vaults_user_id_user_id_fk"
		}).onDelete("cascade"),
	unique("vaults_user_id_unique").on(table.user_id),
]);

export const user_mutes = pgTable("user_mutes", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	user_id: text().notNull(),
	muted_by: text().notNull(),
	reason: text(),
	expires_at: timestamp({ mode: 'string' }),
	unmuted_at: timestamp({ mode: 'string' }),
	unmuted_by: text(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.muted_by],
			foreignColumns: [user.id],
			name: "user_mutes_muted_by_user_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.unmuted_by],
			foreignColumns: [user.id],
			name: "user_mutes_unmuted_by_user_id_fk"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [user.id],
			name: "user_mutes_user_id_user_id_fk"
		}).onDelete("cascade"),
]);

export const seed_rotation_history = pgTable("seed_rotation_history", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	user_id: text().notNull(),
	old_client_seed: text().notNull(),
	old_server_seed: text().notNull(),
	old_server_seed_hash: text().notNull(),
	old_nonce: integer().notNull(),
	new_client_seed: text().notNull(),
	new_server_seed_hash: text().notNull(),
	rotated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [user.id],
			name: "seed_rotation_history_user_id_user_id_fk"
		}).onDelete("cascade"),
]);

export const user_packs = pgTable("user_packs", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	user_id: text().notNull(),
	pack_id: uuid().notNull(),
	source_type: text().notNull(),
	source_id: uuid(),
	opened_at: timestamp({ mode: 'string' }),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.pack_id],
			foreignColumns: [packs.id],
			name: "user_packs_pack_id_packs_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [user.id],
			name: "user_packs_user_id_user_id_fk"
		}).onDelete("cascade"),
]);

export const user_rewards = pgTable("user_rewards", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	user_id: text().notNull(),
	reward_id: uuid().notNull(),
	granted_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	opened_at: timestamp({ mode: 'string' }),
	metadata: jsonb(),
	daily_period_start: timestamp({ mode: 'string' }),
	daily_unlock_xp_baseline: integer(),
	last_claimed_at: timestamp({ mode: 'string' }),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.reward_id],
			foreignColumns: [rewards.id],
			name: "user_rewards_reward_id_rewards_id_fk"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [user.id],
			name: "user_rewards_user_id_user_id_fk"
		}).onDelete("cascade"),
]);

export const vault_lock_times = pgTable("vault_lock_times", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	hours: integer().notNull(),
	label: varchar({ length: 50 }).notNull(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	unique("vault_lock_times_hours_unique").on(table.hours),
]);

export const session = pgTable("session", {
	id: text().primaryKey().notNull(),
	userId: text().notNull(),
	token: text().notNull(),
	expiresAt: timestamp({ mode: 'string' }).notNull(),
	ipAddress: text(),
	userAgent: text(),
	country: text(),
	country_code: text(),
	city: text(),
	created_at: timestamp({ mode: 'string' }).defaultNow(),
	updated_at: timestamp({ mode: 'string' }),
}, (table) => [
	index("idx_session_user_id").using("btree", table.userId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [user.id],
			name: "session_userId_user_id_fk"
		}).onDelete("cascade"),
	unique("session_token_unique").on(table.token),
]);

export const wager_period_snapshots = pgTable("wager_period_snapshots", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	user_id: text().notNull(),
	period_type: rakeback_type().notNull(),
	period_start: date().notNull(),
	wagered_usd: numeric({ precision: 20, scale:  2 }).notNull(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [user.id],
			name: "wager_period_snapshots_user_id_user_id_fk"
		}).onDelete("cascade"),
	unique("wager_period_snapshots_user_id_period_type_period_start_unique").on(table.period_start, table.period_type, table.user_id),
]);

export const creator_session_pending_conversions = pgTable("creator_session_pending_conversions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	session_id: uuid().notNull(),
	deal_id: uuid().notNull(),
	user_id: text().notNull(),
	source: creator_pending_conversion_source().notNull(),
	amount_usd: numeric({ precision: 20, scale:  2 }).notNull(),
	battle_id: uuid(),
	game_session_id: uuid(),
	conversion_rate_bps_snapshot: integer().notNull(),
	status: creator_pending_conversion_status().default('pending').notNull(),
	claimed_at: timestamp({ mode: 'string' }),
	claim_ledger_id: uuid(),
	version: integer().default(1).notNull(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("creator_pending_conversions_session_idx").using("btree", table.session_id.asc().nullsLast().op("uuid_ops")),
	index("creator_pending_conversions_user_status_idx").using("btree", table.user_id.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.session_id],
			foreignColumns: [creator_stream_sessions.id],
			name: "creator_session_pending_conversions_session_id_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.deal_id],
			foreignColumns: [creator_deals.id],
			name: "creator_session_pending_conversions_deal_id_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [user.id],
			name: "creator_session_pending_conversions_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.claim_ledger_id],
			foreignColumns: [ledger_transactions.id],
			name: "creator_session_pending_conversions_claim_ledger_id_fkey"
		}).onDelete("set null"),
	check("creator_session_pending_conversions_amount_non_negative", sql`amount_usd >= (0)::numeric`),
	check("creator_session_pending_conversions_rate_range", sql`(conversion_rate_bps_snapshot >= 0) AND (conversion_rate_bps_snapshot <= 10000)`),
]);

export const affiliate_leaderboard_snapshots = pgTable("affiliate_leaderboard_snapshots", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	leaderboard_id: uuid().notNull(),
	user_id: text().notNull(),
	position: integer().notNull(),
	total_wagered_usd: numeric({ precision: 20, scale:  2 }).notNull(),
	prize_amount_usd: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("affiliate_leaderboard_snapshots_leaderboard_idx").using("btree", table.leaderboard_id.asc().nullsLast().op("uuid_ops")),
	index("affiliate_leaderboard_snapshots_leaderboard_position_idx").using("btree", table.leaderboard_id.asc().nullsLast().op("uuid_ops"), table.position.asc().nullsLast().op("uuid_ops")),
	index("affiliate_leaderboard_snapshots_user_idx").using("btree", table.user_id.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.leaderboard_id],
			foreignColumns: [affiliate_leaderboards.id],
			name: "affiliate_leaderboard_snapshots_leaderboard_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [user.id],
			name: "affiliate_leaderboard_snapshots_user_id_fkey"
		}).onDelete("cascade"),
	unique("affiliate_leaderboard_snapshots_unique").on(table.leaderboard_id, table.user_id),
]);

export const affiliate_leaderboards = pgTable("affiliate_leaderboards", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	creator_user_id: text().notNull(),
	title: text().notNull(),
	affiliate_codes: text().array().default(sql`'{}'::text[]`).notNull(),
	start_date: timestamp({ mode: 'string' }).notNull(),
	end_date: timestamp({ mode: 'string' }).notNull(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	creator_prize_usd: numeric({ precision: 20, scale:  2 }).notNull(),
	site_bonus_usd: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	approval_status: affiliate_leaderboard_approval_status().default('pending').notNull(),
	approved_at: timestamp({ mode: 'string' }),
	approved_by: text(),
	rejection_reason: text(),
	cancelled_at: timestamp({ mode: 'string' }),
	cancelled_by: text(),
	refunded_at: timestamp({ mode: 'string' }),
	refund_amount_usd: numeric({ precision: 20, scale:  2 }),
	creation_ledger_tx_id: uuid(),
	refund_ledger_tx_id: uuid(),
	co_creator_user_ids: text().array().default(sql`'{}'::text[]`).notNull(),
	paid_manually: boolean().default(false).notNull(),
	payout_note: text(),
}, (table) => [
	index("affiliate_leaderboards_active_idx").using("btree", table.start_date.asc().nullsLast().op("timestamp_ops"), table.end_date.asc().nullsLast().op("timestamp_ops")),
	index("affiliate_leaderboards_co_creators_gin_idx").using("gin", table.co_creator_user_ids.asc().nullsLast().op("array_ops")),
	index("affiliate_leaderboards_creator_idx").using("btree", table.creator_user_id.asc().nullsLast().op("text_ops")),
	uniqueIndex("affiliate_leaderboards_creator_pending_unique").using("btree", table.creator_user_id.asc().nullsLast().op("text_ops")).where(sql`(approval_status = 'pending'::affiliate_leaderboard_approval_status)`),
	index("affiliate_leaderboards_creator_status_idx").using("btree", table.creator_user_id.asc().nullsLast().op("enum_ops"), table.approval_status.asc().nullsLast().op("text_ops")),
	index("affiliate_leaderboards_status_active_idx").using("btree", table.approval_status.asc().nullsLast().op("enum_ops"), table.start_date.asc().nullsLast().op("timestamp_ops"), table.end_date.asc().nullsLast().op("timestamp_ops")),
	foreignKey({
			columns: [table.creator_user_id],
			foreignColumns: [user.id],
			name: "affiliate_leaderboards_creator_user_id_fkey"
		}).onDelete("cascade"),
]);

export const raffle_entries = pgTable("raffle_entries", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	raffle_id: uuid().notNull(),
	user_id: text().notNull(),
	points_spent: integer().notNull(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.raffle_id],
			foreignColumns: [raffles.id],
			name: "raffle_entries_raffle_id_raffles_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [user.id],
			name: "raffle_entries_user_id_user_id_fk"
		}).onDelete("cascade"),
	unique("raffle_entries_raffle_id_user_id_unique").on(table.raffle_id, table.user_id),
]);

export const vouchers = pgTable("vouchers", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	user_id: text().notNull(),
	value: numeric({ precision: 20, scale:  2 }).notNull(),
	origin: voucher_origin().notNull(),
	origin_id: uuid(),
	description: text(),
	claimed_at: timestamp({ mode: 'string' }),
	metadata: jsonb(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_vouchers_origin_created_at").using("btree", table.origin.asc().nullsLast().op("timestamp_ops"), table.created_at.desc().nullsFirst().op("enum_ops")),
	index("idx_vouchers_origin_id").using("btree", table.origin_id.asc().nullsLast().op("uuid_ops")),
	index("idx_vouchers_unclaimed_by_user").using("btree", table.user_id.asc().nullsLast().op("text_ops")).where(sql`(claimed_at IS NULL)`),
	index("idx_vouchers_user_id").using("btree", table.user_id.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [user.id],
			name: "vouchers_user_id_user_id_fk"
		}).onDelete("cascade"),
]);

export const battle_participants = pgTable("battle_participants", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	battle_id: uuid().notNull(),
	game_session_id: uuid().notNull(),
	user_id: text(),
	bot_id: uuid(),
	team_number: integer().notNull(),
	team_position: integer().default(0).notNull(),
	client_seed: text().notNull(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	borrow_percentage: integer().default(0).notNull(),
	source_session_id: uuid(),
}, (table) => [
	index("battle_participants_source_session_idx").using("btree", table.source_session_id.asc().nullsLast().op("uuid_ops")).where(sql`(source_session_id IS NOT NULL)`),
	index("idx_battle_participants_battle_id").using("btree", table.battle_id.asc().nullsLast().op("uuid_ops")),
	index("idx_battle_participants_user_id_created_at").using("btree", table.user_id.asc().nullsLast().op("timestamp_ops"), table.created_at.desc().nullsFirst().op("timestamp_ops")).where(sql`(user_id IS NOT NULL)`),
	foreignKey({
			columns: [table.source_session_id],
			foreignColumns: [creator_stream_sessions.id],
			name: "battle_participants_source_session_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.battle_id],
			foreignColumns: [battles.id],
			name: "battle_participants_battle_id_battles_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.bot_id],
			foreignColumns: [bots.id],
			name: "battle_participants_bot_id_bots_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.game_session_id],
			foreignColumns: [game_sessions.id],
			name: "battle_participants_game_session_id_game_sessions_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [user.id],
			name: "battle_participants_user_id_user_id_fk"
		}).onDelete("cascade"),
	unique("battle_participants_game_session_id_unique").on(table.game_session_id),
]);

export const affiliate_leaderboard_claims = pgTable("affiliate_leaderboard_claims", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	leaderboard_id: uuid().notNull(),
	user_id: text().notNull(),
	snapshot_id: uuid().notNull(),
	position: integer().notNull(),
	prize_amount_usd: numeric({ precision: 20, scale:  2 }).notNull(),
	ledger_tx_id: uuid().notNull(),
	claimed_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("affiliate_leaderboard_claims_leaderboard_user_unique").using("btree", table.leaderboard_id.asc().nullsLast().op("text_ops"), table.user_id.asc().nullsLast().op("uuid_ops")),
	index("affiliate_leaderboard_claims_user_idx").using("btree", table.user_id.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.leaderboard_id],
			foreignColumns: [affiliate_leaderboards.id],
			name: "affiliate_leaderboard_claims_leaderboard_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [user.id],
			name: "affiliate_leaderboard_claims_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.snapshot_id],
			foreignColumns: [affiliate_leaderboard_snapshots.id],
			name: "affiliate_leaderboard_claims_snapshot_id_fkey"
		}).onDelete("cascade"),
	unique("affiliate_leaderboard_claims_unique").on(table.leaderboard_id, table.user_id),
]);

export const creator_socials = pgTable("creator_socials", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	user_id: text().notNull(),
	platform: creator_social_platform().notNull(),
	username: text().notNull(),
	url: text(),
	status: creator_social_status().default('pending').notNull(),
	submitted_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	reviewed_at: timestamp({ mode: 'string' }),
	reviewed_by: text(),
	rejection_reason: text(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("creator_socials_status_idx").using("btree", table.status.asc().nullsLast().op("enum_ops")),
	index("creator_socials_user_status_idx").using("btree", table.user_id.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [user.id],
			name: "creator_socials_user_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.reviewed_by],
			foreignColumns: [user.id],
			name: "creator_socials_reviewed_by_fk"
		}).onDelete("set null"),
	unique("creator_socials_user_platform_unique").on(table.platform, table.user_id),
]);

export const leaderboard_funding_addresses = pgTable("leaderboard_funding_addresses", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	leaderboard_id: uuid().notNull(),
	creator_user_id: text().notNull(),
	vault_id: uuid().notNull(),
	asset_id: text().notNull(),
	address: text().notNull(),
	tag: text(),
	amount_usd: numeric({ precision: 20, scale:  2 }).notNull(),
	status: text().default('pending').notNull(),
	funded_at: timestamp({ mode: 'string' }),
	creation_ledger_tx_id: uuid(),
	expires_at: timestamp({ mode: 'string' }).notNull(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("leaderboard_funding_addresses_address_asset_status_idx").using("btree", table.address.asc().nullsLast().op("text_ops"), table.asset_id.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
	index("leaderboard_funding_addresses_creator_status_idx").using("btree", table.creator_user_id.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.leaderboard_id],
			foreignColumns: [affiliate_leaderboards.id],
			name: "leaderboard_funding_addresses_leaderboard_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.creator_user_id],
			foreignColumns: [user.id],
			name: "leaderboard_funding_addresses_creator_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.vault_id],
			foreignColumns: [vaults.id],
			name: "leaderboard_funding_addresses_vault_id_fkey"
		}).onDelete("cascade"),
]);

export const chat_messages = pgTable("chat_messages", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	user_id: text().notNull(),
	content: text().notNull(),
	is_deleted: boolean().default(false).notNull(),
	deleted_at: timestamp({ mode: 'string' }),
	deleted_by: text(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	reply_to_id: uuid(),
	embed_type: chat_message_embed_type(),
	embed_battle_id: uuid(),
	embed_data: jsonb(),
}, (table) => [
	index("idx_chat_messages_created_at_user_id").using("btree", table.created_at.asc().nullsLast().op("timestamp_ops"), table.user_id.asc().nullsLast().op("timestamp_ops")).where(sql`(is_deleted = false)`),
	index("idx_chat_messages_embed_battle_id_created_at").using("btree", table.embed_battle_id.asc().nullsLast().op("uuid_ops"), table.created_at.asc().nullsLast().op("timestamp_ops")),
	index("idx_chat_messages_reply_to_id").using("btree", table.reply_to_id.asc().nullsLast().op("uuid_ops")).where(sql`(reply_to_id IS NOT NULL)`),
	foreignKey({
			columns: [table.reply_to_id],
			foreignColumns: [table.id],
			name: "chat_messages_reply_to_id_fk"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.embed_battle_id],
			foreignColumns: [battles.id],
			name: "chat_messages_embed_battle_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.deleted_by],
			foreignColumns: [user.id],
			name: "chat_messages_deleted_by_user_id_fk"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [user.id],
			name: "chat_messages_user_id_user_id_fk"
		}).onDelete("cascade"),
]);

export const user_inventory = pgTable("user_inventory", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	user_id: text().notNull(),
	card_id: uuid().notNull(),
	value_at_obtained: numeric({ precision: 20, scale:  2 }).notNull(),
	item_region: region_code().default('NA').notNull(),
	source_type: source_type().notNull(),
	source_id: uuid(),
	obtained_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	sold_at: timestamp({ mode: 'string' }),
	exchanged_at: timestamp({ mode: 'string' }),
	withdrawal_locked_at: timestamp({ mode: 'string' }),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	pull_chance: numeric({ precision: 12, scale:  10 }),
	pull_pack_id: uuid(),
}, (table) => [
	index("idx_user_inv_card_id").using("btree", table.card_id.asc().nullsLast().op("uuid_ops")),
	index("idx_user_inv_open_by_user").using("btree", table.user_id.asc().nullsLast().op("text_ops")).where(sql`((sold_at IS NULL) AND (exchanged_at IS NULL) AND (withdrawal_locked_at IS NULL))`),
	index("idx_user_inv_owned_by_user").using("btree", table.user_id.asc().nullsLast().op("text_ops")).where(sql`((sold_at IS NULL) AND (exchanged_at IS NULL))`),
	index("idx_user_inventory_obtained_at").using("btree", table.obtained_at.asc().nullsLast().op("timestamp_ops")),
	index("idx_user_inventory_user_id_obtained_at").using("btree", table.user_id.asc().nullsLast().op("text_ops"), table.obtained_at.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [user.id],
			name: "user_inventory_user_id_user_id_fk"
		}).onDelete("cascade"),
]);

export const user_battle_limits = pgTable("user_battle_limits", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	user_id: text().notNull(),
	max_value_usd: numeric({ precision: 20, scale:  2 }),
	base_bet_limit_usd: numeric({ precision: 20, scale:  2 }),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("user_battle_limits_user_id_idx").using("btree", table.user_id.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [user.id],
			name: "user_battle_limits_user_id_fkey"
		}).onDelete("cascade"),
	unique("user_battle_limits_user_id_key").on(table.user_id),
]);

export const rakeback_claims = pgTable("rakeback_claims", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	user_id: text().notNull(),
	rakeback_type: rakeback_type().notNull(),
	period_start: date().notNull(),
	wagered_amount_usd: numeric({ precision: 20, scale:  2 }).notNull(),
	rakeback_amount_usd: numeric({ precision: 20, scale:  2 }).notNull(),
	claimed_at: timestamp({ mode: 'string' }).defaultNow(),
	ledger_tx_id: uuid(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	claimed_through: timestamp({ mode: 'string' }),
	last_preclaim_at: timestamp({ mode: 'string' }),
	is_finalized: boolean().default(true).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.ledger_tx_id],
			foreignColumns: [ledger_transactions.id],
			name: "rakeback_claims_ledger_tx_id_ledger_transactions_id_fk"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [user.id],
			name: "rakeback_claims_user_id_user_id_fk"
		}).onDelete("cascade"),
	unique("rakeback_claims_user_id_rakeback_type_period_start_unique").on(table.period_start, table.rakeback_type, table.user_id),
]);

export const upgrader_output_cards = pgTable("upgrader_output_cards", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	card_id: uuid().notNull(),
	enabled: boolean().default(true).notNull(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	color: text(),
}, (table) => [
	index("idx_upgrader_output_cards_enabled").using("btree", table.enabled.asc().nullsLast().op("bool_ops")),
	uniqueIndex("uq_upgrader_output_cards_card_id").using("btree", table.card_id.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.card_id],
			foreignColumns: [cards.id],
			name: "upgrader_output_cards_card_id_fk"
		}).onDelete("cascade"),
]);

export const affiliate_leaderboard_claim_holds = pgTable("affiliate_leaderboard_claim_holds", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	leaderboard_id: uuid().notNull(),
	user_id: text().notNull(),
	reason: text().notNull(),
	created_by: text().notNull(),
	released_at: timestamp({ mode: 'string' }),
	released_by: text(),
	release_reason: text(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("affiliate_leaderboard_claim_holds_active_unique").using("btree", table.leaderboard_id.asc().nullsLast().op("text_ops"), table.user_id.asc().nullsLast().op("text_ops")).where(sql`(released_at IS NULL)`),
	index("affiliate_leaderboard_claim_holds_leaderboard_idx").using("btree", table.leaderboard_id.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.leaderboard_id],
			foreignColumns: [affiliate_leaderboards.id],
			name: "affiliate_leaderboard_claim_holds_leaderboard_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [user.id],
			name: "affiliate_leaderboard_claim_holds_user_id_fkey"
		}).onDelete("cascade"),
]);

export const race_periods = pgTable("race_periods", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	race_type: race_type().notNull(),
	starts_at: timestamp({ mode: 'string' }).notNull(),
	ends_at: timestamp({ mode: 'string' }).notNull(),
	auto_renew: boolean().default(true).notNull(),
	status: text().default('active').notNull(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	claims_frozen: boolean().default(false).notNull(),
	claims_unfrozen_at: timestamp({ mode: 'string' }),
	claims_unfrozen_by: text(),
}, (table) => [
	uniqueIndex("race_periods_active_per_type_idx").using("btree", table.race_type.asc().nullsLast().op("enum_ops")).where(sql`(status = 'active'::text)`),
	index("race_periods_recently_ended_idx").using("btree", table.race_type.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops"), table.ends_at.desc().nullsFirst().op("text_ops")),
]);

export const user_statistics = pgTable("user_statistics", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	user_id: text().notNull(),
	opened_packs_count: integer().default(0).notNull(),
	battles_played: integer().default(0).notNull(),
	xp: integer().default(0).notNull(),
	level: integer().default(0).notNull(),
	current_day_start: date().default(sql`(date_trunc('day'`).notNull(),
	current_day_wagered_usd: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	current_week_start: date().default(sql`(date_trunc('week'`).notNull(),
	current_week_wagered_usd: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	current_month_start: date().default(sql`(date_trunc('month'`).notNull(),
	current_month_wagered_usd: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	last_wagered_at: timestamp({ mode: 'string' }),
	weekly_wager_count: integer().default(0).notNull(),
	is_profile_private: boolean().default(false).notNull(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	upgrader_games_played: integer().default(0).notNull(),
	purchased_xp: integer().default(0).notNull(),
	keno_games_played: integer().default(0).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [user.id],
			name: "user_statistics_user_id_user_id_fk"
		}).onDelete("cascade"),
	unique("user_statistics_user_id_unique").on(table.user_id),
]);

export const race_claim_holds = pgTable("race_claim_holds", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	user_id: text().notNull(),
	race_type: race_type().notNull(),
	race_period_start: date().notNull(),
	reason: text().notNull(),
	created_by: text().notNull(),
	released_at: timestamp({ mode: 'string' }),
	released_by: text(),
	release_reason: text(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("race_claim_holds_active_unique").using("btree", table.user_id.asc().nullsLast().op("date_ops"), table.race_type.asc().nullsLast().op("date_ops"), table.race_period_start.asc().nullsLast().op("date_ops")).where(sql`(released_at IS NULL)`),
	index("race_claim_holds_period_idx").using("btree", table.race_type.asc().nullsLast().op("date_ops"), table.race_period_start.asc().nullsLast().op("date_ops")),
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [user.id],
			name: "race_claim_holds_user_id_fkey"
		}).onDelete("cascade"),
]);

export const coin_transactions = pgTable("coin_transactions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	user_id: text().notNull(),
	type: coin_transaction_type().notNull(),
	amount: numeric({ precision: 20, scale:  2 }).notNull(),
	balance_before: numeric({ precision: 20, scale:  2 }).notNull(),
	balance_after: numeric({ precision: 20, scale:  2 }).notNull(),
	game_session_id: uuid(),
	description: text().notNull(),
	metadata: jsonb(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_coin_transactions_user_id_created_at").using("btree", table.user_id.asc().nullsLast().op("text_ops"), table.created_at.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [user.id],
			name: "coin_transactions_user_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.game_session_id],
			foreignColumns: [game_sessions.id],
			name: "coin_transactions_game_session_id_fk"
		}).onDelete("set null"),
]);

export const affiliate_code_usages = pgTable("affiliate_code_usages", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	affiliate_user_id: text().notNull(),
	code: text().notNull(),
	referred_user_id: text().notNull(),
	deposit_amount_usd: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	referrer_cut_usd: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	user_bonus_usd: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	status: text().default('completed').notNull(),
	usage_type: affiliate_usage_type().default('deposit').notNull(),
	wager_amount_usd: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	game_session_id: uuid(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	leaderboard_eligible: boolean().default(true).notNull(),
	weighted_wager_amount_usd: numeric({ precision: 20, scale:  2 }),
}, (table) => [
	index("idx_acu_referred_user_created_at").using("btree", table.referred_user_id.asc().nullsLast().op("text_ops"), table.created_at.desc().nullsFirst().op("timestamp_ops")),
	index("idx_acu_upper_code").using("btree", sql`upper(code)`),
	index("idx_affiliate_code_usages_affiliate_referred").using("btree", table.affiliate_user_id.asc().nullsLast().op("text_ops"), table.referred_user_id.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.affiliate_user_id],
			foreignColumns: [user.id],
			name: "affiliate_code_usages_affiliate_user_id_user_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.game_session_id],
			foreignColumns: [game_sessions.id],
			name: "affiliate_code_usages_game_session_id_game_sessions_id_fk"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.referred_user_id],
			foreignColumns: [user.id],
			name: "affiliate_code_usages_referred_user_id_user_id_fk"
		}).onDelete("cascade"),
]);

export const challenges = pgTable("challenges", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: text().notNull(),
	description: text(),
	game_type: game_type().notNull(),
	type: challenge_type().notNull(),
	status: challenge_status().default('active').notNull(),
	prize_amount: numeric({ precision: 20, scale:  2 }).notNull(),
	max_claims: integer().default(1).notNull(),
	claimed_count: integer().default(0).notNull(),
	created_by: text(),
	version: integer().default(1).notNull(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("challenges_game_type_status_idx").using("btree", table.game_type.asc().nullsLast().op("enum_ops"), table.status.asc().nullsLast().op("enum_ops")),
	foreignKey({
			columns: [table.created_by],
			foreignColumns: [user.id],
			name: "challenges_created_by_fkey"
		}).onDelete("set null"),
	check("challenges_claimed_within_cap", sql`claimed_count <= max_claims`),
	check("challenges_prize_ceiling", sql`(prize_amount > (0)::numeric) AND (prize_amount <= (100000)::numeric)`),
	check("challenges_max_claims_ceiling", sql`(max_claims > 0) AND (max_claims <= 100000)`),
]);

export const monitor_event_settings = pgTable("monitor_event_settings", {
	event_name: text().primaryKey().notNull(),
	enabled: boolean().default(true).notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const battle_double_down_offers = pgTable("battle_double_down_offers", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	battle_id: uuid().notNull(),
	user_id: text().notNull(),
	game_session_id: uuid().notNull(),
	won_amount_usd: numeric({ precision: 20, scale:  2 }).notNull(),
	server_seed: text(),
	server_seed_hash: text().notNull(),
	ticket: integer(),
	result: battle_double_down_result(),
	status: battle_double_down_status().default('offered').notNull(),
	won_voucher_id: uuid(),
	expires_at: timestamp({ mode: 'string' }).notNull(),
	accepted_at: timestamp({ mode: 'string' }),
	resolved_at: timestamp({ mode: 'string' }),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_battle_double_down_offers_status_expires").using("btree", table.status.asc().nullsLast().op("enum_ops"), table.expires_at.asc().nullsLast().op("timestamp_ops")),
	index("idx_battle_double_down_offers_user_status").using("btree", table.user_id.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("enum_ops")),
	uniqueIndex("uq_battle_double_down_offers_battle_user").using("btree", table.battle_id.asc().nullsLast().op("uuid_ops"), table.user_id.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.battle_id],
			foreignColumns: [battles.id],
			name: "battle_double_down_offers_battle_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [user.id],
			name: "battle_double_down_offers_user_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.game_session_id],
			foreignColumns: [game_sessions.id],
			name: "battle_double_down_offers_game_session_id_fk"
		}).onDelete("cascade"),
]);

export const user = pgTable("user", {
	id: text().primaryKey().notNull(),
	email: text(),
	email_verified: boolean().default(false).notNull(),
	image: text(),
	name: text(),
	username: text(),
	display_username: text(),
	two_factor_enabled: boolean().default(false),
	role: user_role().default('user').notNull(),
	country: text(),
	country_code: text(),
	continent_code: text().default('NA').notNull(),
	state: text(),
	city: text(),
	signup_ip: text(),
	affiliate_code: text(),
	affiliate_code_expires_at: timestamp({ mode: 'string' }),
	affiliate_code_active: boolean().default(false),
	affiliate_bonus_opted_in: boolean().default(false),
	referred_by: text(),
	api_key: text(),
	is_locked: boolean().default(false).notNull(),
	locked_reason: text(),
	locked_at: timestamp({ mode: 'string' }),
	locked_until: timestamp({ mode: 'string' }),
	locked_by: text(),
	is_banned: boolean().default(false).notNull(),
	banned_reason: text(),
	banned_at: timestamp({ mode: 'string' }),
	banned_by: text(),
	is_suspected_alt: boolean().default(false).notNull(),
	suspected_alt_at: timestamp({ mode: 'string' }),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	affiliate_bonus_expires_at: timestamp({ mode: 'string' }),
	is_self_excluded: boolean().default(false).notNull(),
	self_excluded_reason: text(),
	self_excluded_at: timestamp({ mode: 'string' }),
	self_excluded_until: timestamp({ mode: 'string' }),
	roles: user_role().array().default(sql`'{}'::user_role[]`).notNull(),
}, (table) => [
	index("idx_user_created_at").using("btree", table.created_at.desc().nullsFirst().op("text_ops"), table.id.desc().nullsFirst().op("timestamp_ops")),
	index("idx_user_lower_display_username_prefix").using("btree", sql`lower(display_username)`),
	index("idx_user_lower_email_prefix").using("btree", sql`lower(email)`),
	index("idx_user_lower_name_prefix").using("btree", sql`lower(name)`),
	index("idx_user_lower_username_prefix").using("btree", sql`lower(username)`),
	index("idx_user_referred_by").using("btree", table.referred_by.asc().nullsLast().op("text_ops")).where(sql`(referred_by IS NOT NULL)`),
	index("idx_user_role_banned_locked").using("btree", table.role.asc().nullsLast().op("bool_ops"), table.is_banned.asc().nullsLast().op("bool_ops"), table.is_locked.asc().nullsLast().op("bool_ops")),
	index("idx_user_signup_ip").using("btree", table.signup_ip.asc().nullsLast().op("text_ops")),
	unique("user_api_key_unique").on(table.api_key),
	unique("user_email_unique").on(table.email),
	unique("user_username_unique").on(table.username),
]);

export const notifications = pgTable("notifications", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	user_id: text().notNull(),
	category: notification_category().notNull(),
	type: text().notNull(),
	payload: jsonb().default({}).notNull(),
	dedupe_key: text(),
	read_at: timestamp({ mode: 'string' }),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("notifications_user_created_idx").using("btree", table.user_id.asc().nullsLast().op("text_ops"), table.created_at.desc().nullsFirst().op("timestamp_ops")),
	uniqueIndex("notifications_user_dedupe_uq").using("btree", table.user_id.asc().nullsLast().op("text_ops"), table.dedupe_key.asc().nullsLast().op("text_ops")).where(sql`(dedupe_key IS NOT NULL)`),
	index("notifications_user_unread_idx").using("btree", table.user_id.asc().nullsLast().op("text_ops")).where(sql`(read_at IS NULL)`),
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [user.id],
			name: "notifications_user_id_fkey"
		}).onDelete("cascade"),
]);

export const announcements = pgTable("announcements", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	category: notification_category().notNull(),
	type: text().notNull(),
	title: text().notNull(),
	body: text(),
	payload: jsonb().default({}).notNull(),
	audience_roles: text().array(),
	starts_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	ends_at: timestamp({ mode: 'string' }),
	created_by: text(),
	revoked_at: timestamp({ mode: 'string' }),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("announcements_active_idx").using("btree", table.starts_at.asc().nullsLast().op("timestamp_ops")).where(sql`(revoked_at IS NULL)`),
]);

export const keno_games = pgTable("keno_games", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	user_id: text().notNull(),
	risk: keno_risk().notNull(),
	selected_numbers: jsonb().notNull(),
	drawn_numbers: jsonb().notNull(),
	hits: integer().notNull(),
	result_multiplier: numeric({ precision: 10, scale:  4 }).notNull(),
	bet_amount: numeric({ precision: 20, scale:  2 }).notNull(),
	won_amount: numeric({ precision: 20, scale:  2 }).notNull(),
	bet_ledger_tx_id: uuid(),
	payout_ledger_tx_id: uuid(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_keno_games_user_id_created_at").using("btree", table.user_id.asc().nullsLast().op("text_ops"), table.created_at.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [user.id],
			name: "keno_games_user_id_fkey"
		}).onDelete("cascade"),
]);

export const user_kyc = pgTable("user_kyc", {
	user_id: text().primaryKey().notNull(),
	kyc_required: boolean().default(false).notNull(),
	kyc_required_at: timestamp({ mode: 'string' }),
	kyc_required_by: text(),
	kyc_required_reason: text(),
	verification_cycle: integer().default(0).notNull(),
	admin_decision: kyc_admin_decision().default('pending').notNull(),
	admin_reviewed_at: timestamp({ mode: 'string' }),
	admin_reviewed_by: text(),
	applicant_id: text(),
	level_name: text(),
	status: kyc_status().default('none').notNull(),
	review_answer: text(),
	reject_type: text(),
	moderation_comment: text(),
	last_webhook_created_at: timestamp({ mode: 'string' }),
	last_webhook_digest: text(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [user.id],
			name: "user_kyc_user_id_fkey"
		}).onDelete("cascade"),
	unique("user_kyc_applicant_id_key").on(table.applicant_id),
	check("user_kyc_cycle_non_negative", sql`verification_cycle >= 0`),
]);

export const sumsub_webhook_events = pgTable("sumsub_webhook_events", {
	digest: text().primaryKey().notNull(),
	applicant_id: text(),
	external_user_id: text(),
	event_type: text().notNull(),
	provider_created_at: timestamp({ mode: 'string' }).notNull(),
	received_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	processed_at: timestamp({ mode: 'string' }),
	payload: jsonb().notNull(),
}, (table) => [
	index("idx_sumsub_webhook_events_applicant_created").using("btree", table.applicant_id.asc().nullsLast().op("text_ops"), table.provider_created_at.asc().nullsLast().op("text_ops")),
	index("idx_sumsub_webhook_events_external_user_created").using("btree", table.external_user_id.asc().nullsLast().op("timestamp_ops"), table.provider_created_at.asc().nullsLast().op("timestamp_ops")),
]);

export const payment_provider_fees = pgTable("payment_provider_fees", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	deposit_intent_id: uuid().notNull(),
	provider_payment_id: text().notNull(),
	fee_key: text().notNull(),
	fee_type: text().notNull(),
	fee_name: text().notNull(),
	amount_cents: integer().notNull(),
	currency: text().notNull(),
	raw_payload: jsonb().notNull(),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_payment_provider_fees_payment").using("btree", table.provider_payment_id.asc().nullsLast().op("text_ops")),
	uniqueIndex("uq_payment_provider_fees_intent_key").using("btree", table.deposit_intent_id.asc().nullsLast().op("text_ops"), table.fee_key.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.deposit_intent_id],
			foreignColumns: [fiat_deposit_intents.id],
			name: "payment_provider_fees_deposit_intent_id_fkey"
		}).onDelete("cascade"),
	check("payment_provider_fee_non_negative", sql`amount_cents >= 0`),
]);

export const fiat_deposit_intents = pgTable("fiat_deposit_intents", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	user_id: text().notNull(),
	provider: text().notNull(),
	currency: text().notNull(),
	requested_amount_cents: integer().notNull(),
	credited_amount_cents: integer().notNull(),
	actual_customer_total_cents: integer(),
	provider_net_amount_cents: integer(),
	status: text().notNull(),
	client_idempotency_key: text().notNull(),
	provider_checkout_id: text(),
	provider_payment_id: text(),
	provider_payment_status: text(),
	completed_ledger_id: uuid(),
	pricing_metadata: jsonb().default({}).notNull(),
	provider_metadata: jsonb().default({}).notNull(),
	failure_reason: text(),
	paid_at: timestamp({ mode: 'string' }),
	completed_at: timestamp({ mode: 'string' }),
	created_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_fiat_deposit_intents_status_updated").using("btree", table.status.asc().nullsLast().op("timestamp_ops"), table.updated_at.asc().nullsLast().op("text_ops")),
	index("idx_fiat_deposit_intents_user_created").using("btree", table.user_id.asc().nullsLast().op("text_ops"), table.created_at.asc().nullsLast().op("text_ops")),
	uniqueIndex("uq_fiat_deposit_intents_provider_checkout").using("btree", table.provider.asc().nullsLast().op("text_ops"), table.provider_checkout_id.asc().nullsLast().op("text_ops")).where(sql`(provider_checkout_id IS NOT NULL)`),
	uniqueIndex("uq_fiat_deposit_intents_provider_payment").using("btree", table.provider.asc().nullsLast().op("text_ops"), table.provider_payment_id.asc().nullsLast().op("text_ops")).where(sql`(provider_payment_id IS NOT NULL)`),
	uniqueIndex("uq_fiat_deposit_intents_user_idempotency").using("btree", table.user_id.asc().nullsLast().op("text_ops"), table.client_idempotency_key.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [user.id],
			name: "fiat_deposit_intents_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.completed_ledger_id],
			foreignColumns: [ledger_transactions.id],
			name: "fiat_deposit_intents_completed_ledger_id_fkey"
		}).onDelete("set null"),
	check("fiat_deposit_credited_amount_positive", sql`credited_amount_cents > 0`),
	check("fiat_deposit_status_valid", sql`status = ANY (ARRAY['created'::text, 'checkout_creating'::text, 'checkout_ready'::text, 'pending'::text, 'review'::text, 'completed'::text, 'failed'::text, 'canceled'::text, 'partially_refunded'::text, 'refunded'::text, 'disputed'::text])`),
	check("fiat_deposit_actual_total_non_negative", sql`(actual_customer_total_cents IS NULL) OR (actual_customer_total_cents >= 0)`),
	check("fiat_deposit_provider_valid", sql`provider = 'whop'::text`),
	check("fiat_deposit_requested_amount_positive", sql`requested_amount_cents > 0`),
]);

export const payment_webhook_events = pgTable("payment_webhook_events", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	provider: text().notNull(),
	provider_event_id: text().notNull(),
	event_type: text().notNull(),
	provider_resource_id: text(),
	payload: jsonb().notNull(),
	processing_status: text().default('received').notNull(),
	attempt_count: integer().default(0).notNull(),
	last_error: text(),
	received_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
	processed_at: timestamp({ mode: 'string' }),
}, (table) => [
	index("idx_payment_webhook_events_resource").using("btree", table.provider.asc().nullsLast().op("text_ops"), table.provider_resource_id.asc().nullsLast().op("text_ops")),
	index("idx_payment_webhook_events_status_received").using("btree", table.processing_status.asc().nullsLast().op("timestamp_ops"), table.received_at.asc().nullsLast().op("text_ops")),
	uniqueIndex("uq_payment_webhook_events_provider_event").using("btree", table.provider.asc().nullsLast().op("text_ops"), table.provider_event_id.asc().nullsLast().op("text_ops")),
	check("payment_webhook_processing_status_valid", sql`processing_status = ANY (ARRAY['received'::text, 'processing'::text, 'processed'::text, 'failed'::text])`),
	check("payment_webhook_attempt_count_non_negative", sql`attempt_count >= 0`),
	check("payment_webhook_provider_valid", sql`provider = 'whop'::text`),
]);

export const announcement_reads = pgTable("announcement_reads", {
	announcement_id: uuid().notNull(),
	user_id: text().notNull(),
	read_at: timestamp({ mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.announcement_id],
			foreignColumns: [announcements.id],
			name: "announcement_reads_announcement_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [user.id],
			name: "announcement_reads_user_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.announcement_id, table.user_id], name: "announcement_reads_pkey"}),
]);
export const pg_stat_statements_info = pgView("pg_stat_statements_info", {	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	dealloc: bigint({ mode: "number" }),
	stats_reset: timestamp({ withTimezone: true, mode: 'string' }),
}).as(sql`SELECT dealloc, stats_reset FROM pg_stat_statements_info() pg_stat_statements_info(dealloc, stats_reset)`);

export const pg_stat_statements = pgView("pg_stat_statements", {
	userid: oid("userid"),
	dbid: oid("dbid"),
	toplevel: boolean(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	queryid: bigint({ mode: "number" }),
	query: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	plans: bigint({ mode: "number" }),
	total_plan_time: doublePrecision(),
	min_plan_time: doublePrecision(),
	max_plan_time: doublePrecision(),
	mean_plan_time: doublePrecision(),
	stddev_plan_time: doublePrecision(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	calls: bigint({ mode: "number" }),
	total_exec_time: doublePrecision(),
	min_exec_time: doublePrecision(),
	max_exec_time: doublePrecision(),
	mean_exec_time: doublePrecision(),
	stddev_exec_time: doublePrecision(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	rows: bigint({ mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	shared_blks_hit: bigint({ mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	shared_blks_read: bigint({ mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	shared_blks_dirtied: bigint({ mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	shared_blks_written: bigint({ mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	local_blks_hit: bigint({ mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	local_blks_read: bigint({ mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	local_blks_dirtied: bigint({ mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	local_blks_written: bigint({ mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	temp_blks_read: bigint({ mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	temp_blks_written: bigint({ mode: "number" }),
	shared_blk_read_time: doublePrecision(),
	shared_blk_write_time: doublePrecision(),
	local_blk_read_time: doublePrecision(),
	local_blk_write_time: doublePrecision(),
	temp_blk_read_time: doublePrecision(),
	temp_blk_write_time: doublePrecision(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	wal_records: bigint({ mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	wal_fpi: bigint({ mode: "number" }),
	wal_bytes: numeric(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	wal_buffers_full: bigint({ mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	jit_functions: bigint({ mode: "number" }),
	jit_generation_time: doublePrecision(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	jit_inlining_count: bigint({ mode: "number" }),
	jit_inlining_time: doublePrecision(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	jit_optimization_count: bigint({ mode: "number" }),
	jit_optimization_time: doublePrecision(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	jit_emission_count: bigint({ mode: "number" }),
	jit_emission_time: doublePrecision(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	jit_deform_count: bigint({ mode: "number" }),
	jit_deform_time: doublePrecision(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	parallel_workers_to_launch: bigint({ mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	parallel_workers_launched: bigint({ mode: "number" }),
	stats_since: timestamp({ withTimezone: true, mode: 'string' }),
	minmax_stats_since: timestamp({ withTimezone: true, mode: 'string' }),
}).as(sql`SELECT userid, dbid, toplevel, queryid, query, plans, total_plan_time, min_plan_time, max_plan_time, mean_plan_time, stddev_plan_time, calls, total_exec_time, min_exec_time, max_exec_time, mean_exec_time, stddev_exec_time, rows, shared_blks_hit, shared_blks_read, shared_blks_dirtied, shared_blks_written, local_blks_hit, local_blks_read, local_blks_dirtied, local_blks_written, temp_blks_read, temp_blks_written, shared_blk_read_time, shared_blk_write_time, local_blk_read_time, local_blk_write_time, temp_blk_read_time, temp_blk_write_time, wal_records, wal_fpi, wal_bytes, wal_buffers_full, jit_functions, jit_generation_time, jit_inlining_count, jit_inlining_time, jit_optimization_count, jit_optimization_time, jit_emission_count, jit_emission_time, jit_deform_count, jit_deform_time, parallel_workers_to_launch, parallel_workers_launched, stats_since, minmax_stats_since FROM pg_stat_statements(true) pg_stat_statements(userid, dbid, toplevel, queryid, query, plans, total_plan_time, min_plan_time, max_plan_time, mean_plan_time, stddev_plan_time, calls, total_exec_time, min_exec_time, max_exec_time, mean_exec_time, stddev_exec_time, rows, shared_blks_hit, shared_blks_read, shared_blks_dirtied, shared_blks_written, local_blks_hit, local_blks_read, local_blks_dirtied, local_blks_written, temp_blks_read, temp_blks_written, shared_blk_read_time, shared_blk_write_time, local_blk_read_time, local_blk_write_time, temp_blk_read_time, temp_blk_write_time, wal_records, wal_fpi, wal_bytes, wal_buffers_full, jit_functions, jit_generation_time, jit_inlining_count, jit_inlining_time, jit_optimization_count, jit_optimization_time, jit_emission_count, jit_emission_time, jit_deform_count, jit_deform_time, parallel_workers_to_launch, parallel_workers_launched, stats_since, minmax_stats_since)`);
