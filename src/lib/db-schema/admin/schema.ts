import { pgTable, varchar, timestamp, text, integer, index, uuid, boolean, numeric, foreignKey, unique, bigint, jsonb, uniqueIndex, date, smallint, check, pgEnum, customType } from "drizzle-orm/pg-core"
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
	discord_channel_url: text(),
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
	index("admin_audit_events_admin_user_id_idx").using("btree", table.admin_user_id.asc().nullsLast().op("uuid_ops")),
	index("admin_audit_events_created_at_idx").using("btree", table.created_at.desc().nullsFirst().op("timestamptz_ops")),
	index("admin_audit_events_event_type_idx").using("btree", table.event_type.asc().nullsLast().op("text_ops")),
	index("admin_audit_events_target_user_id_idx").using("btree", table.target_user_id.asc().nullsLast().op("text_ops")),
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
	created_by_id: uuid().notNull(),
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
	created_by_id: uuid().notNull(),
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
			columns: [table.shift_id],
			foreignColumns: [admin_shifts.id],
			name: "admin_shift_assignments_shift_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
			columns: [table.admin_user_id],
			foreignColumns: [admin_users.id],
			name: "admin_shift_assignments_admin_user_id_fkey"
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
}, (table) => [
	index("creator_reward_programs_creator_idx").using("btree", table.creator_user_id.asc().nullsLast().op("text_ops")),
	index("creator_reward_programs_is_active_idx").using("btree", table.is_active.asc().nullsLast().op("bool_ops")),
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
			columns: [table.drawn_by],
			foreignColumns: [admin_users.id],
			name: "chat_raffle_rounds_drawn_by_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.created_by],
			foreignColumns: [admin_users.id],
			name: "chat_raffle_rounds_created_by_fkey"
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
			columns: [table.round_id],
			foreignColumns: [chat_raffle_rounds.id],
			name: "chat_raffle_prizes_round_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.paid_by],
			foreignColumns: [admin_users.id],
			name: "chat_raffle_prizes_paid_by_fkey"
		}).onDelete("set null"),
	unique("chat_raffle_prizes_round_position_unique").on(table.position, table.round_id),
]);

export const chat_raffle_entries = pgTable("chat_raffle_entries", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	round_id: uuid().notNull(),
	user_id: text().notNull(),
	username: text(),
	message_count: integer().default(0).notNull(),
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
			columns: [table.round_id],
			foreignColumns: [chat_raffle_rounds.id],
			name: "chat_raffle_adjustments_round_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.created_by],
			foreignColumns: [admin_users.id],
			name: "chat_raffle_adjustments_created_by_fkey"
		}).onDelete("set null"),
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
			columns: [table.quiz_id],
			foreignColumns: [staff_quizzes.id],
			name: "staff_quiz_attempts_quiz_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.admin_user_id],
			foreignColumns: [admin_users.id],
			name: "staff_quiz_attempts_admin_user_id_fkey"
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
	index("antifraud_reviews_assigned_idx").using("btree", table.assigned_to.asc().nullsLast().op("uuid_ops"), table.created_at.desc().nullsFirst().op("timestamptz_ops")),
	index("antifraud_reviews_created_idx").using("btree", table.created_at.desc().nullsFirst().op("timestamptz_ops")),
	uniqueIndex("antifraud_reviews_open_target_uniq").using("btree", table.target_user_id.asc().nullsLast().op("text_ops")).where(sql`(status = ANY (ARRAY['open'::text, 'in_review'::text]))`),
	index("antifraud_reviews_status_created_idx").using("btree", table.status.asc().nullsLast().op("timestamptz_ops"), table.created_at.desc().nullsFirst().op("text_ops")),
	index("antifraud_reviews_target_idx").using("btree", table.target_user_id.asc().nullsLast().op("text_ops")),
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
}, (table) => [
	index("creator_reward_offer_windows_lookup_idx").using("btree", table.program_id.asc().nullsLast().op("timestamptz_ops"), table.user_id.asc().nullsLast().op("text_ops"), table.leg.asc().nullsLast().op("text_ops"), table.expires_at.asc().nullsLast().op("uuid_ops")),
	index("creator_reward_offer_windows_open_expiry_idx").using("btree", table.expires_at.asc().nullsLast().op("timestamptz_ops")).where(sql`(claimed_at IS NULL)`),
	uniqueIndex("creator_reward_offer_windows_unit_key").using("btree", table.program_id.asc().nullsLast().op("text_ops"), table.user_id.asc().nullsLast().op("uuid_ops"), table.leg.asc().nullsLast().op("timestamptz_ops"), table.run_started_at.asc().nullsLast().op("text_ops"), table.basis_position_usd.asc().nullsLast().op("timestamptz_ops")),
	foreignKey({
			columns: [table.program_id],
			foreignColumns: [creator_reward_programs.id],
			name: "creator_reward_offer_windows_program_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
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
}, (table) => [
	uniqueIndex("antifraud_signals_external_uniq").using("btree", table.external_id.asc().nullsLast().op("text_ops")).where(sql`(external_id IS NOT NULL)`),
	index("antifraud_signals_received_idx").using("btree", table.received_at.desc().nullsFirst().op("timestamptz_ops")),
	index("antifraud_signals_target_idx").using("btree", table.target_user_id.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.review_id],
			foreignColumns: [antifraud_reviews.id],
			name: "antifraud_signals_review_id_fkey"
		}).onDelete("set null"),
]);
