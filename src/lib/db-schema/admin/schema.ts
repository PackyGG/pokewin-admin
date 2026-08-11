import { pgTable, varchar, timestamp, text, integer, index, uuid, boolean, foreignKey, unique, check, numeric, bigint, jsonb, uniqueIndex, date, smallint, primaryKey, pgEnum, customType } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

const bytea = customType<{ data: Buffer }>({
	dataType() {
		return "bytea";
	},
});

export const admin_role = pgEnum("admin_role", ['admin', 'support', 'marketing', 'creator', 'pack_creator', 'creator_manager'])
export const deal_status = pgEnum("deal_status", ['pending', 'active', 'completed', 'cancelled'])
export const deal_type = pgEnum("deal_type", ['flat_fee', 'rev_share', 'hybrid', 'custom'])
export const limit_period_type = pgEnum("limit_period_type", ['daily', 'weekly', 'monthly'])
export const roadmap_status = pgEnum("roadmap_status", ['planned', 'in_progress', 'shipped', 'blocked', 'cancelled'])
export const social_platform = pgEnum("social_platform", ['twitter', 'youtube', 'kick', 'discord', 'instagram'])
export const webhook_type = pgEnum("webhook_type", ['balance_fill', 'deal_data'])


export const casino_sites = pgTable("casino_sites", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	slug: text().notNull(),
	display_name: text().notNull(),
	tokens_per_usd: numeric({ precision: 20, scale: 8 }),
	active: boolean().default(true).notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	unique("casino_sites_slug_key").on(table.slug),
	check("casino_sites_slug_check", sql`slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'::text`),
	check("casino_sites_display_name_check", sql`length(btrim(display_name)) >= 1 AND length(btrim(display_name)) <= 80`),
	check("casino_sites_tokens_per_usd_check", sql`tokens_per_usd IS NULL OR tokens_per_usd > 0`),
]);

export const casino_site_aliases = pgTable("casino_site_aliases", {
	site_id: uuid().notNull(),
	alias: text().notNull(),
	alias_key: text().notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.site_id, table.alias_key], name: "casino_site_aliases_pkey"}),
	unique("casino_site_aliases_alias_key_key").on(table.alias_key),
	foreignKey({ columns: [table.site_id], foreignColumns: [casino_sites.id], name: "casino_site_aliases_site_id_fkey" }).onDelete("cascade"),
	check("casino_site_aliases_alias_check", sql`length(btrim(alias)) >= 1 AND length(btrim(alias)) <= 80`),
	check("casino_site_aliases_key_check", sql`alias_key ~ '^[a-z0-9]+(?: [a-z0-9]+)*$'::text`),
]);

export const casino_site_domains = pgTable("casino_site_domains", {
	site_id: uuid().notNull(),
	domain: text().primaryKey().notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({ columns: [table.site_id], foreignColumns: [casino_sites.id], name: "casino_site_domains_site_id_fkey" }).onDelete("cascade"),
	check("casino_site_domains_domain_check", sql`domain = lower(domain) AND domain !~ '[/:]'::text AND domain ~ '^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\\.[a-z]{2,}$'::text`),
]);


export const _prisma_migrations = pgTable("_prisma_migrations", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	checksum: varchar({ length: 64 }).notNull(),
	finished_at: timestamp({ withTimezone: true, mode: 'string' }),
	migration_name: varchar({ length: 255 }).notNull(),
	logs: text(),
	rolled_back_at: timestamp({ withTimezone: true, mode: 'string' }),
	started_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	applied_steps_count: integer().default(0).notNull(),
});

export const creator_webhooks = pgTable("creator_webhooks", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	target_user_id: text().notNull(),
	url: text().notNull(),
	secret: text().notNull(),
	type: webhook_type().notNull(),
	enabled: boolean().default(true).notNull(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("creator_webhooks_target_user_id_idx").using("btree", table.target_user_id.asc().nullsLast().op("text_ops")),
]);

export const discord_creator_reward_claim_jobs = pgTable("discord_creator_reward_claim_jobs", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	setup_id: uuid().notNull(),
	source_claim_id: uuid().notNull(),
	creator_user_id: text().notNull(),
	referred_user_id: text().notNull(),
	referred_username: text(),
	leg: text().notNull(),
	program_name: text().notNull(),
	amount_usd: numeric({ precision: 20, scale:  2 }).notNull(),
	units: integer().default(0).notNull(),
	occurred_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).notNull(),
	status: text().default('pending').notNull(),
	attempt_count: integer().default(0).notNull(),
	max_attempts: integer().default(8).notNull(),
	available_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lease_token: uuid(),
	lease_owner: text(),
	leased_until: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	discord_message_id: text(),
	last_error_code: text(),
	last_error_message: text(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	delivered_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
}, (table) => [
	index("discord_creator_reward_claim_jobs_claim_idx").using("btree", table.available_at.asc().nullsLast().op("timestamptz_ops"), table.created_at.asc().nullsLast().op("uuid_ops"), table.id.asc().nullsLast().op("uuid_ops")).where(sql`(status = ANY (ARRAY['pending'::text, 'leased'::text]))`),
	index("discord_creator_reward_claim_jobs_setup_history_idx").using("btree", table.setup_id.asc().nullsLast().op("uuid_ops"), table.created_at.desc().nullsFirst().op("timestamptz_ops")),
	foreignKey({
			columns: [table.setup_id],
			foreignColumns: [discord_creator_setups.id],
			name: "discord_creator_reward_claim_jobs_setup_id_fkey"
		}).onDelete("cascade"),
	unique("discord_creator_reward_claim_jobs_source_unique").on(table.source_claim_id),
	check("discord_creator_reward_claim_jobs_amount_check", sql`(amount_usd > (0)::numeric) AND (units >= 0)`),
	check("discord_creator_reward_claim_jobs_attempt_check", sql`(attempt_count >= 0) AND ((max_attempts >= 1) AND (max_attempts <= 25))`),
	check("discord_creator_reward_claim_jobs_leg_check", sql`leg <> ''::text`),
	check("discord_creator_reward_claim_jobs_status_check", sql`status = ANY (ARRAY['pending'::text, 'leased'::text, 'delivered'::text, 'dead'::text])`),
]);

export const admin_settings = pgTable("admin_settings", {
	key: text().primaryKey().notNull(),
	value: text().notNull(),
	updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updated_by: uuid(),
});

export const creator_deals = pgTable("creator_deals", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	target_user_id: text().notNull(),
	deal_type: deal_type().notNull(),
	amount: numeric({ precision: 20, scale:  2 }).notNull(),
	currency: varchar({ length: 10 }).default('USD').notNull(),
	start_date: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).notNull(),
	end_date: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	status: deal_status().default('active').notNull(),
	notes: text(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	deal_name: text(),
	daily_fill_amount: numeric({ precision: 20, scale:  2 }),
	daily_fill_time: varchar({ length: 5 }),
	daily_fill_enabled: boolean().default(false).notNull(),
	keep_percentage: numeric({ precision: 5, scale:  4 }),
	leaderboard_prize_pool: numeric({ precision: 20, scale:  2 }),
	leaderboard_our_share: numeric({ precision: 5, scale:  4 }),
	leaderboard_frequency: varchar({ length: 20 }),
	min_stream_minutes: integer(),
	max_financial_exposure: numeric({ precision: 20, scale:  2 }),
	currency_limit_amount: numeric({ precision: 20, scale:  2 }),
	currency_limit_reset_days: integer(),
	percentage_limit: numeric({ precision: 5, scale:  4 }),
	tip_limit: numeric({ precision: 20, scale:  2 }),
	tip_limit_reset_days: integer(),
}, (table) => [
	index("creator_deals_target_user_id_idx").using("btree", table.target_user_id.asc().nullsLast().op("text_ops")),
]);

export const admin_giveaway_actions = pgTable("admin_giveaway_actions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	admin_user_id: uuid().notNull(),
	target_user_id: text().notNull(),
	amount_usd: numeric({ precision: 20, scale:  2 }).notNull(),
	source_url: text().notNull(),
	source_type: text().notNull(),
	reason: text(),
	ledger_tx_id: text(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("admin_giveaway_actions_created_at_idx").using("btree", table.created_at.desc().nullsFirst().op("timestamptz_ops")),
	index("admin_giveaway_actions_target_user_id_idx").using("btree", table.target_user_id.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.admin_user_id],
			foreignColumns: [admin_users.id],
			name: "admin_giveaway_actions_admin_user_id_fkey"
		}).onUpdate("cascade").onDelete("restrict"),
]);

export const creator_socials = pgTable("creator_socials", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	target_user_id: text().notNull(),
	platform: social_platform().notNull(),
	platform_user_id: text(),
	username: text().notNull(),
	access_token: text(),
	refresh_token: text(),
	token_expires_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	follower_count: integer(),
	last_fetched_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	subscriber_count: integer(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	total_views: bigint({ mode: "number" }),
	avg_views_30d: integer(),
	avg_viewers: integer(),
	avg_viewers_30d: integer(),
	engagement_rate: numeric({ precision: 5, scale:  4 }),
	likes_avg: integer(),
	stats_json: jsonb(),
	reward_page_url: text(),
}, (table) => [
	unique("creator_socials_target_user_id_platform_key").on(table.platform, table.target_user_id),
]);

export const admin_users = pgTable("admin_users", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	email: text().notNull(),
	username: text().notNull(),
	password_hash: text().notNull(),
	role: admin_role().default('admin').notNull(),
	totp_secret: text(),
	totp_enabled: boolean().default(false).notNull(),
	recovery_codes: text().array(),
	is_active: boolean().default(true).notNull(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).notNull(),
	allowed_pages: text().array().default(sql`'{}'::text[]`).notNull(),
	display_username: text(),
	profile_image: bytea("profile_image"),
	profile_image_mime: text(),
	role_id: uuid(),
	preferences: jsonb(),
	roles: admin_role().array().default(sql`'{}'::admin_role[]`).notNull(),
	permission_grants: text().array().default(sql`'{}'::text[]`).notNull(),
	permission_revokes: text().array().default(sql`'{}'::text[]`).notNull(),
	sessions_valid_after: timestamp({ withTimezone: true, mode: 'string' }),
	is_owner: boolean().default(false).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	totp_last_step: bigint({ mode: "number" }),
}, (table) => [
	uniqueIndex("admin_users_email_key").using("btree", table.email.asc().nullsLast().op("text_ops")),
	uniqueIndex("admin_users_username_key").using("btree", table.username.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.role_id],
			foreignColumns: [admin_roles.id],
			name: "admin_users_role_id_fkey"
		}).onUpdate("cascade").onDelete("set null"),
]);

export const discord_rain_notification_jobs = pgTable("discord_rain_notification_jobs", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	rain_id: uuid().notNull(),
	pool_usd_cents: integer().notNull(),
	participant_count: integer().notNull(),
	starts_at: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
	ends_at: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
	status: text().default('pending').notNull(),
	attempt_count: integer().default(0).notNull(),
	max_attempts: integer().default(10).notNull(),
	available_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lease_token: uuid(),
	lease_owner: text(),
	leased_until: timestamp({ withTimezone: true, mode: 'string' }),
	discord_message_id: text(),
	last_error_code: text(),
	last_error_message: text(),
	delivered_at: timestamp({ withTimezone: true, mode: 'string' }),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("discord_rain_notification_jobs_claim_idx").using("btree", table.available_at.asc().nullsLast().op("timestamptz_ops"), table.created_at.asc().nullsLast().op("uuid_ops"), table.id.asc().nullsLast().op("uuid_ops")).where(sql`(status = ANY (ARRAY['pending'::text, 'leased'::text]))`),
	unique("discord_rain_notification_jobs_rain_id_key").on(table.rain_id),
	check("discord_rain_notification_jobs_attempt_check", sql`(attempt_count >= 0) AND ((max_attempts >= 1) AND (max_attempts <= 25))`),
	check("discord_rain_notification_jobs_lease_shape_check", sql`((status = 'leased'::text) AND (lease_token IS NOT NULL) AND (lease_owner IS NOT NULL) AND (leased_until IS NOT NULL)) OR ((status <> 'leased'::text) AND (lease_token IS NULL) AND (lease_owner IS NULL) AND (leased_until IS NULL))`),
	check("discord_rain_notification_jobs_message_id_check", sql`(discord_message_id IS NULL) OR (discord_message_id ~ '^[0-9]{17,20}$'::text)`),
	check("discord_rain_notification_jobs_participants_check", sql`participant_count >= 0`),
	check("discord_rain_notification_jobs_pool_check", sql`pool_usd_cents > 2000`),
	check("discord_rain_notification_jobs_status_check", sql`status = ANY (ARRAY['pending'::text, 'leased'::text, 'delivered'::text, 'dead'::text])`),
	check("discord_rain_notification_jobs_window_check", sql`ends_at > starts_at`),
]);

export const admin_sessions = pgTable("admin_sessions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	admin_user_id: uuid().notNull(),
	ip: text(),
	user_agent: text(),
	auth_method: text(),
	logged_in_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	expires_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).notNull(),
	logged_out_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
}, (table) => [
	index("admin_sessions_active_partial_idx").using("btree", table.expires_at.asc().nullsLast().op("timestamptz_ops")).where(sql`(logged_out_at IS NULL)`),
	foreignKey({
			columns: [table.admin_user_id],
			foreignColumns: [admin_users.id],
			name: "admin_sessions_admin_user_id_fkey"
		}).onUpdate("cascade").onDelete("restrict"),
]);

export const admin_notes = pgTable("admin_notes", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	admin_user_id: uuid().notNull(),
	target_user_id: text().notNull(),
	content: text().notNull(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.admin_user_id],
			foreignColumns: [admin_users.id],
			name: "admin_notes_admin_user_id_fkey"
		}).onUpdate("cascade").onDelete("restrict"),
]);

export const admin_audit_events = pgTable("admin_audit_events", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	admin_user_id: uuid(),
	event_type: text().notNull(),
	target_user_id: text(),
	ip: text(),
	metadata: jsonb(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	uniqueIndex("admin_audit_antifraud_idempotency_idx").using("btree", sql`((metadata ->> 'idempotencyKey'::text))`).where(sql`((event_type = ANY (ARRAY['antifraud_monitor_case_decision'::text, 'antifraud_review_status_changed'::text])) AND (metadata ? 'idempotencyKey'::text))`),
	index("admin_audit_events_admin_user_created_idx").using("btree", table.admin_user_id.asc().nullsLast().op("timestamptz_ops"), table.created_at.desc().nullsFirst().op("timestamptz_ops")),
	index("admin_audit_events_admin_user_id_idx").using("btree", table.admin_user_id.asc().nullsLast().op("uuid_ops")),
	index("admin_audit_events_created_at_idx").using("btree", table.created_at.desc().nullsFirst().op("timestamptz_ops")),
	index("admin_audit_events_event_type_created_idx").using("btree", table.event_type.asc().nullsLast().op("timestamptz_ops"), table.created_at.desc().nullsFirst().op("text_ops")),
	index("admin_audit_events_event_type_idx").using("btree", table.event_type.asc().nullsLast().op("text_ops")),
	index("admin_audit_events_target_user_id_idx").using("btree", table.target_user_id.asc().nullsLast().op("text_ops")),
	uniqueIndex("admin_audit_review_postponed_idempotency_idx").using("btree", sql`((metadata ->> 'idempotencyKey'::text))`).where(sql`((event_type = 'antifraud_review_postponed'::text) AND (metadata ? 'idempotencyKey'::text))`),
	foreignKey({
			columns: [table.admin_user_id],
			foreignColumns: [admin_users.id],
			name: "admin_audit_events_admin_user_id_fkey"
		}).onUpdate("cascade").onDelete("set null"),
]);

export const admin_gift_card_actions = pgTable("admin_gift_card_actions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	gift_card_id: uuid().notNull(),
	action: text().notNull(),
	admin_user_id: uuid().notNull(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	index("admin_gift_card_actions_gift_card_id_idx").using("btree", table.gift_card_id.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.admin_user_id],
			foreignColumns: [admin_users.id],
			name: "admin_gift_card_actions_admin_user_id_fkey"
		}).onUpdate("cascade").onDelete("restrict"),
]);

export const admin_voucher_actions = pgTable("admin_voucher_actions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	voucher_id: uuid().notNull(),
	action: text().notNull(),
	admin_user_id: uuid().notNull(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	index("admin_voucher_actions_voucher_id_idx").using("btree", table.voucher_id.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.admin_user_id],
			foreignColumns: [admin_users.id],
			name: "admin_voucher_actions_admin_user_id_fkey"
		}).onUpdate("cascade").onDelete("restrict"),
]);

export const webhook_deliveries = pgTable("webhook_deliveries", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	webhook_id: uuid().notNull(),
	event_type: text().notNull(),
	payload: jsonb().notNull(),
	status_code: integer(),
	response: text(),
	success: boolean().notNull(),
	attempt: integer().default(1).notNull(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("webhook_deliveries_created_at_idx").using("btree", table.created_at.asc().nullsLast().op("timestamptz_ops")),
	index("webhook_deliveries_webhook_id_idx").using("btree", table.webhook_id.asc().nullsLast().op("uuid_ops")),
]);

export const creator_balance_fills = pgTable("creator_balance_fills", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	target_user_id: text().notNull(),
	deal_id: uuid(),
	amount: numeric({ precision: 20, scale:  2 }).notNull(),
	status: text().default('completed').notNull(),
	triggered_by: text().default('cron').notNull(),
	webhook_sent: boolean().default(false).notNull(),
	webhook_error: text(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("creator_balance_fills_created_at_idx").using("btree", table.created_at.asc().nullsLast().op("timestamptz_ops")),
	index("creator_balance_fills_target_user_id_idx").using("btree", table.target_user_id.asc().nullsLast().op("text_ops")),
]);

export const expenses = pgTable("expenses", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	description: text().notNull(),
	amount: numeric({ precision: 20, scale:  2 }).notNull(),
	date: date().notNull(),
	paid_to: text().notNull(),
	payment_method: text().notNull(),
	notes: text(),
	created_by_id: uuid(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	category: text().notNull(),
	paid_by: text(),
}, (table) => [
	index("expenses_category_idx").using("btree", table.category.asc().nullsLast().op("text_ops")),
	index("expenses_date_idx").using("btree", table.date.asc().nullsLast().op("date_ops")),
	foreignKey({
			columns: [table.created_by_id],
			foreignColumns: [admin_users.id],
			name: "expenses_created_by_id_fkey"
		}).onUpdate("cascade").onDelete("restrict"),
]);

export const recurring_expenses = pgTable("recurring_expenses", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: text().notNull(),
	amount: numeric({ precision: 20, scale:  2 }).notNull(),
	notes: text(),
	is_active: boolean().default(true).notNull(),
	created_by_id: uuid(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	category: text().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.created_by_id],
			foreignColumns: [admin_users.id],
			name: "recurring_expenses_created_by_id_fkey"
		}).onUpdate("cascade").onDelete("restrict"),
]);

export const admin_balance_limits = pgTable("admin_balance_limits", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	admin_user_id: text().notNull(),
	period_type: limit_period_type().notNull(),
	max_amount: numeric({ precision: 12, scale:  2 }).notNull(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	created_by: text(),
	updated_by: text(),
}, (table) => [
	unique("admin_balance_limits_admin_user_id_period_type_key").on(table.admin_user_id, table.period_type),
]);

export const admin_shifts = pgTable("admin_shifts", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	week_start: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).notNull(),
	day_of_week: integer().notNull(),
	shift_slot: integer().notNull(),
	start_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).notNull(),
	end_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).notNull(),
	notes: text(),
	created_by_id: uuid(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).notNull(),
}, (table) => [
	uniqueIndex("admin_shifts_week_start_day_of_week_shift_slot_key").using("btree", table.week_start.asc().nullsLast().op("int4_ops"), table.day_of_week.asc().nullsLast().op("timestamptz_ops"), table.shift_slot.asc().nullsLast().op("int4_ops")),
	index("admin_shifts_week_start_idx").using("btree", table.week_start.asc().nullsLast().op("timestamptz_ops")),
	foreignKey({
			columns: [table.created_by_id],
			foreignColumns: [admin_users.id],
			name: "admin_shifts_created_by_id_fkey"
		}).onUpdate("cascade").onDelete("set null"),
]);

export const admin_shift_assignments = pgTable("admin_shift_assignments", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	shift_id: uuid().notNull(),
	admin_user_id: uuid().notNull(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	index("admin_shift_assignments_admin_user_id_idx").using("btree", table.admin_user_id.asc().nullsLast().op("uuid_ops")),
	uniqueIndex("admin_shift_assignments_shift_id_admin_user_id_key").using("btree", table.shift_id.asc().nullsLast().op("uuid_ops"), table.admin_user_id.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.admin_user_id],
			foreignColumns: [admin_users.id],
			name: "admin_shift_assignments_admin_user_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
			columns: [table.shift_id],
			foreignColumns: [admin_shifts.id],
			name: "admin_shift_assignments_shift_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const salary_employees = pgTable("salary_employees", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	discord_name: text().notNull(),
	eth_address: text().notNull(),
	salary_usdt: numeric({ precision: 20, scale:  6 }).notNull(),
	max_per_payout: numeric({ precision: 20, scale:  6 }),
	active: boolean().default(true).notNull(),
	last_paid_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	notes: text(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).notNull(),
	created_by_id: uuid(),
	cadence: text().default('monthly').notNull(),
	pay_day_of_week: smallint(),
	pay_day_of_month: smallint(),
}, (table) => [
	index("salary_employees_active_idx").using("btree", table.active.asc().nullsLast().op("bool_ops")),
	foreignKey({
			columns: [table.created_by_id],
			foreignColumns: [admin_users.id],
			name: "salary_employees_created_by_id_fkey"
		}).onUpdate("cascade").onDelete("set null"),
]);

export const salary_payouts = pgTable("salary_payouts", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	employee_id: uuid().notNull(),
	amount_usdt: numeric({ precision: 20, scale:  6 }).notNull(),
	to_address: text().notNull(),
	tx_hash: text(),
	status: text().default('pending').notNull(),
	error_message: text(),
	broadcast_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	confirmed_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	failed_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	paid_by_id: uuid(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("salary_payouts_created_at_idx").using("btree", table.created_at.desc().nullsFirst().op("timestamptz_ops")),
	index("salary_payouts_employee_id_idx").using("btree", table.employee_id.asc().nullsLast().op("uuid_ops")),
	index("salary_payouts_status_idx").using("btree", table.status.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.employee_id],
			foreignColumns: [salary_employees.id],
			name: "salary_payouts_employee_id_fkey"
		}).onUpdate("cascade").onDelete("restrict"),
	foreignKey({
			columns: [table.paid_by_id],
			foreignColumns: [admin_users.id],
			name: "salary_payouts_paid_by_id_fkey"
		}).onUpdate("cascade").onDelete("set null"),
	unique("salary_payouts_tx_hash_key").on(table.tx_hash),
]);

export const excluded_users = pgTable("excluded_users", {
	user_id: text().primaryKey().notNull(),
	reason: text(),
	excluded_by: uuid(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
}, (table) => [
	index("excluded_users_created_at_idx").using("btree", table.created_at.desc().nullsFirst().op("timestamptz_ops")),
	foreignKey({
			columns: [table.excluded_by],
			foreignColumns: [admin_users.id],
			name: "excluded_users_excluded_by_fkey"
		}).onUpdate("cascade").onDelete("restrict"),
]);

export const admin_leaderboard_sponsorship = pgTable("admin_leaderboard_sponsorship", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	leaderboard_id: text().notNull(),
	sponsored_percentage: numeric({ precision: 5, scale:  2 }).notNull(),
	set_by_admin_id: uuid().notNull(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	uniqueIndex("admin_leaderboard_sponsorship_leaderboard_id_key").using("btree", table.leaderboard_id.asc().nullsLast().op("text_ops")),
]);

export const employee_board_placements = pgTable("employee_board_placements", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	employee_id: uuid().notNull(),
	workspace_id: uuid(),
	roles: text().array().default(sql`'{}'::text[]`).notNull(),
	position: integer().default(0).notNull(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).notNull(),
}, (table) => [
	index("employee_board_placements_employee_id_idx").using("btree", table.employee_id.asc().nullsLast().op("uuid_ops")),
	uniqueIndex("employee_board_placements_employee_id_workspace_id_key").using("btree", table.employee_id.asc().nullsLast().op("uuid_ops"), table.workspace_id.asc().nullsLast().op("uuid_ops")),
	index("employee_board_placements_workspace_id_idx").using("btree", table.workspace_id.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.workspace_id],
			foreignColumns: [employee_workspaces.id],
			name: "employee_board_placements_workspace_id_fkey"
		}).onUpdate("cascade").onDelete("set null"),
]);

export const employee_workspaces = pgTable("employee_workspaces", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: text().notNull(),
	position: integer().default(0).notNull(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).notNull(),
});

export const employee_managers = pgTable("employee_managers", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	employee_id: uuid().notNull(),
	position: integer().default(0).notNull(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).notNull(),
}, (table) => [
	unique("employee_managers_employee_id_key").on(table.employee_id),
]);

export const employee_manager_workspaces = pgTable("employee_manager_workspaces", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	manager_id: uuid().notNull(),
	workspace_id: uuid().notNull(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("employee_manager_workspaces_manager_id_idx").using("btree", table.manager_id.asc().nullsLast().op("uuid_ops")),
	index("employee_manager_workspaces_workspace_id_idx").using("btree", table.workspace_id.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.manager_id],
			foreignColumns: [employee_managers.id],
			name: "employee_manager_workspaces_manager_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
			columns: [table.workspace_id],
			foreignColumns: [employee_workspaces.id],
			name: "employee_manager_workspaces_workspace_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	unique("employee_manager_workspaces_manager_id_workspace_id_key").on(table.manager_id, table.workspace_id),
]);

export const salary_payments = pgTable("salary_payments", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	employee_id: uuid().notNull(),
	payment_link: text().notNull(),
	paid_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	created_by_id: uuid().notNull(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("salary_payments_employee_id_idx").using("btree", table.employee_id.asc().nullsLast().op("uuid_ops")),
	index("salary_payments_paid_at_idx").using("btree", table.paid_at.desc().nullsFirst().op("timestamptz_ops")),
	foreignKey({
			columns: [table.employee_id],
			foreignColumns: [salary_employees.id],
			name: "salary_payments_employee_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const admin_changelog_entries = pgTable("admin_changelog_entries", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	published_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).notNull(),
	title: text().notNull(),
	summary: text().notNull(),
	version: text(),
	category: text().notNull(),
	changes: jsonb().notNull(),
	author_admin_user_id: uuid(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).notNull(),
}, (table) => [
	index("admin_changelog_entries_published_at_idx").using("btree", table.published_at.desc().nullsFirst().op("timestamptz_ops")),
]);

export const admin_user_tags = pgTable("admin_user_tags", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	target_user_id: text().notNull(),
	tag: text().notNull(),
	set_by_admin_id: uuid(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	index("admin_user_tags_tag_idx").using("btree", table.tag.asc().nullsLast().op("text_ops")),
	index("admin_user_tags_target_user_id_idx").using("btree", table.target_user_id.asc().nullsLast().op("text_ops")),
	uniqueIndex("admin_user_tags_user_tag_unique").using("btree", table.target_user_id.asc().nullsLast().op("text_ops"), table.tag.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.set_by_admin_id],
			foreignColumns: [admin_users.id],
			name: "admin_user_tags_set_by_admin_id_fkey"
		}).onUpdate("cascade").onDelete("set null"),
	check("admin_user_tags_tag_value_check", sql`tag = ANY (ARRAY['vip'::text, 'wager_abuser'::text])`),
]);

export const discord_partnership_tickets = pgTable("discord_partnership_tickets", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	guild_id: text().notNull(),
	source_channel_id: text().notNull(),
	applicant_discord_user_id: text().notNull(),
	applicant_username: text().notNull(),
	applicant_display_name: text().notNull(),
	submit_interaction_id: text().notNull(),
	social_media_links: text().notNull(),
	current_past_partner_sites: text().notNull(),
	stats_expectations: text().notNull(),
	additional_notes: text(),
	status: text().default('provisioning').notNull(),
	ticket_channel_id: text(),
	current_category_id: text(),
	initial_message_id: text(),
	version: integer().default(0).notNull(),
	last_error_step: text(),
	last_error_code: text(),
	last_error_message: text(),
	last_error_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	last_reconciled_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	provisioned_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	offered_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	close_requested_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	cancelled_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	closed_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	closed_by_discord_user_id: text(),
}, (table) => [
	uniqueIndex("discord_partnership_tickets_channel_unique").using("btree", table.ticket_channel_id.asc().nullsLast().op("text_ops")).where(sql`(ticket_channel_id IS NOT NULL)`),
	uniqueIndex("discord_partnership_tickets_one_active_applicant").using("btree", table.guild_id.asc().nullsLast().op("text_ops"), table.applicant_discord_user_id.asc().nullsLast().op("text_ops")).where(sql`(status <> ALL (ARRAY['closed'::text, 'cancelled'::text]))`),
	index("discord_partnership_tickets_recovery_idx").using("btree", table.guild_id.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("uuid_ops"), table.updated_at.asc().nullsLast().op("uuid_ops"), table.id.asc().nullsLast().op("text_ops")).where(sql`(status <> ALL (ARRAY['closed'::text, 'cancelled'::text]))`),
	unique("discord_partnership_tickets_submit_interaction_id_key").on(table.submit_interaction_id),
	check("discord_partnership_tickets_closed_shape_check", sql`((status = 'closed'::text) = (closed_at IS NOT NULL)) AND ((status = 'cancelled'::text) = (cancelled_at IS NOT NULL))`),
	check("discord_partnership_tickets_fixed_guild_check", sql`guild_id = '1438216946318442683'::text`),
	check("discord_partnership_tickets_fixed_source_check", sql`source_channel_id = '1447322856818999337'::text`),
	check("discord_partnership_tickets_ids_check", sql`(applicant_discord_user_id ~ '^[0-9]{17,20}$'::text) AND (submit_interaction_id ~ '^[0-9]{17,20}$'::text) AND ((ticket_channel_id IS NULL) OR (ticket_channel_id ~ '^[0-9]{17,20}$'::text)) AND ((current_category_id IS NULL) OR (current_category_id ~ '^[0-9]{17,20}$'::text)) AND ((initial_message_id IS NULL) OR (initial_message_id ~ '^[0-9]{17,20}$'::text)) AND ((closed_by_discord_user_id IS NULL) OR (closed_by_discord_user_id ~ '^[0-9]{17,20}$'::text))`),
	check("discord_partnership_tickets_shape_check", sql`((status = ANY (ARRAY['provisioning'::text, 'cancelled'::text])) AND (ticket_channel_id IS NULL) AND (current_category_id IS NULL) AND (initial_message_id IS NULL) AND (provisioned_at IS NULL)) OR ((status = ANY (ARRAY['open'::text, 'offer_pending'::text, 'offered'::text, 'close_pending'::text, 'closed'::text])) AND (ticket_channel_id IS NOT NULL) AND (current_category_id IS NOT NULL) AND (initial_message_id IS NOT NULL) AND (provisioned_at IS NOT NULL))`),
	check("discord_partnership_tickets_status_check", sql`status = ANY (ARRAY['provisioning'::text, 'open'::text, 'offer_pending'::text, 'offered'::text, 'close_pending'::text, 'cancelled'::text, 'closed'::text])`),
	check("discord_partnership_tickets_text_check", sql`((length(applicant_username) >= 1) AND (length(applicant_username) <= 100)) AND ((length(applicant_display_name) >= 1) AND (length(applicant_display_name) <= 100)) AND ((length(social_media_links) >= 1) AND (length(social_media_links) <= 1000)) AND ((length(current_past_partner_sites) >= 1) AND (length(current_past_partner_sites) <= 1000)) AND ((length(stats_expectations) >= 1) AND (length(stats_expectations) <= 2000)) AND ((additional_notes IS NULL) OR ((length(additional_notes) >= 1) AND (length(additional_notes) <= 1000))) AND ((last_error_code IS NULL) OR (length(last_error_code) <= 80)) AND ((last_error_message IS NULL) OR (length(last_error_message) <= 1000))`),
	check("discord_partnership_tickets_version_check", sql`version >= 0`),
]);

export const discord_partnership_ticket_operations = pgTable("discord_partnership_ticket_operations", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	ticket_id: uuid().notNull(),
	operation_type: text().notNull(),
	interaction_id: text().notNull(),
	actor_discord_user_id: text().notNull(),
	status: text().default('pending').notNull(),
	from_status: text().notNull(),
	target_category_id: text(),
	observed_channel_id: text(),
	observed_category_id: text(),
	error_code: text(),
	error_message: text(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	completed_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	failed_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
}, (table) => [
	index("discord_partnership_ticket_operations_history_idx").using("btree", table.ticket_id.asc().nullsLast().op("timestamptz_ops"), table.created_at.asc().nullsLast().op("uuid_ops"), table.id.asc().nullsLast().op("timestamptz_ops")),
	uniqueIndex("discord_partnership_ticket_operations_one_pending").using("btree", table.ticket_id.asc().nullsLast().op("uuid_ops"), table.operation_type.asc().nullsLast().op("text_ops")).where(sql`(status = 'pending'::text)`),
	foreignKey({
			columns: [table.ticket_id],
			foreignColumns: [discord_partnership_tickets.id],
			name: "discord_partnership_ticket_operations_ticket_id_fkey"
		}).onDelete("restrict"),
	unique("discord_partnership_ticket_operations_interaction_id_key").on(table.interaction_id),
	check("discord_partnership_ticket_operations_error_check", sql`((error_code IS NULL) OR (length(error_code) <= 80)) AND ((error_message IS NULL) OR (length(error_message) <= 1000))`),
	check("discord_partnership_ticket_operations_ids_check", sql`(interaction_id ~ '^[0-9]{17,20}$'::text) AND (actor_discord_user_id ~ '^[0-9]{17,20}$'::text) AND ((target_category_id IS NULL) OR (target_category_id ~ '^[0-9]{17,20}$'::text)) AND ((observed_channel_id IS NULL) OR (observed_channel_id ~ '^[0-9]{17,20}$'::text)) AND ((observed_category_id IS NULL) OR (observed_category_id ~ '^[0-9]{17,20}$'::text))`),
	check("discord_partnership_ticket_operations_status_check", sql`status = ANY (ARRAY['pending'::text, 'completed'::text, 'failed'::text])`),
	check("discord_partnership_ticket_operations_type_check", sql`operation_type = ANY (ARRAY['offer'::text, 'close'::text])`),
]);

export const admin_balance_adjustment_wipes = pgTable("admin_balance_adjustment_wipes", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	user_id: varchar({ length: 36 }).notNull(),
	username: varchar({ length: 255 }),
	email: varchar({ length: 255 }),
	wiped_at: timestamp({ precision: 6, mode: 'string' }).defaultNow().notNull(),
	wiped_by: varchar({ length: 36 }).notNull(),
	total_amount: numeric({ precision: 20, scale:  2 }).notNull(),
	balance_before: numeric({ precision: 20, scale:  2 }).notNull(),
	balance_after: numeric({ precision: 20, scale:  2 }).notNull(),
	adjustment_count: integer().notNull(),
	snapshot: jsonb().notNull(),
	restored_at: timestamp({ precision: 6, mode: 'string' }),
	restored_by: varchar({ length: 36 }),
	status: varchar({ length: 16 }).default('completed').notNull(),
}, (table) => [
	index("admin_balance_adjustment_wipes_user_id_idx").using("btree", table.user_id.asc().nullsLast().op("text_ops")),
	index("admin_balance_adjustment_wipes_wiped_at_idx").using("btree", table.wiped_at.desc().nullsFirst().op("timestamp_ops")),
]);

export const admin_account_wipes = pgTable("admin_account_wipes", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	wipe_type: varchar({ length: 32 }).notNull(),
	user_id: varchar({ length: 36 }).notNull(),
	username: varchar({ length: 255 }),
	email: varchar({ length: 255 }),
	wiped_at: timestamp({ precision: 6, mode: 'string' }).defaultNow().notNull(),
	wiped_by: varchar({ length: 36 }).notNull(),
	amount: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	item_count: integer().default(0).notNull(),
	snapshot: jsonb().notNull(),
	restored_at: timestamp({ precision: 6, mode: 'string' }),
	restored_by: varchar({ length: 36 }),
	status: varchar({ length: 16 }).default('completed').notNull(),
}, (table) => [
	index("admin_account_wipes_user_id_idx").using("btree", table.user_id.asc().nullsLast().op("text_ops")),
	index("admin_account_wipes_wiped_at_idx").using("btree", table.wiped_at.desc().nullsFirst().op("timestamp_ops")),
]);

export const admin_balance_adjustment_meta = pgTable("admin_balance_adjustment_meta", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	admin_user_id: varchar({ length: 36 }).notNull(),
	target_user_id: varchar({ length: 36 }).notNull(),
	ledger_tx_id: varchar({ length: 36 }).notNull(),
	category: varchar({ length: 40 }).notNull(),
	amount_usd: numeric({ precision: 20, scale:  2 }).notNull(),
	coin_type: varchar({ length: 64 }),
	tx_hash: varchar({ length: 255 }),
	social_link: varchar({ length: 2048 }),
	reason_text: text(),
	lossback_pct: numeric({ precision: 7, scale:  2 }),
	pnl_7d_usd: numeric({ precision: 20, scale:  2 }),
	created_at: timestamp({ precision: 6, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("admin_balance_adjustment_meta_category_idx").using("btree", table.category.asc().nullsLast().op("text_ops")),
	index("admin_balance_adjustment_meta_created_at_idx").using("btree", table.created_at.desc().nullsFirst().op("timestamp_ops")),
	index("admin_balance_adjustment_meta_ledger_tx_id_idx").using("btree", table.ledger_tx_id.asc().nullsLast().op("text_ops")),
	index("admin_balance_adjustment_meta_target_user_id_idx").using("btree", table.target_user_id.asc().nullsLast().op("text_ops")),
]);

export const admin_leaderboard_creator_paid = pgTable("admin_leaderboard_creator_paid", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	leaderboard_id: text().notNull(),
	paid: boolean().default(false).notNull(),
	paid_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	set_by_admin_id: uuid().notNull(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	uniqueIndex("admin_leaderboard_creator_paid_leaderboard_id_key").using("btree", table.leaderboard_id.asc().nullsLast().op("text_ops")),
]);

export const admin_excluded_user_balance_v2 = pgTable("admin_excluded_user_balance_v2", {
	target_user_id: text().primaryKey().notNull(),
	balance_v2: numeric({ precision: 20, scale:  2 }).notNull(),
	set_by_admin_id: uuid(),
	set_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	notes: text(),
}, (table) => [
	index("admin_excluded_user_balance_v2_set_at_idx").using("btree", table.set_at.desc().nullsFirst().op("timestamptz_ops")),
	foreignKey({
			columns: [table.set_by_admin_id],
			foreignColumns: [admin_users.id],
			name: "admin_excluded_user_balance_v2_set_by_admin_id_fkey"
		}).onUpdate("cascade").onDelete("restrict"),
]);

export const kick_profiles = pgTable("kick_profiles", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	username: text().notNull(),
	kick_user_id: text(),
	display_name: text(),
	avatar_url: text(),
	bio: text(),
	follower_count: integer(),
	is_verified: boolean(),
	is_live: boolean().default(false).notNull(),
	raw_json: jsonb(),
	last_fetched_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("kick_profiles_last_fetched_at_idx").using("btree", table.last_fetched_at.asc().nullsLast().op("timestamptz_ops")),
	uniqueIndex("kick_profiles_username_key").using("btree", table.username.asc().nullsLast().op("text_ops")),
]);

export const kick_streams = pgTable("kick_streams", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	username: text().notNull(),
	kick_stream_id: text().notNull(),
	title: text(),
	category: text(),
	thumbnail_url: text(),
	started_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	ended_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	duration_seconds: integer(),
	vod_views: integer(),
	peak_viewers: integer(),
	vod_url: text(),
	raw_json: jsonb(),
	last_fetched_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("kick_streams_username_started_idx").using("btree", table.username.asc().nullsLast().op("timestamptz_ops"), table.started_at.desc().nullsFirst().op("text_ops")),
	uniqueIndex("kick_streams_username_stream_unique").using("btree", table.username.asc().nullsLast().op("text_ops"), table.kick_stream_id.asc().nullsLast().op("text_ops")),
]);

export const twitter_profiles = pgTable("twitter_profiles", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	username: text().notNull(),
	twitter_user_id: text(),
	display_name: text(),
	avatar_url: text(),
	bio: text(),
	follower_count: integer(),
	following_count: integer(),
	tweet_count: integer(),
	is_verified: boolean(),
	raw_json: jsonb(),
	last_fetched_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("twitter_profiles_last_fetched_at_idx").using("btree", table.last_fetched_at.asc().nullsLast().op("timestamptz_ops")),
	uniqueIndex("twitter_profiles_username_key").using("btree", table.username.asc().nullsLast().op("text_ops")),
]);

export const tweets = pgTable("tweets", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	username: text().notNull(),
	tweet_id: text().notNull(),
	text: text().notNull(),
	like_count: integer(),
	retweet_count: integer(),
	reply_count: integer(),
	view_count: integer(),
	mentions_us: boolean().default(false).notNull(),
	url: text(),
	posted_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	raw_json: jsonb(),
	last_fetched_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("tweets_username_mentions_posted_idx").using("btree", table.username.asc().nullsLast().op("text_ops"), table.mentions_us.asc().nullsLast().op("bool_ops"), table.posted_at.desc().nullsFirst().op("text_ops")),
	index("tweets_username_posted_idx").using("btree", table.username.asc().nullsLast().op("timestamptz_ops"), table.posted_at.desc().nullsFirst().op("text_ops")),
	uniqueIndex("tweets_username_tweet_id_key").using("btree", table.username.asc().nullsLast().op("text_ops"), table.tweet_id.asc().nullsLast().op("text_ops")),
	uniqueIndex("tweets_username_tweet_unique").using("btree", table.username.asc().nullsLast().op("text_ops"), table.tweet_id.asc().nullsLast().op("text_ops")),
]);

export const twitter_mentions = pgTable("twitter_mentions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	username: text().notNull(),
	tweet_id: text().notNull(),
	text: text().notNull(),
	matched_keyword: text(),
	url: text(),
	posted_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	last_fetched_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	raw_json: jsonb(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("twitter_mentions_posted_idx").using("btree", table.posted_at.desc().nullsFirst().op("timestamptz_ops")),
	uniqueIndex("twitter_mentions_tweet_unique").using("btree", table.tweet_id.asc().nullsLast().op("text_ops")),
	index("twitter_mentions_username_posted_idx").using("btree", table.username.asc().nullsLast().op("text_ops"), table.posted_at.desc().nullsFirst().op("text_ops")),
]);

export const creator_onboarding_checklist = pgTable("creator_onboarding_checklist", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	target_user_id: text().notNull(),
	lb_funds_collected: boolean().default(false).notNull(),
	lb_funds_collected_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	twitter_giveaway_done: boolean().default(false).notNull(),
	twitter_giveaway_url: text(),
	streaming_assets_provided: boolean().default(false).notNull(),
	lb_prepaid_coin: text(),
	lb_prepaid_tx_url: text(),
	completed_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	updated_by: uuid(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("creator_onboarding_checklist_completed_idx").using("btree", table.completed_at.asc().nullsLast().op("timestamptz_ops")),
	uniqueIndex("creator_onboarding_checklist_target_user_id_key").using("btree", table.target_user_id.asc().nullsLast().op("text_ops")),
]);

export const discord_partnership_transcripts = pgTable("discord_partnership_transcripts", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	ticket_id: uuid().notNull(),
	close_operation_id: uuid().notNull(),
	status: text().default('building').notNull(),
	message_count: integer().default(0).notNull(),
	content_sha256: text(),
	first_message_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	last_message_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	log_channel_id: text(),
	log_message_id: text(),
	attachment_id: text(),
	attachment_url: text(),
	finalized_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	delivered_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.close_operation_id],
			foreignColumns: [discord_partnership_ticket_operations.id],
			name: "discord_partnership_transcripts_close_operation_id_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.ticket_id],
			foreignColumns: [discord_partnership_tickets.id],
			name: "discord_partnership_transcripts_ticket_id_fkey"
		}).onDelete("restrict"),
	unique("discord_partnership_transcripts_close_operation_id_key").on(table.close_operation_id),
	unique("discord_partnership_transcripts_ticket_id_key").on(table.ticket_id),
	check("discord_partnership_transcripts_checksum_check", sql`(content_sha256 IS NULL) OR (content_sha256 ~ '^[a-f0-9]{64}$'::text)`),
	check("discord_partnership_transcripts_count_check", sql`message_count >= 0`),
	check("discord_partnership_transcripts_ids_check", sql`((log_channel_id IS NULL) OR (log_channel_id ~ '^[0-9]{17,20}$'::text)) AND ((log_message_id IS NULL) OR (log_message_id ~ '^[0-9]{17,20}$'::text)) AND ((attachment_id IS NULL) OR (attachment_id ~ '^[0-9]{17,20}$'::text))`),
	check("discord_partnership_transcripts_status_check", sql`status = ANY (ARRAY['building'::text, 'finalized'::text, 'delivered'::text])`),
]);

export const creator_crm = pgTable("creator_crm", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	target_user_id: text().notNull(),
	account_owner_id: uuid(),
	stage: text().default('onboarding').notNull(),
	onboarded_by: uuid(),
	onboarded_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	next_followup_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	updated_by: uuid(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("creator_crm_account_owner_idx").using("btree", table.account_owner_id.asc().nullsLast().op("uuid_ops")),
	index("creator_crm_stage_idx").using("btree", table.stage.asc().nullsLast().op("text_ops")),
	uniqueIndex("creator_crm_target_user_id_key").using("btree", table.target_user_id.asc().nullsLast().op("text_ops")),
]);

export const creator_alerts = pgTable("creator_alerts", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	target_user_id: text(),
	alert_type: text().notNull(),
	dedupe_key: text().notNull(),
	severity: text().default('info').notNull(),
	metadata: jsonb(),
	read_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	read_by: uuid(),
	dismissed_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	dismissed_by: uuid(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("creator_alerts_active_idx").using("btree", table.dismissed_at.asc().nullsLast().op("timestamptz_ops"), table.severity.asc().nullsLast().op("timestamptz_ops"), table.created_at.desc().nullsFirst().op("text_ops")),
	uniqueIndex("creator_alerts_dedupe_key_key").using("btree", table.dedupe_key.asc().nullsLast().op("text_ops")),
	index("creator_alerts_target_user_idx").using("btree", table.target_user_id.asc().nullsLast().op("text_ops")),
]);

export const creator_session_meta = pgTable("creator_session_meta", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	session_id: text().notNull(),
	target_user_id: text().notNull(),
	kick_vod_url: text(),
	notes: text(),
	updated_by: uuid(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("creator_session_meta_session_id_key").using("btree", table.session_id.asc().nullsLast().op("text_ops")),
	index("creator_session_meta_target_user_idx").using("btree", table.target_user_id.asc().nullsLast().op("text_ops")),
]);

export const admin_deleted_users = pgTable("admin_deleted_users", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	username: varchar({ length: 255 }),
	email: varchar({ length: 255 }),
	deleted_at: timestamp({ precision: 6, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	deleted_by: varchar({ length: 36 }).notNull(),
	expires_at: timestamp({ precision: 6, mode: 'string' }).notNull(),
	snapshot: jsonb().notNull(),
	restored_at: timestamp({ precision: 6, mode: 'string' }),
	restored_by: varchar({ length: 36 }),
}, (table) => [
	index("admin_deleted_users_deleted_at_idx").using("btree", table.deleted_at.desc().nullsFirst().op("timestamp_ops")),
	index("admin_deleted_users_expires_at_idx").using("btree", table.expires_at.asc().nullsLast().op("timestamp_ops")),
]);

export const discord_partnership_transcript_batches = pgTable("discord_partnership_transcript_batches", {
	batch_id: uuid().primaryKey().notNull(),
	transcript_id: uuid().notNull(),
	payload_sha256: text().notNull(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("discord_partnership_transcript_batches_transcript_idx").using("btree", table.transcript_id.asc().nullsLast().op("timestamptz_ops"), table.created_at.asc().nullsLast().op("uuid_ops"), table.batch_id.asc().nullsLast().op("timestamptz_ops")),
	foreignKey({
			columns: [table.transcript_id],
			foreignColumns: [discord_partnership_transcripts.id],
			name: "discord_partnership_transcript_batches_transcript_id_fkey"
		}).onDelete("restrict"),
	check("discord_partnership_transcript_batches_checksum_check", sql`payload_sha256 ~ '^[a-f0-9]{64}$'::text`),
]);

export const crypto_fee_profit_counter = pgTable("crypto_fee_profit_counter", {
	id: text().default('singleton').primaryKey().notNull(),
	count_start_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).notNull(),
	deposit_fee_bps: numeric({ precision: 7, scale:  4 }).notNull(),
	withdrawal_fee_bps: numeric({ precision: 7, scale:  4 }).notNull(),
	total_fee_usd: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	deposit_fee_usd: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	withdrawal_fee_usd: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const pack_set_assignments = pgTable("pack_set_assignments", {
	pack_id: uuid().primaryKey().notNull(),
	pack_set: text().notNull(),
	set_by_admin_id: uuid(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	index("pack_set_assignments_pack_set_idx").using("btree", table.pack_set.asc().nullsLast().op("text_ops")),
]);

export const admin_roles = pgTable("admin_roles", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: text().notNull(),
	description: text(),
	is_system: boolean().default(false).notNull(),
	capabilities: text().array().default(sql`'{}'::text[]`).notNull(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).notNull(),
	system_key: admin_role(),
	balance_limit_daily: numeric({ precision: 12, scale:  2 }),
	balance_limit_weekly: numeric({ precision: 12, scale:  2 }),
	balance_limit_monthly: numeric({ precision: 12, scale:  2 }),
	issuance_limit_daily: numeric({ precision: 12, scale:  2 }),
	issuance_limit_weekly: numeric({ precision: 12, scale:  2 }),
	issuance_limit_monthly: numeric({ precision: 12, scale:  2 }),
	landing_route: text(),
}, (table) => [
	uniqueIndex("admin_roles_name_key").using("btree", table.name.asc().nullsLast().op("text_ops")),
	uniqueIndex("admin_roles_system_key_key").using("btree", table.system_key.asc().nullsLast().op("enum_ops")),
]);

export const roadmap_items = pgTable("roadmap_items", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	title: text().notNull(),
	description: text(),
	status: roadmap_status().default('planned').notNull(),
	start_date: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	end_date: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	color: text(),
	body: text(),
	sort_order: integer().default(0).notNull(),
	created_by: uuid(),
	archived_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	index("roadmap_items_active_idx").using("btree", table.archived_at.asc().nullsLast().op("timestamptz_ops"), table.start_date.asc().nullsLast().op("timestamptz_ops")),
	index("roadmap_items_range_idx").using("btree", table.start_date.asc().nullsLast().op("timestamptz_ops"), table.end_date.asc().nullsLast().op("timestamptz_ops")),
]);

export const roadmap_detail_fields = pgTable("roadmap_detail_fields", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	item_id: uuid().notNull(),
	label: text().notNull(),
	value: text().notNull(),
	sort_order: integer().default(0).notNull(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	index("roadmap_detail_fields_item_idx").using("btree", table.item_id.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.item_id],
			foreignColumns: [roadmap_items.id],
			name: "roadmap_detail_fields_item_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const roadmap_links = pgTable("roadmap_links", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	item_id: uuid().notNull(),
	label: text().notNull(),
	url: text().notNull(),
	sort_order: integer().default(0).notNull(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	index("roadmap_links_item_idx").using("btree", table.item_id.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.item_id],
			foreignColumns: [roadmap_items.id],
			name: "roadmap_links_item_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const roadmap_linear_links = pgTable("roadmap_linear_links", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	item_id: uuid().notNull(),
	linear_issue_id: text().notNull(),
	identifier: text().notNull(),
	title: text().notNull(),
	url: text().notNull(),
	state_name: text(),
	state_type: text(),
	state_color: text(),
	assignee_name: text(),
	synced_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	index("roadmap_linear_links_item_idx").using("btree", table.item_id.asc().nullsLast().op("uuid_ops")),
	uniqueIndex("roadmap_linear_links_item_issue_key").using("btree", table.item_id.asc().nullsLast().op("text_ops"), table.linear_issue_id.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.item_id],
			foreignColumns: [roadmap_items.id],
			name: "roadmap_linear_links_item_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const admin_passkeys = pgTable("admin_passkeys", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	admin_user_id: uuid().notNull(),
	credential_id: text().notNull(),
	public_key: bytea("public_key").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	counter: bigint({ mode: "number" }).default(0).notNull(),
	transports: text().array().default(sql`'{}'::text[]`).notNull(),
	device_name: text(),
	backed_up: boolean().default(false).notNull(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	last_used_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
}, (table) => [
	index("admin_passkeys_admin_user_id_idx").using("btree", table.admin_user_id.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.admin_user_id],
			foreignColumns: [admin_users.id],
			name: "admin_passkeys_admin_user_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	unique("admin_passkeys_credential_id_key").on(table.credential_id),
]);

export const pack_risk_scores = pgTable("pack_risk_scores", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	pack_id: text().notNull(),
	edge: numeric({ precision: 8, scale:  4 }).notNull(),
	cv: numeric({ precision: 8, scale:  4 }).notNull(),
	win_rate: numeric({ precision: 6, scale:  4 }).notNull(),
	near_miss: numeric({ precision: 6, scale:  4 }).notNull(),
	max_win: numeric({ precision: 20, scale:  2 }).notNull(),
	max_mult: numeric({ precision: 12, scale:  4 }).notNull(),
	risk_score: integer().notNull(),
	tier: text().notNull(),
	compliance: jsonb().notNull(),
	computed_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	uniqueIndex("pack_risk_scores_pack_id_key").using("btree", table.pack_id.asc().nullsLast().op("text_ops")),
]);

export const pack_retune_drafts = pgTable("pack_retune_drafts", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	pack_id: uuid().notNull(),
	status: text().default('draft').notNull(),
	proposed_price: numeric({ precision: 20, scale:  2 }).notNull(),
	proposed_pool: jsonb().notNull(),
	computed_risk: jsonb().notNull(),
	source_snapshot: jsonb().notNull(),
	notes: text(),
	created_by: uuid().notNull(),
	last_edited_by: uuid().notNull(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	last_edited_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	pushed_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	pushed_by: uuid(),
	discarded_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	discarded_by: uuid(),
}, (table) => [
	index("pack_retune_drafts_created_at_idx").using("btree", table.created_at.desc().nullsFirst().op("timestamptz_ops")),
	uniqueIndex("pack_retune_drafts_one_pending_per_pack").using("btree", table.pack_id.asc().nullsLast().op("uuid_ops")).where(sql`(status = 'draft'::text)`),
	index("pack_retune_drafts_pack_id_idx").using("btree", table.pack_id.asc().nullsLast().op("uuid_ops")),
	index("pack_retune_drafts_status_edited_idx").using("btree", table.status.asc().nullsLast().op("timestamptz_ops"), table.last_edited_at.desc().nullsFirst().op("text_ops")),
]);

export const admin_withdrawal_unlocks = pgTable("admin_withdrawal_unlocks", {
	target_user_id: text().primaryKey().notNull(),
	unlocked_by: uuid(),
	unlocked_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	notes: text(),
}, (table) => [
	index("admin_withdrawal_unlocks_unlocked_at_idx").using("btree", table.unlocked_at.desc().nullsFirst().op("timestamptz_ops")),
	foreignKey({
			columns: [table.unlocked_by],
			foreignColumns: [admin_users.id],
			name: "admin_withdrawal_unlocks_unlocked_by_fkey"
		}).onUpdate("cascade").onDelete("set null"),
]);

export const pack_state_snapshots = pgTable("pack_state_snapshots", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	pack_id: text().notNull(),
	captured_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	captured_by: uuid().notNull(),
	action: text().notNull(),
	price: numeric({ precision: 20, scale:  2 }).notNull(),
	cards: jsonb().notNull(),
	risk: jsonb(),
	note: text(),
	tags: jsonb(),
}, (table) => [
	index("pack_state_snapshots_action_pack_idx").using("btree", table.action.asc().nullsLast().op("text_ops"), table.pack_id.asc().nullsLast().op("text_ops")),
	index("pack_state_snapshots_pack_captured_idx").using("btree", table.pack_id.asc().nullsLast().op("text_ops"), table.captured_at.desc().nullsFirst().op("text_ops")),
]);

export const api_keys = pgTable("api_keys", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: text().notNull(),
	prefix: text().notNull(),
	key_hash: text().notNull(),
	scopes: text().array().default(sql`'{}'::text[]`).notNull(),
	is_active: boolean().default(true).notNull(),
	expires_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	last_used_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	last_used_ip: text(),
	request_count: integer().default(0).notNull(),
	rate_limit_per_min: integer().default(120).notNull(),
	created_by: uuid(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	revoked_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	revoked_by: uuid(),
	allowed_ips: text().array().default(sql`'{}'::text[]`).notNull(),
}, (table) => [
	index("api_keys_created_at_idx").using("btree", table.created_at.desc().nullsFirst().op("timestamptz_ops")),
	index("api_keys_is_active_idx").using("btree", table.is_active.asc().nullsLast().op("bool_ops")),
	uniqueIndex("api_keys_prefix_key").using("btree", table.prefix.asc().nullsLast().op("text_ops")),
]);

export const discord_verifications = pgTable("discord_verifications", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	discord_user_id: text().notNull(),
	user_id: text().notNull(),
	first_verified_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	last_verified_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	verify_count: integer().default(1).notNull(),
}, (table) => [
	uniqueIndex("discord_verifications_discord_user_id_key").using("btree", table.discord_user_id.asc().nullsLast().op("text_ops")),
	index("discord_verifications_first_verified_idx").using("btree", table.first_verified_at.desc().nullsFirst().op("timestamptz_ops")),
	index("discord_verifications_user_id_idx").using("btree", table.user_id.asc().nullsLast().op("text_ops")),
]);

export const creator_reward_program_windows = pgTable("creator_reward_program_windows", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	program_id: uuid().notNull(),
	started_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).notNull(),
	ended_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
}, (table) => [
	index("creator_reward_program_windows_program_idx").using("btree", table.program_id.asc().nullsLast().op("timestamptz_ops"), table.started_at.asc().nullsLast().op("timestamptz_ops")),
	foreignKey({
			columns: [table.program_id],
			foreignColumns: [creator_reward_programs.id],
			name: "creator_reward_program_windows_program_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const creator_reward_claims = pgTable("creator_reward_claims", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	program_id: uuid().notNull(),
	user_id: text().notNull(),
	discord_user_id: text(),
	wager_basis_usd: numeric({ precision: 20, scale:  2 }).notNull(),
	prior_consumed_usd: numeric({ precision: 20, scale:  2 }).notNull(),
	consumed_wager_usd: numeric({ precision: 20, scale:  2 }).notNull(),
	units: integer().notNull(),
	amount_usd: numeric({ precision: 20, scale:  2 }).notNull(),
	status: text().default('pending').notNull(),
	requested_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	reviewed_by: uuid(),
	reviewed_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	review_note: text(),
	ledger_tx_id: uuid(),
	forfeited_wager_usd: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	lifetime_wager_usd: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	run_started_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	applied_reward_usd: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	was_vip: boolean().default(false).notNull(),
	reinstated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	reinstated_by: uuid(),
	ftd_deposit_usd: numeric({ precision: 20, scale:  2 }),
	ftd_loss_usd: numeric({ precision: 20, scale:  2 }),
	leg: text().default('wager').notNull(),
	bot_notified_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	bot_notify_error: text(),
}, (table) => [
	uniqueIndex("creator_reward_claims_one_pending_per_user").using("btree", table.program_id.asc().nullsLast().op("uuid_ops"), table.user_id.asc().nullsLast().op("text_ops"), table.leg.asc().nullsLast().op("uuid_ops")).where(sql`(status = 'pending'::text)`),
	index("creator_reward_claims_program_user_idx").using("btree", table.program_id.asc().nullsLast().op("uuid_ops"), table.user_id.asc().nullsLast().op("uuid_ops")),
	index("creator_reward_claims_status_requested_idx").using("btree", table.status.asc().nullsLast().op("timestamptz_ops"), table.requested_at.desc().nullsFirst().op("timestamptz_ops")),
	index("creator_reward_claims_user_idx").using("btree", table.user_id.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.program_id],
			foreignColumns: [creator_reward_programs.id],
			name: "creator_reward_claims_program_id_fkey"
		}).onUpdate("cascade").onDelete("restrict"),
]);

export const creator_reward_programs = pgTable("creator_reward_programs", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: text().notNull(),
	creator_user_id: text().notNull(),
	codes: text().array().default(sql`'{}'::text[]`),
	threshold_usd: numeric({ precision: 20, scale:  2 }),
	reward_usd: numeric({ precision: 20, scale:  2 }),
	is_active: boolean().default(true).notNull(),
	accrual_start_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).notNull(),
	max_reward_per_user_usd: numeric({ precision: 20, scale:  2 }),
	created_by: uuid().notNull(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	vip_reward_usd: numeric({ precision: 20, scale:  2 }),
	lossback_pct: numeric({ precision: 6, scale:  2 }),
	min_deposit_usd: numeric({ precision: 20, scale:  2 }),
	archived_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	archived_by: uuid(),
	ends_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	source_approval_request_id: uuid(),
}, (table) => [
	index("creator_reward_programs_creator_idx").using("btree", table.creator_user_id.asc().nullsLast().op("text_ops")),
	index("creator_reward_programs_is_active_idx").using("btree", table.is_active.asc().nullsLast().op("bool_ops")),
	index("creator_reward_programs_live_idx").using("btree", table.created_at.desc().nullsFirst().op("timestamptz_ops")).where(sql`(archived_at IS NULL)`),
	uniqueIndex("creator_reward_programs_source_approval_unique").using("btree", table.source_approval_request_id.asc().nullsLast().op("uuid_ops")).where(sql`(source_approval_request_id IS NOT NULL)`),
	foreignKey({
			columns: [table.source_approval_request_id],
			foreignColumns: [creator_deal_approval_requests.id],
			name: "creator_reward_programs_source_approval_fkey"
		}).onDelete("restrict"),
	check("creator_reward_programs_archived_not_active", sql`(archived_at IS NULL) OR (is_active = false)`),
	check("creator_reward_programs_end_after_start", sql`(ends_at IS NULL) OR (ends_at > accrual_start_at)`),
]);

export const chat_raffle_rounds = pgTable("chat_raffle_rounds", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: text().notNull(),
	status: text().default('open').notNull(),
	starts_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).notNull(),
	ends_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).notNull(),
	points_per_message: integer().default(1).notNull(),
	min_message_chars: integer().default(3).notNull(),
	bucket_minutes: integer().default(10).notNull(),
	max_messages_per_bucket: integer().default(10).notNull(),
	dedupe_identical: boolean().default(true).notNull(),
	draw_seed: text(),
	drawn_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	drawn_by: uuid(),
	entrants_at_draw: integer(),
	tickets_at_draw: integer(),
	created_by: uuid(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("chat_raffle_rounds_ends_at_idx").using("btree", table.ends_at.desc().nullsFirst().op("timestamptz_ops")),
	index("chat_raffle_rounds_status_idx").using("btree", table.status.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.created_by],
			foreignColumns: [admin_users.id],
			name: "chat_raffle_rounds_created_by_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.drawn_by],
			foreignColumns: [admin_users.id],
			name: "chat_raffle_rounds_drawn_by_fkey"
		}).onDelete("set null"),
]);

export const chat_raffle_prizes = pgTable("chat_raffle_prizes", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	round_id: uuid().notNull(),
	position: integer().notNull(),
	amount_usd: numeric({ precision: 20, scale:  2 }).notNull(),
	label: text(),
	winner_user_id: text(),
	winner_username: text(),
	winner_tickets: integer(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	winning_ticket: bigint({ mode: "number" }),
	paid_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	paid_by: uuid(),
	ledger_tx_id: text(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("chat_raffle_prizes_round_idx").using("btree", table.round_id.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.paid_by],
			foreignColumns: [admin_users.id],
			name: "chat_raffle_prizes_paid_by_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.round_id],
			foreignColumns: [chat_raffle_rounds.id],
			name: "chat_raffle_prizes_round_id_fkey"
		}).onDelete("cascade"),
	unique("chat_raffle_prizes_round_position_unique").on(table.position, table.round_id),
]);

export const chat_raffle_entries = pgTable("chat_raffle_entries", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	round_id: uuid().notNull(),
	user_id: text().notNull(),
	username: text(),
	discord_user_id: text(),
	message_count: integer().default(0).notNull(),
	discord_xp: integer(),
	site_chat_xp: integer(),
	discord_message_count: integer(),
	site_chat_message_count: integer(),
	community_total_xp: integer(),
	community_level: integer(),
	base_points: integer().default(0).notNull(),
	adjustment_points: integer().default(0).notNull(),
	tickets: integer().default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ticket_start: bigint({ mode: "number" }).default(0).notNull(),
	position: integer().default(0).notNull(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("chat_raffle_entries_round_position_idx").using("btree", table.round_id.asc().nullsLast().op("uuid_ops"), table.position.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.round_id],
			foreignColumns: [chat_raffle_rounds.id],
			name: "chat_raffle_entries_round_id_fkey"
		}).onDelete("cascade"),
	unique("chat_raffle_entries_round_user_unique").on(table.round_id, table.user_id),
	check("chat_raffle_entries_community_xp_check", sql`(discord_user_id IS NULL OR discord_user_id ~ '^[0-9]{17,20}$'::text) AND (discord_xp IS NULL OR discord_xp >= 0) AND (site_chat_xp IS NULL OR site_chat_xp >= 0) AND (community_total_xp IS NULL OR community_total_xp >= 0) AND (community_level IS NULL OR community_level >= 0) AND ((discord_xp IS NULL AND site_chat_xp IS NULL) OR (discord_xp IS NOT NULL AND site_chat_xp IS NOT NULL AND base_points = (discord_xp + site_chat_xp)))`),
	check("chat_raffle_entries_source_message_counts_check", sql`(discord_message_count IS NULL AND site_chat_message_count IS NULL) OR (discord_message_count IS NOT NULL AND discord_message_count >= 0 AND site_chat_message_count IS NOT NULL AND site_chat_message_count >= 0 AND message_count = (discord_message_count + site_chat_message_count))`),
]);

export const chat_raffle_adjustments = pgTable("chat_raffle_adjustments", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	round_id: uuid().notNull(),
	user_id: text().notNull(),
	points: integer().notNull(),
	reason: text().notNull(),
	created_by: uuid(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("chat_raffle_adjustments_round_idx").using("btree", table.round_id.asc().nullsLast().op("uuid_ops")),
	index("chat_raffle_adjustments_round_user_idx").using("btree", table.round_id.asc().nullsLast().op("text_ops"), table.user_id.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.created_by],
			foreignColumns: [admin_users.id],
			name: "chat_raffle_adjustments_created_by_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.round_id],
			foreignColumns: [chat_raffle_rounds.id],
			name: "chat_raffle_adjustments_round_id_fkey"
		}).onDelete("cascade"),
]);

export const admin_stepup_used = pgTable("admin_stepup_used", {
	jti: text().primaryKey().notNull(),
	admin_user_id: uuid().notNull(),
	used_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("admin_stepup_used_used_at_idx").using("btree", table.used_at.asc().nullsLast().op("timestamptz_ops")),
]);

export const staff_profiles = pgTable("staff_profiles", {
	admin_user_id: uuid().primaryKey().notNull(),
	display_name: text(),
	title: text(),
	bio: text(),
	accent: text().default('blue').notNull(),
	points_total: integer().default(0).notNull(),
	level: integer().default(1).notNull(),
	quizzes_completed: integer().default(0).notNull(),
	reviews_resolved: integer().default(0).notNull(),
	last_seen_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("staff_profiles_points_idx").using("btree", table.points_total.desc().nullsFirst().op("int4_ops")),
	foreignKey({
			columns: [table.admin_user_id],
			foreignColumns: [admin_users.id],
			name: "staff_profiles_admin_user_id_fkey"
		}).onDelete("cascade"),
]);

export const staff_point_events = pgTable("staff_point_events", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	admin_user_id: uuid().notNull(),
	points: integer().notNull(),
	source_kind: text().notNull(),
	source_id: uuid(),
	reason: text().notNull(),
	created_by: uuid(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("staff_point_events_created_idx").using("btree", table.created_at.desc().nullsFirst().op("timestamptz_ops")),
	uniqueIndex("staff_point_events_source_uniq").using("btree", table.source_kind.asc().nullsLast().op("text_ops"), table.source_id.asc().nullsLast().op("text_ops")).where(sql`((source_id IS NOT NULL) AND (source_kind <> 'manual'::text))`),
	index("staff_point_events_user_created_idx").using("btree", table.admin_user_id.asc().nullsLast().op("timestamptz_ops"), table.created_at.desc().nullsFirst().op("timestamptz_ops")),
	foreignKey({
			columns: [table.admin_user_id],
			foreignColumns: [admin_users.id],
			name: "staff_point_events_admin_user_id_fkey"
		}).onDelete("cascade"),
]);

export const staff_notifications = pgTable("staff_notifications", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	admin_user_id: uuid().notNull(),
	kind: text().notNull(),
	title: text().notNull(),
	body: text(),
	href: text(),
	metadata: jsonb(),
	read_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("staff_notifications_user_created_idx").using("btree", table.admin_user_id.asc().nullsLast().op("timestamptz_ops"), table.created_at.desc().nullsFirst().op("timestamptz_ops")),
	index("staff_notifications_user_unread_idx").using("btree", table.admin_user_id.asc().nullsLast().op("uuid_ops")).where(sql`(read_at IS NULL)`),
	foreignKey({
			columns: [table.admin_user_id],
			foreignColumns: [admin_users.id],
			name: "staff_notifications_admin_user_id_fkey"
		}).onDelete("cascade"),
]);

export const staff_notification_channels = pgTable("staff_notification_channels", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	admin_user_id: uuid().notNull(),
	channel: text().notNull(),
	target: text().notNull(),
	enabled: boolean().default(true).notNull(),
	verified_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	verification_code: text(),
	verification_sent_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	verify_attempts: integer().default(0).notNull(),
	last_error: text(),
	last_sent_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("staff_notification_channels_user_channel_uniq").using("btree", table.admin_user_id.asc().nullsLast().op("text_ops"), table.channel.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.admin_user_id],
			foreignColumns: [admin_users.id],
			name: "staff_notification_channels_admin_user_id_fkey"
		}).onDelete("cascade"),
]);

export const staff_notification_prefs = pgTable("staff_notification_prefs", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	admin_user_id: uuid().notNull(),
	kind: text().notNull(),
	in_app: boolean().default(true).notNull(),
	discord: boolean().default(true).notNull(),
	telegram: boolean().default(false).notNull(),
	updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("staff_notification_prefs_user_kind_uniq").using("btree", table.admin_user_id.asc().nullsLast().op("text_ops"), table.kind.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.admin_user_id],
			foreignColumns: [admin_users.id],
			name: "staff_notification_prefs_admin_user_id_fkey"
		}).onDelete("cascade"),
]);

export const staff_quizzes = pgTable("staff_quizzes", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	title: text().notNull(),
	description: text(),
	status: text().default('draft').notNull(),
	points_per_correct: integer().default(1).notNull(),
	pass_percent: integer().default(70).notNull(),
	max_attempts: integer().default(1).notNull(),
	time_limit_seconds: integer(),
	shuffle_questions: boolean().default(false).notNull(),
	audience_roles: text().array().default(sql`'{}'::text[]`).notNull(),
	created_by: uuid(),
	published_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("staff_quizzes_status_created_idx").using("btree", table.status.asc().nullsLast().op("text_ops"), table.created_at.desc().nullsFirst().op("text_ops")),
]);

export const staff_quiz_questions = pgTable("staff_quiz_questions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	quiz_id: uuid().notNull(),
	position: integer().default(0).notNull(),
	prompt: text().notNull(),
	kind: text().default('single').notNull(),
	explanation: text(),
	points: integer().default(1).notNull(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("staff_quiz_questions_quiz_position_idx").using("btree", table.quiz_id.asc().nullsLast().op("int4_ops"), table.position.asc().nullsLast().op("int4_ops")),
	foreignKey({
			columns: [table.quiz_id],
			foreignColumns: [staff_quizzes.id],
			name: "staff_quiz_questions_quiz_id_fkey"
		}).onDelete("cascade"),
]);

export const staff_quiz_options = pgTable("staff_quiz_options", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	question_id: uuid().notNull(),
	position: integer().default(0).notNull(),
	label: text().notNull(),
	is_correct: boolean().default(false).notNull(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("staff_quiz_options_question_position_idx").using("btree", table.question_id.asc().nullsLast().op("int4_ops"), table.position.asc().nullsLast().op("int4_ops")),
	foreignKey({
			columns: [table.question_id],
			foreignColumns: [staff_quiz_questions.id],
			name: "staff_quiz_options_question_id_fkey"
		}).onDelete("cascade"),
]);

export const staff_quiz_attempts = pgTable("staff_quiz_attempts", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	quiz_id: uuid().notNull(),
	admin_user_id: uuid().notNull(),
	status: text().default('in_progress').notNull(),
	score: integer().default(0).notNull(),
	max_score: integer().default(0).notNull(),
	correct_count: integer().default(0).notNull(),
	question_count: integer().default(0).notNull(),
	points_awarded: integer().default(0).notNull(),
	started_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	submitted_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
}, (table) => [
	uniqueIndex("staff_quiz_attempts_open_uniq").using("btree", table.quiz_id.asc().nullsLast().op("uuid_ops"), table.admin_user_id.asc().nullsLast().op("uuid_ops")).where(sql`(status = 'in_progress'::text)`),
	index("staff_quiz_attempts_quiz_idx").using("btree", table.quiz_id.asc().nullsLast().op("uuid_ops"), table.submitted_at.desc().nullsFirst().op("uuid_ops")),
	index("staff_quiz_attempts_user_started_idx").using("btree", table.admin_user_id.asc().nullsLast().op("uuid_ops"), table.started_at.desc().nullsFirst().op("timestamptz_ops")),
	foreignKey({
			columns: [table.admin_user_id],
			foreignColumns: [admin_users.id],
			name: "staff_quiz_attempts_admin_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.quiz_id],
			foreignColumns: [staff_quizzes.id],
			name: "staff_quiz_attempts_quiz_id_fkey"
		}).onDelete("cascade"),
]);

export const staff_quiz_answers = pgTable("staff_quiz_answers", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	attempt_id: uuid().notNull(),
	question_id: uuid().notNull(),
	selected_option_ids: uuid().array().default(sql`'{}'::uuid[]`).notNull(),
	is_correct: boolean().default(false).notNull(),
	points_awarded: integer().default(0).notNull(),
	answered_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("staff_quiz_answers_attempt_question_uniq").using("btree", table.attempt_id.asc().nullsLast().op("uuid_ops"), table.question_id.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.attempt_id],
			foreignColumns: [staff_quiz_attempts.id],
			name: "staff_quiz_answers_attempt_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.question_id],
			foreignColumns: [staff_quiz_questions.id],
			name: "staff_quiz_answers_question_id_fkey"
		}).onDelete("cascade"),
]);

export const antifraud_reviews = pgTable("antifraud_reviews", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	target_user_id: text().notNull(),
	target_username: text(),
	status: text().default('open').notNull(),
	severity: text().default('medium').notNull(),
	source: text().default('manual').notNull(),
	risk_score: integer(),
	reason: text().notNull(),
	signals: text().array().default(sql`'{}'::text[]`).notNull(),
	assigned_to: uuid(),
	opened_by: uuid(),
	resolution: text(),
	resolved_by: uuid(),
	resolved_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	metadata: jsonb(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("antifraud_reviews_assigned_idx").using("btree", table.assigned_to.asc().nullsLast().op("timestamptz_ops"), table.created_at.desc().nullsFirst().op("timestamptz_ops")),
	index("antifraud_reviews_created_id_idx").using("btree", table.created_at.desc().nullsFirst().op("uuid_ops"), table.id.desc().nullsFirst().op("timestamptz_ops")),
	index("antifraud_reviews_created_idx").using("btree", table.created_at.desc().nullsFirst().op("timestamptz_ops")),
	uniqueIndex("antifraud_reviews_open_target_uniq").using("btree", table.target_user_id.asc().nullsLast().op("text_ops")).where(sql`(status = ANY (ARRAY['open'::text, 'in_review'::text]))`),
	index("antifraud_reviews_reason_trgm_idx").using("gin", table.reason.asc().nullsLast().op("gin_trgm_ops")),
	index("antifraud_reviews_status_created_idx").using("btree", table.status.asc().nullsLast().op("timestamptz_ops"), table.created_at.desc().nullsFirst().op("timestamptz_ops")),
	index("antifraud_reviews_target_idx").using("btree", table.target_user_id.asc().nullsLast().op("text_ops")),
	index("antifraud_reviews_target_user_trgm_idx").using("gin", table.target_user_id.asc().nullsLast().op("gin_trgm_ops")),
	index("antifraud_reviews_username_trgm_idx").using("gin", table.target_username.asc().nullsLast().op("gin_trgm_ops")),
]);

export const antifraud_review_notes = pgTable("antifraud_review_notes", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	review_id: uuid().notNull(),
	admin_user_id: uuid(),
	kind: text().default('note').notNull(),
	body: text().notNull(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("antifraud_review_notes_review_created_idx").using("btree", table.review_id.asc().nullsLast().op("timestamptz_ops"), table.created_at.desc().nullsFirst().op("timestamptz_ops")),
	foreignKey({
			columns: [table.review_id],
			foreignColumns: [antifraud_reviews.id],
			name: "antifraud_review_notes_review_id_fkey"
		}).onDelete("cascade"),
]);

export const creator_reward_offer_windows = pgTable("creator_reward_offer_windows", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	program_id: uuid().notNull(),
	user_id: text().notNull(),
	leg: text().notNull(),
	run_started_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).notNull(),
	basis_position_usd: numeric({ precision: 20, scale:  2 }).notNull(),
	basis_usd: numeric({ precision: 20, scale:  2 }).default('0').notNull(),
	claimable_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	expires_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).notNull(),
	claimed_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	claim_id: uuid(),
}, (table) => [
	index("creator_reward_offer_windows_claim_idx").using("btree", table.claim_id.asc().nullsLast().op("uuid_ops")).where(sql`(claim_id IS NOT NULL)`),
	index("creator_reward_offer_windows_lookup_idx").using("btree", table.program_id.asc().nullsLast().op("text_ops"), table.user_id.asc().nullsLast().op("text_ops"), table.leg.asc().nullsLast().op("uuid_ops"), table.expires_at.asc().nullsLast().op("uuid_ops")),
	index("creator_reward_offer_windows_open_expiry_idx").using("btree", table.expires_at.asc().nullsLast().op("timestamptz_ops")).where(sql`(claimed_at IS NULL)`),
	uniqueIndex("creator_reward_offer_windows_unit_key").using("btree", table.program_id.asc().nullsLast().op("text_ops"), table.user_id.asc().nullsLast().op("uuid_ops"), table.leg.asc().nullsLast().op("text_ops"), table.run_started_at.asc().nullsLast().op("timestamptz_ops"), table.basis_position_usd.asc().nullsLast().op("numeric_ops")),
	foreignKey({
			columns: [table.claim_id],
			foreignColumns: [creator_reward_claims.id],
			name: "creator_reward_offer_windows_claim_id_fkey"
		}).onUpdate("cascade").onDelete("restrict"),
	foreignKey({
			columns: [table.program_id],
			foreignColumns: [creator_reward_programs.id],
			name: "creator_reward_offer_windows_program_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	check("creator_reward_offer_windows_claim_link_chk", sql`(claimed_at IS NULL) = (claim_id IS NULL)`),
]);

export const discord_notification_jobs = pgTable("discord_notification_jobs", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	guild_id: text().notNull(),
	event_key: text().notNull(),
	channel_id: text().notNull(),
	dedupe_key: text().notNull(),
	content: text(),
	embed: jsonb().notNull(),
	status: text().default('pending').notNull(),
	attempt_count: integer().default(0).notNull(),
	max_attempts: integer().default(10).notNull(),
	available_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lease_token: uuid(),
	lease_owner: text(),
	leased_until: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	discord_message_id: text(),
	last_error_code: text(),
	last_error_message: text(),
	delivered_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	components: jsonb().default([]).notNull(),
	allowed_mentions: jsonb(),
}, (table) => [
	index("discord_notification_jobs_claim_idx").using("btree", table.guild_id.asc().nullsLast().op("text_ops"), table.available_at.asc().nullsLast().op("text_ops"), table.created_at.asc().nullsLast().op("text_ops")).where(sql`(status = ANY (ARRAY['pending'::text, 'leased'::text]))`),
	uniqueIndex("discord_notification_jobs_dedupe_idx").using("btree", table.guild_id.asc().nullsLast().op("text_ops"), table.event_key.asc().nullsLast().op("text_ops"), table.dedupe_key.asc().nullsLast().op("text_ops"), table.channel_id.asc().nullsLast().op("text_ops")),
	index("discord_notification_jobs_history_idx").using("btree", table.guild_id.asc().nullsLast().op("text_ops"), table.created_at.desc().nullsFirst().op("text_ops")),
	foreignKey({
			columns: [table.guild_id, table.channel_id],
			foreignColumns: [discord_notification_channels.guild_id, discord_notification_channels.channel_id],
			name: "discord_notification_jobs_channel_fk"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.event_key],
			foreignColumns: [discord_notification_events.event_key],
			name: "discord_notification_jobs_event_key_fkey"
		}).onDelete("restrict"),
	check("discord_notification_jobs_attempt_check", sql`(attempt_count >= 0) AND ((max_attempts >= 1) AND (max_attempts <= 25))`),
	check("discord_notification_jobs_status_check", sql`status = ANY (ARRAY['pending'::text, 'leased'::text, 'delivered'::text, 'dead'::text])`),
]);

export const pack_creation_requests = pgTable("pack_creation_requests", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	status: text().default('pending').notNull(),
	requested_by: uuid().notNull(),
	reviewed_by: uuid(),
	name: text().notNull(),
	slug: text().notNull(),
	requested_active: boolean().default(false).notNull(),
	request_payload: jsonb().notNull(),
	preview_edge: numeric({ precision: 8, scale:  6 }).notNull(),
	preview_win_rate: numeric({ precision: 8, scale:  6 }).notNull(),
	created_pack_id: uuid(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	review_started_at: timestamp({ withTimezone: true, mode: 'string' }),
	reviewed_at: timestamp({ withTimezone: true, mode: 'string' }),
	preview_max_win: numeric({ precision: 20, scale:  2 }),
	revision: integer().default(1).notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("pack_creation_requests_pending_slug_key").using("btree", sql`lower(slug)`).where(sql`(status = ANY (ARRAY['pending'::text, 'processing'::text]))`),
	index("pack_creation_requests_requested_by_created_idx").using("btree", table.requested_by.asc().nullsLast().op("timestamptz_ops"), table.created_at.desc().nullsFirst().op("timestamptz_ops")),
	index("pack_creation_requests_status_created_idx").using("btree", table.status.asc().nullsLast().op("timestamptz_ops"), table.created_at.desc().nullsFirst().op("text_ops")),
	foreignKey({
			columns: [table.requested_by],
			foreignColumns: [admin_users.id],
			name: "pack_creation_requests_requested_by_fkey"
		}).onUpdate("cascade").onDelete("restrict"),
	foreignKey({
			columns: [table.reviewed_by],
			foreignColumns: [admin_users.id],
			name: "pack_creation_requests_reviewed_by_fkey"
		}).onUpdate("cascade").onDelete("set null"),
	check("pack_creation_requests_payload_object_check", sql`jsonb_typeof(request_payload) = 'object'::text`),
	check("pack_creation_requests_status_check", sql`status = ANY (ARRAY['pending'::text, 'processing'::text, 'approved'::text, 'declined'::text])`),
]);

export const discord_notification_guilds = pgTable("discord_notification_guilds", {
	guild_id: text().primaryKey().notNull(),
	name: text().notNull(),
	connected: boolean().default(true).notNull(),
	last_synced_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).notNull(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	check("discord_notification_guilds_id_check", sql`guild_id ~ '^[0-9]{15,21}$'::text`),
]);

export const discord_notification_events = pgTable("discord_notification_events", {
	event_key: text().primaryKey().notNull(),
	label: text().notNull(),
	description: text().default('').notNull(),
	category: text().notNull(),
	is_custom: boolean().default(false).notNull(),
	enabled: boolean().default(true).notNull(),
	created_by: uuid(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.created_by],
			foreignColumns: [admin_users.id],
			name: "discord_notification_events_created_by_fkey"
		}).onDelete("set null"),
	check("discord_notification_events_key_check", sql`event_key ~ '^[a-z0-9][a-z0-9._-]{2,79}$'::text`),
]);

export const discord_notification_routes = pgTable("discord_notification_routes", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	guild_id: text().notNull(),
	event_key: text().notNull(),
	channel_id: text().notNull(),
	enabled: boolean().default(true).notNull(),
	created_by: uuid(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("discord_notification_routes_dispatch_idx").using("btree", table.guild_id.asc().nullsLast().op("text_ops"), table.event_key.asc().nullsLast().op("text_ops")).where(sql`enabled`),
	uniqueIndex("discord_notification_routes_unique").using("btree", table.guild_id.asc().nullsLast().op("text_ops"), table.event_key.asc().nullsLast().op("text_ops"), table.channel_id.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.guild_id, table.channel_id],
			foreignColumns: [discord_notification_channels.guild_id, discord_notification_channels.channel_id],
			name: "discord_notification_routes_channel_fk"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.created_by],
			foreignColumns: [admin_users.id],
			name: "discord_notification_routes_created_by_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.event_key],
			foreignColumns: [discord_notification_events.event_key],
			name: "discord_notification_routes_event_key_fkey"
		}).onDelete("cascade"),
]);

export const discord_creator_setups = pgTable("discord_creator_setups", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	guild_id: text().notNull(),
	creator_discord_user_id: text().notNull(),
	created_by_discord_user_id: text().notNull(),
	interaction_id: text().notNull(),
	status: text().default('pending').notNull(),
	category_id: text(),
	chat_channel_id: text(),
	logs_channel_id: text(),
	category_name: text(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	completed_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	creator_user_id: text(),
	linked_by_discord_user_id: text(),
	link_interaction_id: text(),
	linked_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	deposit_notifications_enabled: boolean().default(true).notNull(),
	deposit_notifications_enabled_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow(),
	deposit_notifications_updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	signup_notifications_enabled: boolean().default(true).notNull(),
	signup_notifications_enabled_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow(),
	deleted_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	deleted_by_discord_user_id: text(),
	delete_interaction_id: text(),
}, (table) => [
	uniqueIndex("discord_creator_setups_delete_interaction_unique").using("btree", table.delete_interaction_id.asc().nullsLast().op("text_ops")).where(sql`(delete_interaction_id IS NOT NULL)`),
	index("discord_creator_setups_deposit_notifications_idx").using("btree", table.guild_id.asc().nullsLast().op("text_ops"), table.creator_user_id.asc().nullsLast().op("text_ops")).where(sql`((status = 'active'::text) AND (creator_user_id IS NOT NULL) AND (deposit_notifications_enabled = true))`),
	uniqueIndex("discord_creator_setups_guild_creator_user_unique").using("btree", table.guild_id.asc().nullsLast().op("text_ops"), table.creator_user_id.asc().nullsLast().op("text_ops")).where(sql`(creator_user_id IS NOT NULL)`),
	uniqueIndex("discord_creator_setups_live_creator_unique").using("btree", table.guild_id.asc().nullsLast().op("text_ops"), table.creator_discord_user_id.asc().nullsLast().op("text_ops")).where(sql`(status = ANY (ARRAY['pending'::text, 'active'::text]))`),
	uniqueIndex("discord_creator_setups_link_interaction_unique").using("btree", table.link_interaction_id.asc().nullsLast().op("text_ops")).where(sql`(link_interaction_id IS NOT NULL)`),
	index("discord_creator_setups_pending_created_idx").using("btree", table.created_at.asc().nullsLast().op("timestamptz_ops")).where(sql`(status = 'pending'::text)`),
	index("discord_creator_setups_signup_notifications_idx").using("btree", table.guild_id.asc().nullsLast().op("text_ops"), table.creator_user_id.asc().nullsLast().op("text_ops")).where(sql`((status = 'active'::text) AND (creator_user_id IS NOT NULL) AND (signup_notifications_enabled = true))`),
	unique("discord_creator_setups_interaction_id_key").on(table.interaction_id),
	check("discord_creator_setups_active_shape_check", sql`(status = 'pending'::text) OR ((category_id ~ '^[0-9]{15,21}$'::text) AND (chat_channel_id ~ '^[0-9]{15,21}$'::text) AND (logs_channel_id ~ '^[0-9]{15,21}$'::text) AND ((length(category_name) >= 1) AND (length(category_name) <= 100)) AND (completed_at IS NOT NULL))`),
	check("discord_creator_setups_actor_id_check", sql`created_by_discord_user_id ~ '^[0-9]{15,21}$'::text`),
	check("discord_creator_setups_creator_id_check", sql`creator_discord_user_id ~ '^[0-9]{15,21}$'::text`),
	check("discord_creator_setups_creator_user_id_check", sql`(creator_user_id IS NULL) OR (((length(creator_user_id) >= 8) AND (length(creator_user_id) <= 64)) AND (creator_user_id ~ '^[A-Za-z0-9_-]+$'::text))`),
	check("discord_creator_setups_deletion_shape_check", sql`((status <> 'deleted'::text) AND (deleted_at IS NULL) AND (deleted_by_discord_user_id IS NULL) AND (delete_interaction_id IS NULL)) OR ((status = 'deleted'::text) AND (deleted_at IS NOT NULL) AND (deleted_by_discord_user_id ~ '^[0-9]{15,21}$'::text) AND (delete_interaction_id ~ '^[0-9]{15,21}$'::text) AND (creator_user_id IS NULL) AND (linked_by_discord_user_id IS NULL) AND (link_interaction_id IS NULL) AND (linked_at IS NULL))`),
	check("discord_creator_setups_guild_id_check", sql`guild_id ~ '^[0-9]{15,21}$'::text`),
	check("discord_creator_setups_interaction_id_check", sql`interaction_id ~ '^[0-9]{15,21}$'::text`),
	check("discord_creator_setups_link_actor_id_check", sql`(linked_by_discord_user_id IS NULL) OR (linked_by_discord_user_id ~ '^[0-9]{15,21}$'::text)`),
	check("discord_creator_setups_link_interaction_id_check", sql`(link_interaction_id IS NULL) OR (link_interaction_id ~ '^[0-9]{15,21}$'::text)`),
	check("discord_creator_setups_link_shape_check", sql`((creator_user_id IS NULL) AND (linked_by_discord_user_id IS NULL) AND (link_interaction_id IS NULL) AND (linked_at IS NULL)) OR ((status = 'active'::text) AND (creator_user_id IS NOT NULL) AND (linked_by_discord_user_id IS NOT NULL) AND (link_interaction_id IS NOT NULL) AND (linked_at IS NOT NULL))`),
	check("discord_creator_setups_status_check", sql`status = ANY (ARRAY['pending'::text, 'active'::text, 'deleted'::text])`),
]);

export const admin_whop_refund_batches = pgTable("admin_whop_refund_batches", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	requested_by: uuid(),
	selection_mode: text().notNull(),
	reason: text().notNull(),
	status: text().default('pending').notNull(),
	requested_count: integer().default(0).notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	completed_at: timestamp({ withTimezone: true, mode: 'string' }),
}, (table) => [
	index("admin_whop_refund_batches_requested_created_idx").using("btree", table.requested_by.asc().nullsLast().op("uuid_ops"), table.created_at.desc().nullsFirst().op("timestamptz_ops")),
	index("admin_whop_refund_batches_status_updated_idx").using("btree", table.status.asc().nullsLast().op("timestamptz_ops"), table.updated_at.desc().nullsFirst().op("text_ops")),
	foreignKey({
			columns: [table.requested_by],
			foreignColumns: [admin_users.id],
			name: "admin_whop_refund_batches_requested_by_fkey"
		}).onDelete("set null"),
	check("admin_whop_refund_batches_requested_count_check", sql`requested_count >= 0`),
	check("admin_whop_refund_batches_selection_mode_check", sql`selection_mode = ANY (ARRAY['payments'::text, 'users'::text, 'all'::text])`),
	check("admin_whop_refund_batches_status_check", sql`status = ANY (ARRAY['pending'::text, 'processing'::text, 'completed'::text, 'completed_with_issues'::text])`),
]);

export const admin_whop_refund_items = pgTable("admin_whop_refund_items", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	batch_id: uuid().notNull(),
	user_id: text().notNull(),
	deposit_intent_id: uuid().notNull(),
	provider_payment_id: text().notNull(),
	currency: text().notNull(),
	original_amount_cents: integer().notNull(),
	status: text().default('pending').notNull(),
	attempt_count: integer().default(0).notNull(),
	lease_token: uuid(),
	leased_until: timestamp({ withTimezone: true, mode: 'string' }),
	provider_status: text(),
	provider_substatus: text(),
	refunded_amount: numeric({ precision: 20, scale:  2 }),
	error_code: text(),
	error_message: text(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	completed_at: timestamp({ withTimezone: true, mode: 'string' }),
}, (table) => [
	index("admin_whop_refund_items_batch_status_idx").using("btree", table.batch_id.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops"), table.created_at.asc().nullsLast().op("text_ops")),
	index("admin_whop_refund_items_user_created_idx").using("btree", table.user_id.asc().nullsLast().op("timestamptz_ops"), table.created_at.desc().nullsFirst().op("timestamptz_ops")),
	foreignKey({
			columns: [table.batch_id],
			foreignColumns: [admin_whop_refund_batches.id],
			name: "admin_whop_refund_items_batch_id_fkey"
		}).onDelete("restrict"),
	unique("admin_whop_refund_items_payment_unique").on(table.provider_payment_id),
	check("admin_whop_refund_items_amount_check", sql`original_amount_cents > 0`),
	check("admin_whop_refund_items_attempt_count_check", sql`attempt_count >= 0`),
	check("admin_whop_refund_items_status_check", sql`status = ANY (ARRAY['pending'::text, 'processing'::text, 'succeeded'::text, 'already_refunded'::text, 'not_refundable'::text, 'failed'::text, 'unknown'::text])`),
]);

export const discord_notification_channel_settings = pgTable("discord_notification_channel_settings", {
	guild_id: text().primaryKey().notNull(),
	default_parent_id: text(),
	updated_by: uuid(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.guild_id],
			foreignColumns: [discord_notification_guilds.guild_id],
			name: "discord_notification_channel_settings_guild_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.guild_id, table.default_parent_id],
			foreignColumns: [discord_notification_channels.guild_id, discord_notification_channels.channel_id],
			name: "discord_notification_channel_settings_parent_fk"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.updated_by],
			foreignColumns: [admin_users.id],
			name: "discord_notification_channel_settings_updated_by_fkey"
		}).onDelete("set null"),
]);

export const discord_vip_channel_links = pgTable("discord_vip_channel_links", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	guild_id: text().notNull(),
	user_id: text().notNull(),
	channel_id: text().notNull(),
	linked_by_discord_user_id: text().notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	member_discord_user_id: text(),
}, (table) => [
	uniqueIndex("discord_vip_channel_links_guild_member_unique").using("btree", table.guild_id.asc().nullsLast().op("text_ops"), table.member_discord_user_id.asc().nullsLast().op("text_ops")).where(sql`(member_discord_user_id IS NOT NULL)`),
	index("discord_vip_channel_links_updated_idx").using("btree", table.guild_id.asc().nullsLast().op("timestamptz_ops"), table.updated_at.desc().nullsFirst().op("text_ops")),
	unique("discord_vip_channel_links_guild_channel_unique").on(table.channel_id, table.guild_id),
	unique("discord_vip_channel_links_guild_user_unique").on(table.guild_id, table.user_id),
	check("discord_vip_channel_links_actor_id_check", sql`linked_by_discord_user_id ~ '^[0-9]{17,20}$'::text`),
	check("discord_vip_channel_links_channel_id_check", sql`channel_id ~ '^[0-9]{17,20}$'::text`),
	check("discord_vip_channel_links_guild_id_check", sql`guild_id ~ '^[0-9]{17,20}$'::text`),
	check("discord_vip_channel_links_member_id_check", sql`(member_discord_user_id IS NULL) OR (member_discord_user_id ~ '^[0-9]{17,20}$'::text)`),
	check("discord_vip_channel_links_user_id_check", sql`((length(user_id) >= 8) AND (length(user_id) <= 64)) AND (user_id ~ '^[A-Za-z0-9_-]+$'::text)`),
]);

export const discord_notification_channel_jobs = pgTable("discord_notification_channel_jobs", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	guild_id: text().notNull(),
	parent_id: text().notNull(),
	requested_name: text().notNull(),
	status: text().default('pending').notNull(),
	available_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	attempt_count: integer().default(0).notNull(),
	max_attempts: integer().default(5).notNull(),
	lease_token: uuid(),
	lease_owner: text(),
	leased_until: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	created_channel_id: text(),
	created_channel_name: text(),
	last_error_code: text(),
	last_error_message: text(),
	created_by: uuid(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	completed_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
}, (table) => [
	index("discord_notification_channel_jobs_claim_idx").using("btree", table.guild_id.asc().nullsLast().op("text_ops"), table.available_at.asc().nullsLast().op("text_ops"), table.created_at.asc().nullsLast().op("timestamptz_ops")).where(sql`(status = ANY (ARRAY['pending'::text, 'leased'::text]))`),
	index("discord_notification_channel_jobs_history_idx").using("btree", table.guild_id.asc().nullsLast().op("timestamptz_ops"), table.created_at.desc().nullsFirst().op("text_ops")),
	foreignKey({
			columns: [table.created_by],
			foreignColumns: [admin_users.id],
			name: "discord_notification_channel_jobs_created_by_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.guild_id, table.parent_id],
			foreignColumns: [discord_notification_channels.guild_id, discord_notification_channels.channel_id],
			name: "discord_notification_channel_jobs_parent_fk"
		}).onDelete("restrict"),
	check("discord_notification_channel_jobs_attempt_check", sql`(attempt_count >= 0) AND ((max_attempts >= 1) AND (max_attempts <= 25))`),
	check("discord_notification_channel_jobs_created_id_check", sql`(created_channel_id IS NULL) OR (created_channel_id ~ '^[0-9]{15,21}$'::text)`),
	check("discord_notification_channel_jobs_name_check", sql`((char_length(requested_name) >= 1) AND (char_length(requested_name) <= 100)) AND (requested_name ~ '^[a-z0-9][a-z0-9-]*$'::text)`),
	check("discord_notification_channel_jobs_status_check", sql`status = ANY (ARRAY['pending'::text, 'leased'::text, 'created'::text, 'dead'::text])`),
]);

export const discord_creator_deposit_scan_state = pgTable("discord_creator_deposit_scan_state", {
	singleton_id: smallint().default(1).primaryKey().notNull(),
	scan_through_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lease_token: uuid(),
	lease_owner: text(),
	leased_until: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	check("discord_creator_deposit_scan_lease_shape_check", sql`((lease_token IS NULL) AND (lease_owner IS NULL) AND (leased_until IS NULL)) OR ((lease_token IS NOT NULL) AND (lease_owner IS NOT NULL) AND (leased_until IS NOT NULL))`),
	check("discord_creator_deposit_scan_singleton_check", sql`singleton_id = 1`),
]);

export const discord_creator_deposit_jobs = pgTable("discord_creator_deposit_jobs", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	setup_id: uuid().notNull(),
	source_deposit_id: uuid().notNull(),
	creator_user_id: text().notNull(),
	depositor_user_id: text().notNull(),
	depositor_username: text(),
	deposit_amount_usd: numeric({ precision: 20, scale:  2 }).notNull(),
	creator_total_deposits_usd: numeric({ precision: 20, scale:  2 }).notNull(),
	creator_30d_deposits_usd: numeric({ precision: 20, scale:  2 }).notNull(),
	occurred_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).notNull(),
	status: text().default('pending').notNull(),
	attempt_count: integer().default(0).notNull(),
	max_attempts: integer().default(8).notNull(),
	available_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lease_token: uuid(),
	lease_owner: text(),
	leased_until: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	discord_message_id: text(),
	last_error_code: text(),
	last_error_message: text(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	delivered_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
}, (table) => [
	index("discord_creator_deposit_jobs_claim_idx").using("btree", table.available_at.asc().nullsLast().op("timestamptz_ops"), table.created_at.asc().nullsLast().op("uuid_ops"), table.id.asc().nullsLast().op("uuid_ops")).where(sql`(status = ANY (ARRAY['pending'::text, 'leased'::text]))`),
	index("discord_creator_deposit_jobs_setup_history_idx").using("btree", table.setup_id.asc().nullsLast().op("uuid_ops"), table.created_at.desc().nullsFirst().op("timestamptz_ops")),
	foreignKey({
			columns: [table.setup_id],
			foreignColumns: [discord_creator_setups.id],
			name: "discord_creator_deposit_jobs_setup_id_fkey"
		}).onDelete("cascade"),
	unique("discord_creator_deposit_jobs_source_unique").on(table.source_deposit_id),
	check("discord_creator_deposit_jobs_amount_check", sql`(deposit_amount_usd > (0)::numeric) AND (creator_total_deposits_usd >= (0)::numeric) AND (creator_30d_deposits_usd >= (0)::numeric)`),
	check("discord_creator_deposit_jobs_attempt_check", sql`(attempt_count >= 0) AND ((max_attempts >= 1) AND (max_attempts <= 25))`),
	check("discord_creator_deposit_jobs_status_check", sql`status = ANY (ARRAY['pending'::text, 'leased'::text, 'delivered'::text, 'dead'::text])`),
]);

export const antifraud_security_audit_events = pgTable("antifraud_security_audit_events", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	correlation_id: uuid().notNull(),
	actor_admin_user_id: uuid(),
	actor_username: text(),
	actor_roles: text().array().default(sql`'{}'::text[]`).notNull(),
	session_hash: text(),
	model_version: text().default('security-boundary-v1').notNull(),
	event_kind: text().notNull(),
	action: text().notNull(),
	outcome: text().notNull(),
	target_type: text(),
	target_id: text(),
	reason_code: text(),
	request_path: text(),
	request_method: text(),
	ip_hash: text(),
	user_agent_hash: text(),
	idempotency_key_hash: text(),
	metadata: jsonb().default({}).notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("antifraud_security_audit_action_time_idx").using("btree", table.action.asc().nullsLast().op("text_ops"), table.created_at.desc().nullsFirst().op("timestamptz_ops")),
	index("antifraud_security_audit_actor_time_idx").using("btree", table.actor_admin_user_id.asc().nullsLast().op("timestamptz_ops"), table.created_at.desc().nullsFirst().op("uuid_ops")),
	index("antifraud_security_audit_correlation_idx").using("btree", table.correlation_id.asc().nullsLast().op("timestamptz_ops"), table.created_at.asc().nullsLast().op("uuid_ops")),
	index("antifraud_security_audit_created_id_idx").using("btree", table.created_at.desc().nullsFirst().op("uuid_ops"), table.id.desc().nullsFirst().op("timestamptz_ops")),
	uniqueIndex("antifraud_security_audit_outcome_idempotency_idx").using("btree", table.action.asc().nullsLast().op("text_ops"), table.outcome.asc().nullsLast().op("text_ops"), table.idempotency_key_hash.asc().nullsLast().op("text_ops")).where(sql`((idempotency_key_hash IS NOT NULL) AND (outcome = ANY (ARRAY['succeeded'::text, 'failed'::text])))`),
	foreignKey({
			columns: [table.actor_admin_user_id],
			foreignColumns: [admin_users.id],
			name: "antifraud_security_audit_events_actor_admin_user_id_fkey"
		}).onDelete("set null"),
	check("antifraud_security_audit_events_action_check", sql`(length(action) >= 1) AND (length(action) <= 160)`),
	check("antifraud_security_audit_events_event_kind_check", sql`event_kind = ANY (ARRAY['view'::text, 'search'::text, 'export'::text, 'action'::text])`),
	check("antifraud_security_audit_events_outcome_check", sql`outcome = ANY (ARRAY['allowed'::text, 'denied'::text, 'succeeded'::text, 'failed'::text, 'rate_limited'::text])`),
	check("antifraud_security_audit_events_reason_code_check", sql`(reason_code IS NULL) OR (length(reason_code) <= 100)`),
	check("antifraud_security_audit_events_request_method_check", sql`(request_method IS NULL) OR (length(request_method) <= 12)`),
	check("antifraud_security_audit_events_request_path_check", sql`(request_path IS NULL) OR (length(request_path) <= 500)`),
	check("antifraud_security_audit_events_target_id_check", sql`(target_id IS NULL) OR (length(target_id) <= 200)`),
	check("antifraud_security_audit_events_target_type_check", sql`(target_type IS NULL) OR (length(target_type) <= 80)`),
]);

export const antifraud_review_reminder_state = pgTable("antifraud_review_reminder_state", {
	review_id: uuid().primaryKey().notNull(),
	reminder_kind: text().notNull(),
	next_reminder_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).notNull(),
	last_sent_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	sent_count: integer().default(0).notNull(),
	lease_token: uuid(),
	leased_until: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("antifraud_review_reminder_due_idx").using("btree", table.next_reminder_at.asc().nullsLast().op("timestamptz_ops"), table.review_id.asc().nullsLast().op("timestamptz_ops")),
	foreignKey({
			columns: [table.review_id],
			foreignColumns: [antifraud_reviews.id],
			name: "antifraud_review_reminder_state_review_id_fkey"
		}).onDelete("cascade"),
	check("antifraud_review_reminder_kind_check", sql`reminder_kind = ANY (ARRAY['normal'::text, 'urgent'::text, 'postponed'::text])`),
	check("antifraud_review_reminder_sent_count_check", sql`sent_count >= 0`),
]);

export const antifraud_review_workflow = pgTable("antifraud_review_workflow", {
	review_id: uuid().primaryKey().notNull(),
	queue_state: text().default('normal').notNull(),
	evidence: jsonb().default({}).notNull(),
	postponed_until: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	postponed_by: uuid(),
	state_updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("antifraud_review_workflow_postponed_idx").using("btree", table.postponed_until.asc().nullsLast().op("timestamptz_ops"), table.review_id.asc().nullsLast().op("timestamptz_ops")).where(sql`(postponed_until IS NOT NULL)`),
	index("antifraud_review_workflow_queue_idx").using("btree", table.queue_state.asc().nullsLast().op("text_ops"), table.review_id.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.postponed_by],
			foreignColumns: [admin_users.id],
			name: "antifraud_review_workflow_postponed_by_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.review_id],
			foreignColumns: [antifraud_reviews.id],
			name: "antifraud_review_workflow_review_id_fkey"
		}).onDelete("cascade"),
	check("antifraud_review_workflow_state_check", sql`queue_state = ANY (ARRAY['priority'::text, 'normal'::text, 'waiting_kyc'::text])`),
]);

export const discord_vip_channel_link_operations = pgTable("discord_vip_channel_link_operations", {
	interaction_id: text().primaryKey().notNull(),
	guild_id: text().notNull(),
	user_id: text().notNull(),
	channel_id: text().notNull(),
	actor_discord_user_id: text().notNull(),
	status: text().notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	member_discord_user_id: text(),
	vip_tag_added: boolean().default(false).notNull(),
}, (table) => [
	index("discord_vip_channel_link_operations_created_idx").using("btree", table.created_at.desc().nullsFirst().op("timestamptz_ops")),
	check("discord_vip_channel_link_operations_actor_id_check", sql`actor_discord_user_id ~ '^[0-9]{17,20}$'::text`),
	check("discord_vip_channel_link_operations_channel_id_check", sql`channel_id ~ '^[0-9]{17,20}$'::text`),
	check("discord_vip_channel_link_operations_guild_id_check", sql`guild_id ~ '^[0-9]{17,20}$'::text`),
	check("discord_vip_channel_link_operations_interaction_id_check", sql`interaction_id ~ '^[0-9]{17,20}$'::text`),
	check("discord_vip_channel_link_operations_member_id_check", sql`(member_discord_user_id IS NULL) OR (member_discord_user_id ~ '^[0-9]{17,20}$'::text)`),
	check("discord_vip_channel_link_operations_status_check", sql`status = ANY (ARRAY['linked'::text, 'updated'::text, 'already_linked'::text])`),
	check("discord_vip_channel_link_operations_user_id_check", sql`((length(user_id) >= 8) AND (length(user_id) <= 64)) AND (user_id ~ '^[A-Za-z0-9_-]+$'::text)`),
]);

export const pack_build_draft_revisions = pgTable("pack_build_draft_revisions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	request_id: uuid().notNull(),
	revision: integer().notNull(),
	changed_by: uuid(),
	change_kind: text().default('saved').notNull(),
	name: text().notNull(),
	slug: text().notNull(),
	request_payload: jsonb().notNull(),
	preview_edge: numeric({ precision: 8, scale:  6 }).notNull(),
	preview_win_rate: numeric({ precision: 8, scale:  6 }).notNull(),
	preview_max_win: numeric({ precision: 14, scale:  2 }),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("pack_build_draft_revisions_request_created_idx").using("btree", table.request_id.asc().nullsLast().op("uuid_ops"), table.created_at.desc().nullsFirst().op("uuid_ops")),
	foreignKey({
			columns: [table.changed_by],
			foreignColumns: [admin_users.id],
			name: "pack_build_draft_revisions_changed_by_fkey"
		}).onUpdate("cascade").onDelete("set null"),
	foreignKey({
			columns: [table.request_id],
			foreignColumns: [pack_creation_requests.id],
			name: "pack_build_draft_revisions_request_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	unique("pack_build_draft_revisions_request_revision_key").on(table.request_id, table.revision),
	check("pack_build_draft_revisions_payload_object_check", sql`jsonb_typeof(request_payload) = 'object'::text`),
]);

export const discord_reminder_jobs = pgTable("discord_reminder_jobs", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	interaction_id: text().notNull(),
	guild_id: text().notNull(),
	source_channel_id: text().notNull(),
	target_channel_id: text().notNull(),
	user_id: text().notNull(),
	due_at: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
	available_at: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
	status: text().default('pending').notNull(),
	attempt_count: integer().default(0).notNull(),
	max_attempts: integer().default(10).notNull(),
	lease_token: uuid(),
	lease_owner: text(),
	leased_until: timestamp({ withTimezone: true, mode: 'string' }),
	discord_message_id: text(),
	last_error_code: text(),
	last_error_message: text(),
	delivered_at: timestamp({ withTimezone: true, mode: 'string' }),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("discord_reminder_jobs_claim_idx").using("btree", table.available_at.asc().nullsLast().op("uuid_ops"), table.created_at.asc().nullsLast().op("uuid_ops"), table.id.asc().nullsLast().op("uuid_ops")).where(sql`(status = ANY (ARRAY['pending'::text, 'leased'::text]))`),
	index("discord_reminder_jobs_history_idx").using("btree", table.guild_id.asc().nullsLast().op("timestamptz_ops"), table.created_at.desc().nullsFirst().op("text_ops")),
	unique("discord_reminder_jobs_interaction_unique").on(table.interaction_id),
	check("discord_reminder_jobs_attempt_check", sql`(attempt_count >= 0) AND ((max_attempts >= 1) AND (max_attempts <= 25))`),
	check("discord_reminder_jobs_guild_check", sql`guild_id ~ '^[0-9]{17,20}$'::text`),
	check("discord_reminder_jobs_interaction_check", sql`interaction_id ~ '^[0-9]{17,20}$'::text`),
	check("discord_reminder_jobs_source_channel_check", sql`source_channel_id ~ '^[0-9]{17,20}$'::text`),
	check("discord_reminder_jobs_status_check", sql`status = ANY (ARRAY['pending'::text, 'leased'::text, 'delivered'::text, 'dead'::text])`),
	check("discord_reminder_jobs_target_channel_check", sql`target_channel_id ~ '^[0-9]{17,20}$'::text`),
	check("discord_reminder_jobs_user_check", sql`user_id ~ '^[0-9]{17,20}$'::text`),
]);

export const discord_creator_signup_scan_state = pgTable("discord_creator_signup_scan_state", {
	singleton_id: smallint().default(1).primaryKey().notNull(),
	scan_through_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lease_token: uuid(),
	lease_owner: text(),
	leased_until: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	check("discord_creator_signup_scan_lease_shape_check", sql`((lease_token IS NULL) AND (lease_owner IS NULL) AND (leased_until IS NULL)) OR ((lease_token IS NOT NULL) AND (lease_owner IS NOT NULL) AND (leased_until IS NOT NULL))`),
	check("discord_creator_signup_scan_singleton_check", sql`singleton_id = 1`),
]);

export const discord_creator_signup_jobs = pgTable("discord_creator_signup_jobs", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	setup_id: uuid().notNull(),
	source_signup_id: uuid().notNull(),
	creator_user_id: text().notNull(),
	referred_user_id: text().notNull(),
	referred_username: text(),
	affiliate_code: text().notNull(),
	occurred_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).notNull(),
	status: text().default('pending').notNull(),
	attempt_count: integer().default(0).notNull(),
	max_attempts: integer().default(8).notNull(),
	available_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lease_token: uuid(),
	lease_owner: text(),
	leased_until: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	discord_message_id: text(),
	last_error_code: text(),
	last_error_message: text(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	delivered_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
}, (table) => [
	index("discord_creator_signup_jobs_claim_idx").using("btree", table.available_at.asc().nullsLast().op("timestamptz_ops"), table.created_at.asc().nullsLast().op("uuid_ops"), table.id.asc().nullsLast().op("uuid_ops")).where(sql`(status = ANY (ARRAY['pending'::text, 'leased'::text]))`),
	index("discord_creator_signup_jobs_setup_history_idx").using("btree", table.setup_id.asc().nullsLast().op("uuid_ops"), table.created_at.desc().nullsFirst().op("timestamptz_ops")),
	foreignKey({
			columns: [table.setup_id],
			foreignColumns: [discord_creator_setups.id],
			name: "discord_creator_signup_jobs_setup_id_fkey"
		}).onDelete("cascade"),
	unique("discord_creator_signup_jobs_source_unique").on(table.source_signup_id),
	check("discord_creator_signup_jobs_attempt_check", sql`(attempt_count >= 0) AND ((max_attempts >= 1) AND (max_attempts <= 25))`),
	check("discord_creator_signup_jobs_status_check", sql`status = ANY (ARRAY['pending'::text, 'leased'::text, 'delivered'::text, 'dead'::text])`),
]);

export const discord_message_snapshots = pgTable("discord_message_snapshots", {
	message_id: text().primaryKey().notNull(),
	guild_id: text().notNull(),
	channel_id: text().notNull(),
	author_id: text(),
	author_username: text(),
	author_display_name: text(),
	author_is_bot: boolean(),
	webhook_id: text(),
	content: text(),
	attachments: jsonb().default([]).notNull(),
	referenced_message_id: text(),
	discord_created_at: timestamp({ withTimezone: true, mode: 'string' }),
	discord_edited_at: timestamp({ withTimezone: true, mode: 'string' }),
	deleted_at: timestamp({ withTimezone: true, mode: 'string' }),
	first_observed_at: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
	last_observed_at: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	excluded_from_logging: boolean().default(false).notNull(),
}, (table) => [
	index("discord_message_snapshots_author_observed_idx").using("btree", table.author_id.asc().nullsLast().op("text_ops"), table.last_observed_at.desc().nullsFirst().op("timestamptz_ops")).where(sql`(author_id IS NOT NULL)`),
	index("discord_message_snapshots_channel_observed_idx").using("btree", table.guild_id.asc().nullsLast().op("timestamptz_ops"), table.channel_id.asc().nullsLast().op("text_ops"), table.last_observed_at.desc().nullsFirst().op("timestamptz_ops")),
	index("discord_message_snapshots_guild_observed_idx").using("btree", table.guild_id.asc().nullsLast().op("text_ops"), table.last_observed_at.desc().nullsFirst().op("timestamptz_ops")),
	check("discord_message_snapshots_attachments_array_check", sql`jsonb_typeof(attachments) = 'array'::text`),
	check("discord_message_snapshots_author_id_check", sql`(author_id IS NULL) OR (author_id ~ '^[0-9]{17,20}$'::text)`),
	check("discord_message_snapshots_channel_id_check", sql`channel_id ~ '^[0-9]{17,20}$'::text`),
	check("discord_message_snapshots_content_length_check", sql`(content IS NULL) OR (char_length(content) <= 4000)`),
	check("discord_message_snapshots_display_name_length_check", sql`(author_display_name IS NULL) OR (char_length(author_display_name) <= 100)`),
	check("discord_message_snapshots_guild_id_check", sql`guild_id ~ '^[0-9]{17,20}$'::text`),
	check("discord_message_snapshots_message_id_check", sql`message_id ~ '^[0-9]{17,20}$'::text`),
	check("discord_message_snapshots_reference_id_check", sql`(referenced_message_id IS NULL) OR (referenced_message_id ~ '^[0-9]{17,20}$'::text)`),
	check("discord_message_snapshots_username_length_check", sql`(author_username IS NULL) OR (char_length(author_username) <= 100)`),
	check("discord_message_snapshots_webhook_id_check", sql`(webhook_id IS NULL) OR (webhook_id ~ '^[0-9]{17,20}$'::text)`),
]);

export const discord_message_events = pgTable("discord_message_events", {
	event_id: uuid().primaryKey().notNull(),
	event_type: text().notNull(),
	message_id: text().notNull(),
	guild_id: text().notNull(),
	channel_id: text().notNull(),
	author_id: text(),
	author_username: text(),
	author_display_name: text(),
	before_state: jsonb().notNull(),
	after_state: jsonb(),
	discord_created_at: timestamp({ withTimezone: true, mode: 'string' }),
	observed_at: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("discord_message_events_author_observed_idx").using("btree", table.author_id.asc().nullsLast().op("timestamptz_ops"), table.observed_at.desc().nullsFirst().op("timestamptz_ops")).where(sql`(author_id IS NOT NULL)`),
	index("discord_message_events_guild_observed_idx").using("btree", table.guild_id.asc().nullsLast().op("text_ops"), table.observed_at.desc().nullsFirst().op("timestamptz_ops")),
	index("discord_message_events_message_observed_idx").using("btree", table.message_id.asc().nullsLast().op("timestamptz_ops"), table.observed_at.asc().nullsLast().op("timestamptz_ops")),
	check("discord_message_events_after_object_check", sql`(after_state IS NULL) OR (jsonb_typeof(after_state) = 'object'::text)`),
	check("discord_message_events_author_id_check", sql`(author_id IS NULL) OR (author_id ~ '^[0-9]{17,20}$'::text)`),
	check("discord_message_events_before_object_check", sql`jsonb_typeof(before_state) = 'object'::text`),
	check("discord_message_events_channel_id_check", sql`channel_id ~ '^[0-9]{17,20}$'::text`),
	check("discord_message_events_guild_id_check", sql`guild_id ~ '^[0-9]{17,20}$'::text`),
	check("discord_message_events_message_id_check", sql`message_id ~ '^[0-9]{17,20}$'::text`),
	check("discord_message_events_type_check", sql`event_type = ANY (ARRAY['create'::text, 'update'::text, 'delete'::text])`),
]);

export const admin_fiat_credit_reviews = pgTable("admin_fiat_credit_reviews", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	deposit_intent_id: uuid().notNull(),
	user_id: text().notNull(),
	provider: text().default('whop').notNull(),
	provider_payment_id: text().notNull(),
	currency: text().notNull(),
	amount_cents: integer().notNull(),
	customer_total_cents: integer(),
	status: text().default('active').notNull(),
	staff_decision: text(),
	decision_reason: text(),
	decided_by: uuid(),
	decision_idempotency_key: uuid(),
	decided_at: timestamp({ withTimezone: true, mode: 'string' }),
	containment_error: text(),
	contained_at: timestamp({ withTimezone: true, mode: 'string' }),
	resolution_action: text(),
	resolution_reason: text(),
	resolution_idempotency_key: uuid(),
	resolution_requested_by: uuid(),
	resolution_requested_at: timestamp({ withTimezone: true, mode: 'string' }),
	refund_status: text().default('not_requested').notNull(),
	provider_status: text(),
	provider_substatus: text(),
	refunded_amount: numeric({ precision: 20, scale:  2 }),
	refund_error_code: text(),
	refund_error_message: text(),
	refund_completed_at: timestamp({ withTimezone: true, mode: 'string' }),
	ban_status: text().default('not_requested').notNull(),
	ban_error_message: text(),
	ban_completed_at: timestamp({ withTimezone: true, mode: 'string' }),
	attempt_count: integer().default(0).notNull(),
	version: integer().default(0).notNull(),
	resolved_by: uuid(),
	resolved_at: timestamp({ withTimezone: true, mode: 'string' }),
	last_error: text(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("admin_fiat_credit_reviews_declined_idx").using("btree", table.decided_at.desc().nullsFirst().op("uuid_ops"), table.id.desc().nullsFirst().op("uuid_ops")).where(sql`(staff_decision = 'decline'::text)`),
	index("admin_fiat_credit_reviews_status_created_idx").using("btree", table.status.asc().nullsLast().op("uuid_ops"), table.created_at.desc().nullsFirst().op("uuid_ops"), table.id.desc().nullsFirst().op("uuid_ops")),
	index("admin_fiat_credit_reviews_user_created_idx").using("btree", table.user_id.asc().nullsLast().op("timestamptz_ops"), table.created_at.desc().nullsFirst().op("timestamptz_ops")),
	foreignKey({
			columns: [table.decided_by],
			foreignColumns: [admin_users.id],
			name: "admin_fiat_credit_reviews_decided_by_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.resolution_requested_by],
			foreignColumns: [admin_users.id],
			name: "admin_fiat_credit_reviews_resolution_requested_by_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.resolved_by],
			foreignColumns: [admin_users.id],
			name: "admin_fiat_credit_reviews_resolved_by_fkey"
		}).onDelete("set null"),
	unique("admin_fiat_credit_reviews_decision_idempotency_key_key").on(table.decision_idempotency_key),
	unique("admin_fiat_credit_reviews_deposit_intent_id_key").on(table.deposit_intent_id),
	unique("admin_fiat_credit_reviews_provider_payment_id_key").on(table.provider_payment_id),
	unique("admin_fiat_credit_reviews_resolution_idempotency_key_key").on(table.resolution_idempotency_key),
	check("admin_fiat_credit_reviews_amount_check", sql`(amount_cents > 0) AND ((customer_total_cents IS NULL) OR (customer_total_cents > 0))`),
	check("admin_fiat_credit_reviews_attempt_count_check", sql`attempt_count >= 0`),
	check("admin_fiat_credit_reviews_ban_status_check", sql`ban_status = ANY (ARRAY['not_requested'::text, 'processing'::text, 'succeeded'::text, 'already_banned'::text, 'failed'::text])`),
	check("admin_fiat_credit_reviews_decision_reason_check", sql`(decision_reason IS NULL) OR ((char_length(decision_reason) >= 3) AND (char_length(decision_reason) <= 500))`),
	check("admin_fiat_credit_reviews_provider_check", sql`provider = 'whop'::text`),
	check("admin_fiat_credit_reviews_refund_status_check", sql`refund_status = ANY (ARRAY['not_requested'::text, 'processing'::text, 'succeeded'::text, 'already_refunded'::text, 'not_refundable'::text, 'failed'::text, 'unknown'::text])`),
	check("admin_fiat_credit_reviews_resolution_action_check", sql`(resolution_action IS NULL) OR (resolution_action = ANY (ARRAY['refund'::text, 'ban'::text, 'refund_and_ban'::text]))`),
	check("admin_fiat_credit_reviews_resolution_reason_check", sql`(resolution_reason IS NULL) OR ((char_length(resolution_reason) >= 3) AND (char_length(resolution_reason) <= 500))`),
	check("admin_fiat_credit_reviews_staff_decision_check", sql`(staff_decision IS NULL) OR (staff_decision = ANY (ARRAY['approve'::text, 'decline'::text]))`),
	check("admin_fiat_credit_reviews_status_check", sql`status = ANY (ARRAY['active'::text, 'approving'::text, 'approval_failed'::text, 'approved'::text, 'containing'::text, 'containment_failed'::text, 'declined'::text, 'resolving'::text, 'resolution_failed'::text, 'resolved'::text])`),
	check("admin_fiat_credit_reviews_version_check", sql`version >= 0`),
]);

export const antifraud_signals = pgTable("antifraud_signals", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	external_id: text(),
	kind: text().notNull(),
	severity: text().default('medium').notNull(),
	risk_score: integer(),
	target_user_id: text(),
	target_username: text(),
	summary: text().notNull(),
	payload: jsonb(),
	review_id: uuid(),
	received_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	containment_outbox_status: text(),
	containment_outbox_error: text(),
	containment_outbox_attempts: integer().default(0).notNull(),
	containment_applied_at: timestamp({ withTimezone: true, mode: 'string' }),
}, (table) => [
	index("antifraud_signals_containment_outbox_pending_idx").using("btree", table.received_at.asc().nullsLast().op("timestamptz_ops")).where(sql`(containment_outbox_status = ANY (ARRAY['pending'::text, 'failed'::text]))`),
	uniqueIndex("antifraud_signals_external_uniq").using("btree", table.external_id.asc().nullsLast().op("text_ops")).where(sql`(external_id IS NOT NULL)`),
	index("antifraud_signals_received_idx").using("btree", table.received_at.desc().nullsFirst().op("timestamptz_ops")),
	index("antifraud_signals_target_idx").using("btree", table.target_user_id.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.review_id],
			foreignColumns: [antifraud_reviews.id],
			name: "antifraud_signals_review_id_fkey"
		}).onDelete("set null"),
	check("antifraud_signals_containment_outbox_attempts_check", sql`containment_outbox_attempts >= 0`),
	check("antifraud_signals_containment_outbox_status_check", sql`(containment_outbox_status IS NULL) OR (containment_outbox_status = ANY (ARRAY['pending'::text, 'applied'::text, 'skipped'::text, 'failed'::text]))`),
]);

export const admin_audit_write_failures = pgTable("admin_audit_write_failures", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	admin_user_id: uuid(),
	event_type: text().notNull(),
	target_user_id: text(),
	ip: text(),
	metadata: jsonb(),
	error_message: text(),
	attempt_count: integer().default(0).notNull(),
	resolved_at: timestamp({ withTimezone: true, mode: 'string' }),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("admin_audit_write_failures_unresolved_idx").using("btree", table.created_at.desc().nullsFirst().op("timestamptz_ops")).where(sql`(resolved_at IS NULL)`),
	check("admin_audit_write_failures_attempt_count_check", sql`attempt_count >= 0`),
]);

export const creator_agreement_documents = pgTable("creator_agreement_documents", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	version: integer().notNull(),
	checksum: text().notNull(),
	created_by: uuid(),
	published_by: uuid(),
	published_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("creator_agreement_documents_published_idx").using("btree", table.published_at.desc().nullsFirst().op("int4_ops"), table.version.desc().nullsFirst().op("int4_ops")),
	foreignKey({
			columns: [table.created_by],
			foreignColumns: [admin_users.id],
			name: "creator_agreement_documents_created_by_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.published_by],
			foreignColumns: [admin_users.id],
			name: "creator_agreement_documents_published_by_fkey"
		}).onDelete("set null"),
	unique("creator_agreement_documents_version_key").on(table.version),
	check("creator_agreement_documents_checksum_check", sql`checksum ~ '^[a-f0-9]{64}$'::text`),
	check("creator_agreement_documents_version_check", sql`version > 0`),
]);

export const creator_deal_approval_events = pgTable("creator_deal_approval_events", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	request_id: uuid().notNull(),
	event_type: text().notNull(),
	actor_kind: text().notNull(),
	actor_admin_user_id: uuid(),
	actor_discord_user_id: text(),
	interaction_id: text(),
	metadata: jsonb(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("creator_deal_approval_events_interaction_unique").using("btree", table.interaction_id.asc().nullsLast().op("text_ops")).where(sql`(interaction_id IS NOT NULL)`),
	index("creator_deal_approval_events_request_idx").using("btree", table.request_id.asc().nullsLast().op("uuid_ops"), table.created_at.asc().nullsLast().op("uuid_ops"), table.id.asc().nullsLast().op("timestamptz_ops")),
	foreignKey({
			columns: [table.actor_admin_user_id],
			foreignColumns: [admin_users.id],
			name: "creator_deal_approval_events_actor_admin_user_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.request_id],
			foreignColumns: [creator_deal_approval_requests.id],
			name: "creator_deal_approval_events_request_id_fkey"
		}).onDelete("restrict"),
	check("creator_deal_approval_events_actor_check", sql`actor_kind = ANY (ARRAY['admin'::text, 'creator'::text, 'bot'::text, 'system'::text])`),
	check("creator_deal_approval_events_discord_actor_check", sql`(actor_discord_user_id IS NULL) OR (actor_discord_user_id ~ '^[0-9]{17,20}$'::text)`),
]);

export const creator_deal_approval_requests = pgTable("creator_deal_approval_requests", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	creator_user_id: text().notNull(),
	discord_setup_id: uuid().notNull(),
	creator_discord_user_id: text().notNull(),
	guild_id: text().notNull(),
	category_id: text().notNull(),
	chat_channel_id: text().notNull(),
	deal_payload: jsonb(),
	multiplier_payload: jsonb(),
	pnl_payload: jsonb(),
	reward_payload: jsonb(),
	agreement_document_id: uuid().notNull(),
	agreement_version: integer().notNull(),
	agreement_lines: jsonb().notNull(),
	agreement_checksum: text().notNull(),
	status: text().default('pending_delivery').notNull(),
	submitted_by: uuid().notNull(),
	summary_message_id: text(),
	delivery_attempt_count: integer().default(0).notNull(),
	delivery_max_attempts: integer().default(10).notNull(),
	delivery_available_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	delivery_lease_token: uuid(),
	delivery_lease_owner: text(),
	delivery_leased_until: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	decision_interaction_id: text(),
	decision_actor_discord_user_id: text(),
	continued_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	approved_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	declined_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	backend_deal_id: text(),
	backend_create_attempted_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	reward_program_id: uuid(),
	provisioning_attempt_count: integer().default(0).notNull(),
	provisioning_lease_token: uuid(),
	provisioning_leased_until: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	last_error_step: text(),
	last_error_code: text(),
	last_error_message: text(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	completed_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	leaderboard_payload: jsonb(),
	leaderboard_id: uuid(),
	request_kind: text().default('deal').notNull(),
	window_start_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).notNull(),
	window_end_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).notNull(),
	pnl_deal_id: uuid(),
}, (table) => [
	index("creator_deal_approval_creator_history_idx").using("btree", table.creator_user_id.asc().nullsLast().op("uuid_ops"), table.created_at.desc().nullsFirst().op("uuid_ops"), table.id.desc().nullsFirst().op("text_ops")),
	index("creator_deal_approval_delivery_claim_idx").using("btree", table.guild_id.asc().nullsLast().op("timestamptz_ops"), table.delivery_available_at.asc().nullsLast().op("timestamptz_ops"), table.created_at.asc().nullsLast().op("text_ops")).where(sql`(status = 'pending_delivery'::text)`),
	uniqueIndex("creator_deal_approval_one_unresolved_creator").using("btree", table.creator_user_id.asc().nullsLast().op("text_ops"), sql`(CASE WHEN request_kind = ANY (ARRAY['deal'::text, 'multiplier_deal'::text, 'pnl_deal'::text]) THEN 'deal'::text ELSE request_kind END)`).where(sql`(status = ANY (ARRAY['pending_delivery'::text, 'awaiting_continue'::text, 'awaiting_decision'::text, 'approved_provisioning'::text, 'provisioning_failed'::text, 'delivery_failed'::text]))`),
	uniqueIndex("creator_deal_approval_requests_pnl_deal_unique").using("btree", table.pnl_deal_id.asc().nullsLast().op("uuid_ops")).where(sql`(pnl_deal_id IS NOT NULL)`),
	foreignKey({
			columns: [table.agreement_document_id],
			foreignColumns: [creator_agreement_documents.id],
			name: "creator_deal_approval_requests_agreement_document_id_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.discord_setup_id],
			foreignColumns: [discord_creator_setups.id],
			name: "creator_deal_approval_requests_discord_setup_id_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.submitted_by],
			foreignColumns: [admin_users.id],
			name: "creator_deal_approval_requests_submitted_by_fkey"
		}).onDelete("restrict"),
	check("creator_deal_approval_checksum_check", sql`agreement_checksum ~ '^[a-f0-9]{64}$'::text`),
	check("creator_deal_approval_creator_user_check", sql`((length(creator_user_id) >= 8) AND (length(creator_user_id) <= 64)) AND (creator_user_id ~ '^[A-Za-z0-9_-]+$'::text)`),
	check("creator_deal_approval_delivery_attempt_check", sql`(delivery_attempt_count >= 0) AND ((delivery_max_attempts >= 1) AND (delivery_max_attempts <= 25))`),
	check("creator_deal_approval_discord_ids_check", sql`(creator_discord_user_id ~ '^[0-9]{17,20}$'::text) AND (guild_id ~ '^[0-9]{17,20}$'::text) AND (category_id ~ '^[0-9]{17,20}$'::text) AND (chat_channel_id ~ '^[0-9]{17,20}$'::text)`),
	check("creator_deal_approval_kind_payload_check", sql`((request_kind = 'deal'::text) AND (deal_payload IS NOT NULL) AND (multiplier_payload IS NULL) AND (pnl_payload IS NULL)) OR ((request_kind = 'multiplier_deal'::text) AND (multiplier_payload IS NOT NULL) AND (deal_payload IS NULL) AND (pnl_payload IS NULL) AND (reward_payload IS NULL) AND (leaderboard_payload IS NULL)) OR ((request_kind = 'pnl_deal'::text) AND (pnl_payload IS NOT NULL) AND (deal_payload IS NULL) AND (multiplier_payload IS NULL)) OR ((request_kind = 'leaderboard_only'::text) AND (leaderboard_payload IS NOT NULL) AND (deal_payload IS NULL) AND (multiplier_payload IS NULL) AND (pnl_payload IS NULL) AND (reward_payload IS NULL)) OR ((request_kind = 'rewards_only'::text) AND (reward_payload IS NOT NULL) AND (deal_payload IS NULL) AND (multiplier_payload IS NULL) AND (pnl_payload IS NULL) AND (leaderboard_payload IS NULL))`),
	check("creator_deal_approval_payload_check", sql`((deal_payload IS NULL) OR (jsonb_typeof(deal_payload) = 'object'::text)) AND ((multiplier_payload IS NULL) OR (jsonb_typeof(multiplier_payload) = 'object'::text)) AND ((pnl_payload IS NULL) OR (jsonb_typeof(pnl_payload) = 'object'::text)) AND ((reward_payload IS NULL) OR (jsonb_typeof(reward_payload) = 'object'::text)) AND ((leaderboard_payload IS NULL) OR (jsonb_typeof(leaderboard_payload) = 'object'::text)) AND (jsonb_typeof(agreement_lines) = 'array'::text) AND (jsonb_array_length(agreement_lines) > 0)`),
	check("creator_deal_approval_provision_attempt_check", sql`provisioning_attempt_count >= 0`),
	check("creator_deal_approval_request_kind_check", sql`request_kind = ANY (ARRAY['deal'::text, 'multiplier_deal'::text, 'pnl_deal'::text, 'leaderboard_only'::text, 'rewards_only'::text])`),
	check("creator_deal_approval_status_check", sql`status = ANY (ARRAY['pending_delivery'::text, 'awaiting_continue'::text, 'awaiting_decision'::text, 'approved_provisioning'::text, 'provisioning_failed'::text, 'completed'::text, 'declined'::text, 'delivery_failed'::text, 'cancelled'::text, 'expired'::text])`),
	check("creator_deal_approval_window_check", sql`window_end_at > window_start_at`),
]);

export const creator_pnl_deals = pgTable("creator_pnl_deals", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	creator_user_id: text().notNull(),
	source_approval_request_id: uuid().notNull(),
	status: text().default('scheduled').notNull(),
	frame_start_utc: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).notNull(),
	frame_end_utc: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).notNull(),
	positive_pnl_share_bps: integer().notNull(),
	funding_mode: text().notNull(),
	funding_config: jsonb().notNull(),
	linked_fill_deal_id: uuid(),
	linked_multiplier_deal_id: uuid(),
	max_tip_per_stream_usd: numeric({ precision: 20, scale: 2 }),
	max_tip_per_user_usd: numeric({ precision: 20, scale: 2 }),
	max_sponsored_battle_usd: numeric({ precision: 20, scale: 2 }),
	max_sponsorship_per_stream_usd: numeric({ precision: 20, scale: 2 }),
	terms_snapshot: jsonb().notNull(),
	frame_site_pnl_usd: numeric({ precision: 20, scale: 2 }),
	creator_share_usd: numeric({ precision: 20, scale: 2 }),
	settlement_breakdown: jsonb(),
	settlement_reason: text(),
	credit_status: text().default('not_ready').notNull(),
	credit_idempotency_key: text().notNull(),
	credit_attempted_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	credit_error: text(),
	credited_amount_usd: numeric({ precision: 20, scale: 2 }),
	credit_ledger_id: uuid(),
	credited_by_admin_user_id: uuid(),
	credited_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	activated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	calculation_started_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	calculated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	settled_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	cancelled_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	cancellation_reason: text(),
	created_by_admin_user_id: uuid().notNull(),
	version: integer().default(1).notNull(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	unique("creator_pnl_deals_source_approval_request_id_key").on(table.source_approval_request_id),
	uniqueIndex("creator_pnl_deals_credit_idempotency_unique").using("btree", table.credit_idempotency_key.asc().nullsLast().op("text_ops")),
	index("creator_pnl_deals_creator_history_idx").using("btree", table.creator_user_id.asc().nullsLast().op("text_ops"), table.frame_start_utc.desc().nullsFirst().op("timestamptz_ops"), table.id.desc().nullsFirst().op("uuid_ops")),
	index("creator_pnl_deals_calculation_queue_idx").using("btree", table.frame_end_utc.asc().nullsLast().op("timestamptz_ops"), table.created_at.asc().nullsLast().op("timestamptz_ops"), table.id.asc().nullsLast().op("uuid_ops")).where(sql`(status = ANY (ARRAY['active'::text, 'settlement_pending'::text]))`),
	index("creator_pnl_deals_credit_queue_idx").using("btree", table.calculated_at.asc().nullsLast().op("timestamptz_ops"), table.id.asc().nullsLast().op("uuid_ops")).where(sql`(status = ANY (ARRAY['calculated'::text, 'crediting'::text]))`),
	foreignKey({ columns: [table.source_approval_request_id], foreignColumns: [creator_deal_approval_requests.id], name: "creator_pnl_deals_source_approval_request_id_fkey" }).onDelete("restrict"),
	foreignKey({ columns: [table.credited_by_admin_user_id], foreignColumns: [admin_users.id], name: "creator_pnl_deals_credited_by_admin_user_id_fkey" }).onDelete("restrict"),
	foreignKey({ columns: [table.created_by_admin_user_id], foreignColumns: [admin_users.id], name: "creator_pnl_deals_created_by_admin_user_id_fkey" }).onDelete("restrict"),
	check("creator_pnl_deals_creator_user_check", sql`(length(creator_user_id) >= 8) AND (length(creator_user_id) <= 64) AND (creator_user_id ~ '^[A-Za-z0-9_-]+$'::text)`),
	check("creator_pnl_deals_status_check", sql`status = ANY (ARRAY['scheduled'::text, 'active'::text, 'settlement_pending'::text, 'calculated'::text, 'crediting'::text, 'settled'::text, 'cancelled'::text])`),
	check("creator_pnl_deals_frame_check", sql`frame_end_utc > frame_start_utc`),
	check("creator_pnl_deals_share_check", sql`(positive_pnl_share_bps >= 1) AND (positive_pnl_share_bps <= 10000)`),
	check("creator_pnl_deals_funding_mode_check", sql`funding_mode = ANY (ARRAY['non_withdrawable_fills'::text, 'linked_multiplier'::text, 'new_multiplier'::text])`),
	check("creator_pnl_deals_funding_config_check", sql`jsonb_typeof(funding_config) = 'object'::text`),
	check("creator_pnl_deals_funding_link_check", sql`((funding_mode = 'non_withdrawable_fills'::text) AND (linked_fill_deal_id IS NOT NULL) AND (linked_multiplier_deal_id IS NULL)) OR ((funding_mode = ANY (ARRAY['linked_multiplier'::text, 'new_multiplier'::text])) AND (linked_multiplier_deal_id IS NOT NULL) AND (linked_fill_deal_id IS NULL))`),
	check("creator_pnl_deals_terms_check", sql`jsonb_typeof(terms_snapshot) = 'object'::text`),
	check("creator_pnl_deals_caps_check", sql`((max_tip_per_stream_usd IS NULL) OR (max_tip_per_stream_usd >= (0)::numeric)) AND ((max_tip_per_user_usd IS NULL) OR (max_tip_per_user_usd >= (0)::numeric)) AND ((max_sponsored_battle_usd IS NULL) OR (max_sponsored_battle_usd >= (0)::numeric)) AND ((max_sponsorship_per_stream_usd IS NULL) OR (max_sponsorship_per_stream_usd >= (0)::numeric))`),
	check("creator_pnl_deals_credit_status_check", sql`credit_status = ANY (ARRAY['not_ready'::text, 'ready'::text, 'crediting'::text, 'credited'::text, 'failed'::text])`),
	check("creator_pnl_deals_credit_idempotency_check", sql`credit_idempotency_key = ('creator-pnl:'::text || (id)::text)`),
	check("creator_pnl_deals_credit_amount_check", sql`(credited_amount_usd IS NULL) OR (credited_amount_usd >= (0)::numeric)`),
	check("creator_pnl_deals_version_check", sql`version > 0`),
	check("creator_pnl_deals_settlement_shape_check", sql`(status <> 'settled'::text) OR ((settlement_breakdown IS NOT NULL) AND (frame_site_pnl_usd IS NOT NULL) AND (creator_share_usd IS NOT NULL) AND (credited_amount_usd IS NOT NULL) AND (credit_ledger_id IS NOT NULL) AND (credited_by_admin_user_id IS NOT NULL) AND (credited_at IS NOT NULL) AND (settled_at IS NOT NULL) AND (credit_status = 'credited'::text))`),
]);

export const creator_agreement_lines = pgTable("creator_agreement_lines", {
	document_id: uuid().notNull(),
	line_number: integer().notNull(),
	text: text().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.document_id],
			foreignColumns: [creator_agreement_documents.id],
			name: "creator_agreement_lines_document_id_fkey"
		}).onDelete("restrict"),
	primaryKey({ columns: [table.document_id, table.line_number], name: "creator_agreement_lines_pkey"}),
	check("creator_agreement_lines_number_check", sql`line_number > 0`),
	check("creator_agreement_lines_text_check", sql`(length(btrim(text)) >= 1) AND (length(btrim(text)) <= 1000)`),
]);

export const discord_notification_channel_mentions = pgTable("discord_notification_channel_mentions", {
	guild_id: text().notNull(),
	channel_id: text().notNull(),
	group_key: text().notNull(),
	created_by: uuid(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("discord_notification_channel_mentions_channel_idx").using("btree", table.guild_id.asc().nullsLast().op("text_ops"), table.channel_id.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.guild_id, table.channel_id],
			foreignColumns: [discord_notification_channels.guild_id, discord_notification_channels.channel_id],
			name: "discord_notification_channel_mentions_channel_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.created_by],
			foreignColumns: [admin_users.id],
			name: "discord_notification_channel_mentions_created_by_fkey"
		}).onDelete("set null"),
	primaryKey({ columns: [table.channel_id, table.group_key, table.guild_id], name: "discord_notification_channel_mentions_pkey"}),
	check("discord_notification_channel_mentions_group_check", sql`group_key = ANY (ARRAY['owner'::text, 'managers'::text, 'dev'::text, 'support'::text])`),
]);

export const discord_notification_channels = pgTable("discord_notification_channels", {
	guild_id: text().notNull(),
	channel_id: text().notNull(),
	name: text().notNull(),
	type: text().notNull(),
	parent_id: text(),
	parent_name: text(),
	position: integer().default(0).notNull(),
	can_view: boolean().default(false).notNull(),
	can_send: boolean().default(false).notNull(),
	can_embed: boolean().default(false).notNull(),
	available: boolean().default(true).notNull(),
	last_synced_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).notNull(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("discord_notification_channels_guild_position_idx").using("btree", table.guild_id.asc().nullsLast().op("int4_ops"), table.available.asc().nullsLast().op("bool_ops"), table.position.asc().nullsLast().op("text_ops"), table.name.asc().nullsLast().op("int4_ops")),
	foreignKey({
			columns: [table.guild_id],
			foreignColumns: [discord_notification_guilds.guild_id],
			name: "discord_notification_channels_guild_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.channel_id, table.guild_id], name: "discord_notification_channels_pkey"}),
	check("discord_notification_channels_id_check", sql`channel_id ~ '^[0-9]{15,21}$'::text`),
]);

export const discord_partnership_transcript_messages = pgTable("discord_partnership_transcript_messages", {
	transcript_id: uuid().notNull(),
	message_id: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ordinal: bigint({ mode: "number" }).notNull(),
	author_id: text(),
	author_username: text(),
	author_display_name: text(),
	author_avatar_url: text(),
	content: text(),
	discord_created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).notNull(),
	discord_edited_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }),
	referenced_message_id: text(),
	attachments: jsonb().default([]).notNull(),
	embeds: jsonb().default([]).notNull(),
	stickers: jsonb().default([]).notNull(),
	created_at: timestamp({ precision: 6, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("discord_partnership_transcript_messages_order_idx").using("btree", table.transcript_id.asc().nullsLast().op("uuid_ops"), table.ordinal.asc().nullsLast().op("int8_ops")),
	foreignKey({
			columns: [table.transcript_id],
			foreignColumns: [discord_partnership_transcripts.id],
			name: "discord_partnership_transcript_messages_transcript_id_fkey"
		}).onDelete("restrict"),
	primaryKey({ columns: [table.message_id, table.transcript_id], name: "discord_partnership_transcript_messages_pkey"}),
	unique("discord_partnership_transcript_messages_ordinal_unique").on(table.ordinal, table.transcript_id),
	check("discord_partnership_transcript_messages_ids_check", sql`(message_id ~ '^[0-9]{17,20}$'::text) AND ((author_id IS NULL) OR (author_id ~ '^[0-9]{17,20}$'::text)) AND ((referenced_message_id IS NULL) OR (referenced_message_id ~ '^[0-9]{17,20}$'::text))`),
	check("discord_partnership_transcript_messages_json_check", sql`(jsonb_typeof(attachments) = 'array'::text) AND (jsonb_array_length(attachments) <= 10) AND (jsonb_typeof(embeds) = 'array'::text) AND (jsonb_array_length(embeds) <= 10) AND (jsonb_typeof(stickers) = 'array'::text) AND (jsonb_array_length(stickers) <= 3)`),
	check("discord_partnership_transcript_messages_text_check", sql`((author_username IS NULL) OR (length(author_username) <= 100)) AND ((author_display_name IS NULL) OR (length(author_display_name) <= 100)) AND ((content IS NULL) OR (length(content) <= 4000))`),
]);
