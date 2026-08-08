import { relations } from "drizzle-orm/relations";
import { discord_creator_setups, discord_creator_reward_claim_jobs, admin_users, admin_giveaway_actions, admin_roles, admin_sessions, admin_notes, admin_audit_events, admin_gift_card_actions, admin_voucher_actions, expenses, recurring_expenses, admin_shifts, admin_shift_assignments, salary_employees, salary_payouts, excluded_users, employee_workspaces, employee_board_placements, employee_managers, employee_manager_workspaces, salary_payments, admin_user_tags, discord_partnership_tickets, discord_partnership_ticket_operations, admin_excluded_user_balance_v2, discord_partnership_transcripts, discord_partnership_transcript_batches, roadmap_items, roadmap_detail_fields, roadmap_links, roadmap_linear_links, admin_passkeys, admin_withdrawal_unlocks, creator_reward_programs, creator_reward_program_windows, creator_reward_claims, creator_deal_approval_requests, chat_raffle_rounds, chat_raffle_prizes, chat_raffle_entries, chat_raffle_adjustments, staff_profiles, staff_point_events, staff_notifications, staff_notification_channels, staff_notification_prefs, staff_quizzes, staff_quiz_questions, staff_quiz_options, staff_quiz_attempts, staff_quiz_answers, antifraud_reviews, antifraud_review_notes, creator_reward_offer_windows, discord_notification_channels, discord_notification_jobs, discord_notification_events, pack_creation_requests, discord_notification_routes, admin_whop_refund_batches, admin_whop_refund_items, discord_notification_guilds, discord_notification_channel_settings, discord_notification_channel_jobs, discord_creator_deposit_jobs, antifraud_security_audit_events, antifraud_review_reminder_state, antifraud_review_workflow, pack_build_draft_revisions, discord_creator_signup_jobs, admin_fiat_credit_reviews, antifraud_signals, creator_agreement_documents, creator_deal_approval_events, creator_agreement_lines, discord_notification_channel_mentions, discord_partnership_transcript_messages } from "./schema";

export const discord_creator_reward_claim_jobsRelations = relations(discord_creator_reward_claim_jobs, ({one}) => ({
	discord_creator_setup: one(discord_creator_setups, {
		fields: [discord_creator_reward_claim_jobs.setup_id],
		references: [discord_creator_setups.id]
	}),
}));

export const discord_creator_setupsRelations = relations(discord_creator_setups, ({many}) => ({
	discord_creator_reward_claim_jobs: many(discord_creator_reward_claim_jobs),
	discord_creator_deposit_jobs: many(discord_creator_deposit_jobs),
	discord_creator_signup_jobs: many(discord_creator_signup_jobs),
	creator_deal_approval_requests: many(creator_deal_approval_requests),
}));

export const admin_giveaway_actionsRelations = relations(admin_giveaway_actions, ({one}) => ({
	admin_user: one(admin_users, {
		fields: [admin_giveaway_actions.admin_user_id],
		references: [admin_users.id]
	}),
}));

export const admin_usersRelations = relations(admin_users, ({one, many}) => ({
	admin_giveaway_actions: many(admin_giveaway_actions),
	admin_role: one(admin_roles, {
		fields: [admin_users.role_id],
		references: [admin_roles.id]
	}),
	admin_sessions: many(admin_sessions),
	admin_notes: many(admin_notes),
	admin_audit_events: many(admin_audit_events),
	admin_gift_card_actions: many(admin_gift_card_actions),
	admin_voucher_actions: many(admin_voucher_actions),
	expenses: many(expenses),
	recurring_expenses: many(recurring_expenses),
	admin_shifts: many(admin_shifts),
	admin_shift_assignments: many(admin_shift_assignments),
	salary_employees: many(salary_employees),
	salary_payouts: many(salary_payouts),
	excluded_users: many(excluded_users),
	admin_user_tags: many(admin_user_tags),
	admin_excluded_user_balance_v2s: many(admin_excluded_user_balance_v2),
	admin_passkeys: many(admin_passkeys),
	admin_withdrawal_unlocks: many(admin_withdrawal_unlocks),
	chat_raffle_rounds_created_by: many(chat_raffle_rounds, {
		relationName: "chat_raffle_rounds_created_by_admin_users_id"
	}),
	chat_raffle_rounds_drawn_by: many(chat_raffle_rounds, {
		relationName: "chat_raffle_rounds_drawn_by_admin_users_id"
	}),
	chat_raffle_prizes: many(chat_raffle_prizes),
	chat_raffle_adjustments: many(chat_raffle_adjustments),
	staff_profiles: many(staff_profiles),
	staff_point_events: many(staff_point_events),
	staff_notifications: many(staff_notifications),
	staff_notification_channels: many(staff_notification_channels),
	staff_notification_prefs: many(staff_notification_prefs),
	staff_quiz_attempts: many(staff_quiz_attempts),
	pack_creation_requests_requested_by: many(pack_creation_requests, {
		relationName: "pack_creation_requests_requested_by_admin_users_id"
	}),
	pack_creation_requests_reviewed_by: many(pack_creation_requests, {
		relationName: "pack_creation_requests_reviewed_by_admin_users_id"
	}),
	discord_notification_events: many(discord_notification_events),
	discord_notification_routes: many(discord_notification_routes),
	admin_whop_refund_batches: many(admin_whop_refund_batches),
	discord_notification_channel_settings: many(discord_notification_channel_settings),
	discord_notification_channel_jobs: many(discord_notification_channel_jobs),
	antifraud_security_audit_events: many(antifraud_security_audit_events),
	antifraud_review_workflows: many(antifraud_review_workflow),
	pack_build_draft_revisions: many(pack_build_draft_revisions),
	admin_fiat_credit_reviews_decided_by: many(admin_fiat_credit_reviews, {
		relationName: "admin_fiat_credit_reviews_decided_by_admin_users_id"
	}),
	admin_fiat_credit_reviews_resolution_requested_by: many(admin_fiat_credit_reviews, {
		relationName: "admin_fiat_credit_reviews_resolution_requested_by_admin_users_id"
	}),
	admin_fiat_credit_reviews_resolved_by: many(admin_fiat_credit_reviews, {
		relationName: "admin_fiat_credit_reviews_resolved_by_admin_users_id"
	}),
	creator_agreement_documents_created_by: many(creator_agreement_documents, {
		relationName: "creator_agreement_documents_created_by_admin_users_id"
	}),
	creator_agreement_documents_published_by: many(creator_agreement_documents, {
		relationName: "creator_agreement_documents_published_by_admin_users_id"
	}),
	creator_deal_approval_events: many(creator_deal_approval_events),
	creator_deal_approval_requests: many(creator_deal_approval_requests),
	discord_notification_channel_mentions: many(discord_notification_channel_mentions),
}));

export const admin_rolesRelations = relations(admin_roles, ({many}) => ({
	admin_users: many(admin_users),
}));

export const admin_sessionsRelations = relations(admin_sessions, ({one}) => ({
	admin_user: one(admin_users, {
		fields: [admin_sessions.admin_user_id],
		references: [admin_users.id]
	}),
}));

export const admin_notesRelations = relations(admin_notes, ({one}) => ({
	admin_user: one(admin_users, {
		fields: [admin_notes.admin_user_id],
		references: [admin_users.id]
	}),
}));

export const admin_audit_eventsRelations = relations(admin_audit_events, ({one}) => ({
	admin_user: one(admin_users, {
		fields: [admin_audit_events.admin_user_id],
		references: [admin_users.id]
	}),
}));

export const admin_gift_card_actionsRelations = relations(admin_gift_card_actions, ({one}) => ({
	admin_user: one(admin_users, {
		fields: [admin_gift_card_actions.admin_user_id],
		references: [admin_users.id]
	}),
}));

export const admin_voucher_actionsRelations = relations(admin_voucher_actions, ({one}) => ({
	admin_user: one(admin_users, {
		fields: [admin_voucher_actions.admin_user_id],
		references: [admin_users.id]
	}),
}));

export const expensesRelations = relations(expenses, ({one}) => ({
	admin_user: one(admin_users, {
		fields: [expenses.created_by_id],
		references: [admin_users.id]
	}),
}));

export const recurring_expensesRelations = relations(recurring_expenses, ({one}) => ({
	admin_user: one(admin_users, {
		fields: [recurring_expenses.created_by_id],
		references: [admin_users.id]
	}),
}));

export const admin_shiftsRelations = relations(admin_shifts, ({one, many}) => ({
	admin_user: one(admin_users, {
		fields: [admin_shifts.created_by_id],
		references: [admin_users.id]
	}),
	admin_shift_assignments: many(admin_shift_assignments),
}));

export const admin_shift_assignmentsRelations = relations(admin_shift_assignments, ({one}) => ({
	admin_user: one(admin_users, {
		fields: [admin_shift_assignments.admin_user_id],
		references: [admin_users.id]
	}),
	admin_shift: one(admin_shifts, {
		fields: [admin_shift_assignments.shift_id],
		references: [admin_shifts.id]
	}),
}));

export const salary_employeesRelations = relations(salary_employees, ({one, many}) => ({
	admin_user: one(admin_users, {
		fields: [salary_employees.created_by_id],
		references: [admin_users.id]
	}),
	salary_payouts: many(salary_payouts),
	salary_payments: many(salary_payments),
}));

export const salary_payoutsRelations = relations(salary_payouts, ({one}) => ({
	salary_employee: one(salary_employees, {
		fields: [salary_payouts.employee_id],
		references: [salary_employees.id]
	}),
	admin_user: one(admin_users, {
		fields: [salary_payouts.paid_by_id],
		references: [admin_users.id]
	}),
}));

export const excluded_usersRelations = relations(excluded_users, ({one}) => ({
	admin_user: one(admin_users, {
		fields: [excluded_users.excluded_by],
		references: [admin_users.id]
	}),
}));

export const employee_board_placementsRelations = relations(employee_board_placements, ({one}) => ({
	employee_workspace: one(employee_workspaces, {
		fields: [employee_board_placements.workspace_id],
		references: [employee_workspaces.id]
	}),
}));

export const employee_workspacesRelations = relations(employee_workspaces, ({many}) => ({
	employee_board_placements: many(employee_board_placements),
	employee_manager_workspaces: many(employee_manager_workspaces),
}));

export const employee_manager_workspacesRelations = relations(employee_manager_workspaces, ({one}) => ({
	employee_manager: one(employee_managers, {
		fields: [employee_manager_workspaces.manager_id],
		references: [employee_managers.id]
	}),
	employee_workspace: one(employee_workspaces, {
		fields: [employee_manager_workspaces.workspace_id],
		references: [employee_workspaces.id]
	}),
}));

export const employee_managersRelations = relations(employee_managers, ({many}) => ({
	employee_manager_workspaces: many(employee_manager_workspaces),
}));

export const salary_paymentsRelations = relations(salary_payments, ({one}) => ({
	salary_employee: one(salary_employees, {
		fields: [salary_payments.employee_id],
		references: [salary_employees.id]
	}),
}));

export const admin_user_tagsRelations = relations(admin_user_tags, ({one}) => ({
	admin_user: one(admin_users, {
		fields: [admin_user_tags.set_by_admin_id],
		references: [admin_users.id]
	}),
}));

export const discord_partnership_ticket_operationsRelations = relations(discord_partnership_ticket_operations, ({one, many}) => ({
	discord_partnership_ticket: one(discord_partnership_tickets, {
		fields: [discord_partnership_ticket_operations.ticket_id],
		references: [discord_partnership_tickets.id]
	}),
	discord_partnership_transcripts: many(discord_partnership_transcripts),
}));

export const discord_partnership_ticketsRelations = relations(discord_partnership_tickets, ({many}) => ({
	discord_partnership_ticket_operations: many(discord_partnership_ticket_operations),
	discord_partnership_transcripts: many(discord_partnership_transcripts),
}));

export const admin_excluded_user_balance_v2Relations = relations(admin_excluded_user_balance_v2, ({one}) => ({
	admin_user: one(admin_users, {
		fields: [admin_excluded_user_balance_v2.set_by_admin_id],
		references: [admin_users.id]
	}),
}));

export const discord_partnership_transcriptsRelations = relations(discord_partnership_transcripts, ({one, many}) => ({
	discord_partnership_ticket_operation: one(discord_partnership_ticket_operations, {
		fields: [discord_partnership_transcripts.close_operation_id],
		references: [discord_partnership_ticket_operations.id]
	}),
	discord_partnership_ticket: one(discord_partnership_tickets, {
		fields: [discord_partnership_transcripts.ticket_id],
		references: [discord_partnership_tickets.id]
	}),
	discord_partnership_transcript_batches: many(discord_partnership_transcript_batches),
	discord_partnership_transcript_messages: many(discord_partnership_transcript_messages),
}));

export const discord_partnership_transcript_batchesRelations = relations(discord_partnership_transcript_batches, ({one}) => ({
	discord_partnership_transcript: one(discord_partnership_transcripts, {
		fields: [discord_partnership_transcript_batches.transcript_id],
		references: [discord_partnership_transcripts.id]
	}),
}));

export const roadmap_detail_fieldsRelations = relations(roadmap_detail_fields, ({one}) => ({
	roadmap_item: one(roadmap_items, {
		fields: [roadmap_detail_fields.item_id],
		references: [roadmap_items.id]
	}),
}));

export const roadmap_itemsRelations = relations(roadmap_items, ({many}) => ({
	roadmap_detail_fields: many(roadmap_detail_fields),
	roadmap_links: many(roadmap_links),
	roadmap_linear_links: many(roadmap_linear_links),
}));

export const roadmap_linksRelations = relations(roadmap_links, ({one}) => ({
	roadmap_item: one(roadmap_items, {
		fields: [roadmap_links.item_id],
		references: [roadmap_items.id]
	}),
}));

export const roadmap_linear_linksRelations = relations(roadmap_linear_links, ({one}) => ({
	roadmap_item: one(roadmap_items, {
		fields: [roadmap_linear_links.item_id],
		references: [roadmap_items.id]
	}),
}));

export const admin_passkeysRelations = relations(admin_passkeys, ({one}) => ({
	admin_user: one(admin_users, {
		fields: [admin_passkeys.admin_user_id],
		references: [admin_users.id]
	}),
}));

export const admin_withdrawal_unlocksRelations = relations(admin_withdrawal_unlocks, ({one}) => ({
	admin_user: one(admin_users, {
		fields: [admin_withdrawal_unlocks.unlocked_by],
		references: [admin_users.id]
	}),
}));

export const creator_reward_program_windowsRelations = relations(creator_reward_program_windows, ({one}) => ({
	creator_reward_program: one(creator_reward_programs, {
		fields: [creator_reward_program_windows.program_id],
		references: [creator_reward_programs.id]
	}),
}));

export const creator_reward_programsRelations = relations(creator_reward_programs, ({one, many}) => ({
	creator_reward_program_windows: many(creator_reward_program_windows),
	creator_reward_claims: many(creator_reward_claims),
	creator_deal_approval_request: one(creator_deal_approval_requests, {
		fields: [creator_reward_programs.source_approval_request_id],
		references: [creator_deal_approval_requests.id]
	}),
	creator_reward_offer_windows: many(creator_reward_offer_windows),
}));

export const creator_reward_claimsRelations = relations(creator_reward_claims, ({one, many}) => ({
	creator_reward_program: one(creator_reward_programs, {
		fields: [creator_reward_claims.program_id],
		references: [creator_reward_programs.id]
	}),
	creator_reward_offer_windows: many(creator_reward_offer_windows),
}));

export const creator_deal_approval_requestsRelations = relations(creator_deal_approval_requests, ({one, many}) => ({
	creator_reward_programs: many(creator_reward_programs),
	creator_deal_approval_events: many(creator_deal_approval_events),
	creator_agreement_document: one(creator_agreement_documents, {
		fields: [creator_deal_approval_requests.agreement_document_id],
		references: [creator_agreement_documents.id]
	}),
	discord_creator_setup: one(discord_creator_setups, {
		fields: [creator_deal_approval_requests.discord_setup_id],
		references: [discord_creator_setups.id]
	}),
	admin_user: one(admin_users, {
		fields: [creator_deal_approval_requests.submitted_by],
		references: [admin_users.id]
	}),
}));

export const chat_raffle_roundsRelations = relations(chat_raffle_rounds, ({one, many}) => ({
	admin_user_created_by: one(admin_users, {
		fields: [chat_raffle_rounds.created_by],
		references: [admin_users.id],
		relationName: "chat_raffle_rounds_created_by_admin_users_id"
	}),
	admin_user_drawn_by: one(admin_users, {
		fields: [chat_raffle_rounds.drawn_by],
		references: [admin_users.id],
		relationName: "chat_raffle_rounds_drawn_by_admin_users_id"
	}),
	chat_raffle_prizes: many(chat_raffle_prizes),
	chat_raffle_entries: many(chat_raffle_entries),
	chat_raffle_adjustments: many(chat_raffle_adjustments),
}));

export const chat_raffle_prizesRelations = relations(chat_raffle_prizes, ({one}) => ({
	admin_user: one(admin_users, {
		fields: [chat_raffle_prizes.paid_by],
		references: [admin_users.id]
	}),
	chat_raffle_round: one(chat_raffle_rounds, {
		fields: [chat_raffle_prizes.round_id],
		references: [chat_raffle_rounds.id]
	}),
}));

export const chat_raffle_entriesRelations = relations(chat_raffle_entries, ({one}) => ({
	chat_raffle_round: one(chat_raffle_rounds, {
		fields: [chat_raffle_entries.round_id],
		references: [chat_raffle_rounds.id]
	}),
}));

export const chat_raffle_adjustmentsRelations = relations(chat_raffle_adjustments, ({one}) => ({
	admin_user: one(admin_users, {
		fields: [chat_raffle_adjustments.created_by],
		references: [admin_users.id]
	}),
	chat_raffle_round: one(chat_raffle_rounds, {
		fields: [chat_raffle_adjustments.round_id],
		references: [chat_raffle_rounds.id]
	}),
}));

export const staff_profilesRelations = relations(staff_profiles, ({one}) => ({
	admin_user: one(admin_users, {
		fields: [staff_profiles.admin_user_id],
		references: [admin_users.id]
	}),
}));

export const staff_point_eventsRelations = relations(staff_point_events, ({one}) => ({
	admin_user: one(admin_users, {
		fields: [staff_point_events.admin_user_id],
		references: [admin_users.id]
	}),
}));

export const staff_notificationsRelations = relations(staff_notifications, ({one}) => ({
	admin_user: one(admin_users, {
		fields: [staff_notifications.admin_user_id],
		references: [admin_users.id]
	}),
}));

export const staff_notification_channelsRelations = relations(staff_notification_channels, ({one}) => ({
	admin_user: one(admin_users, {
		fields: [staff_notification_channels.admin_user_id],
		references: [admin_users.id]
	}),
}));

export const staff_notification_prefsRelations = relations(staff_notification_prefs, ({one}) => ({
	admin_user: one(admin_users, {
		fields: [staff_notification_prefs.admin_user_id],
		references: [admin_users.id]
	}),
}));

export const staff_quiz_questionsRelations = relations(staff_quiz_questions, ({one, many}) => ({
	staff_quizz: one(staff_quizzes, {
		fields: [staff_quiz_questions.quiz_id],
		references: [staff_quizzes.id]
	}),
	staff_quiz_options: many(staff_quiz_options),
	staff_quiz_answers: many(staff_quiz_answers),
}));

export const staff_quizzesRelations = relations(staff_quizzes, ({many}) => ({
	staff_quiz_questions: many(staff_quiz_questions),
	staff_quiz_attempts: many(staff_quiz_attempts),
}));

export const staff_quiz_optionsRelations = relations(staff_quiz_options, ({one}) => ({
	staff_quiz_question: one(staff_quiz_questions, {
		fields: [staff_quiz_options.question_id],
		references: [staff_quiz_questions.id]
	}),
}));

export const staff_quiz_attemptsRelations = relations(staff_quiz_attempts, ({one, many}) => ({
	admin_user: one(admin_users, {
		fields: [staff_quiz_attempts.admin_user_id],
		references: [admin_users.id]
	}),
	staff_quizz: one(staff_quizzes, {
		fields: [staff_quiz_attempts.quiz_id],
		references: [staff_quizzes.id]
	}),
	staff_quiz_answers: many(staff_quiz_answers),
}));

export const staff_quiz_answersRelations = relations(staff_quiz_answers, ({one}) => ({
	staff_quiz_attempt: one(staff_quiz_attempts, {
		fields: [staff_quiz_answers.attempt_id],
		references: [staff_quiz_attempts.id]
	}),
	staff_quiz_question: one(staff_quiz_questions, {
		fields: [staff_quiz_answers.question_id],
		references: [staff_quiz_questions.id]
	}),
}));

export const antifraud_review_notesRelations = relations(antifraud_review_notes, ({one}) => ({
	antifraud_review: one(antifraud_reviews, {
		fields: [antifraud_review_notes.review_id],
		references: [antifraud_reviews.id]
	}),
}));

export const antifraud_reviewsRelations = relations(antifraud_reviews, ({many}) => ({
	antifraud_review_notes: many(antifraud_review_notes),
	antifraud_review_reminder_states: many(antifraud_review_reminder_state),
	antifraud_review_workflows: many(antifraud_review_workflow),
	antifraud_signals: many(antifraud_signals),
}));

export const creator_reward_offer_windowsRelations = relations(creator_reward_offer_windows, ({one}) => ({
	creator_reward_claim: one(creator_reward_claims, {
		fields: [creator_reward_offer_windows.claim_id],
		references: [creator_reward_claims.id]
	}),
	creator_reward_program: one(creator_reward_programs, {
		fields: [creator_reward_offer_windows.program_id],
		references: [creator_reward_programs.id]
	}),
}));

export const discord_notification_jobsRelations = relations(discord_notification_jobs, ({one}) => ({
	discord_notification_channel: one(discord_notification_channels, {
		fields: [discord_notification_jobs.guild_id],
		references: [discord_notification_channels.guild_id]
	}),
	discord_notification_event: one(discord_notification_events, {
		fields: [discord_notification_jobs.event_key],
		references: [discord_notification_events.event_key]
	}),
}));

export const discord_notification_channelsRelations = relations(discord_notification_channels, ({one, many}) => ({
	discord_notification_jobs: many(discord_notification_jobs),
	discord_notification_routes: many(discord_notification_routes),
	discord_notification_channel_settings: many(discord_notification_channel_settings),
	discord_notification_channel_jobs: many(discord_notification_channel_jobs),
	discord_notification_channel_mentions: many(discord_notification_channel_mentions),
	discord_notification_guild: one(discord_notification_guilds, {
		fields: [discord_notification_channels.guild_id],
		references: [discord_notification_guilds.guild_id]
	}),
}));

export const discord_notification_eventsRelations = relations(discord_notification_events, ({one, many}) => ({
	discord_notification_jobs: many(discord_notification_jobs),
	admin_user: one(admin_users, {
		fields: [discord_notification_events.created_by],
		references: [admin_users.id]
	}),
	discord_notification_routes: many(discord_notification_routes),
}));

export const pack_creation_requestsRelations = relations(pack_creation_requests, ({one, many}) => ({
	admin_user_requested_by: one(admin_users, {
		fields: [pack_creation_requests.requested_by],
		references: [admin_users.id],
		relationName: "pack_creation_requests_requested_by_admin_users_id"
	}),
	admin_user_reviewed_by: one(admin_users, {
		fields: [pack_creation_requests.reviewed_by],
		references: [admin_users.id],
		relationName: "pack_creation_requests_reviewed_by_admin_users_id"
	}),
	pack_build_draft_revisions: many(pack_build_draft_revisions),
}));

export const discord_notification_routesRelations = relations(discord_notification_routes, ({one}) => ({
	discord_notification_channel: one(discord_notification_channels, {
		fields: [discord_notification_routes.guild_id],
		references: [discord_notification_channels.guild_id]
	}),
	admin_user: one(admin_users, {
		fields: [discord_notification_routes.created_by],
		references: [admin_users.id]
	}),
	discord_notification_event: one(discord_notification_events, {
		fields: [discord_notification_routes.event_key],
		references: [discord_notification_events.event_key]
	}),
}));

export const admin_whop_refund_batchesRelations = relations(admin_whop_refund_batches, ({one, many}) => ({
	admin_user: one(admin_users, {
		fields: [admin_whop_refund_batches.requested_by],
		references: [admin_users.id]
	}),
	admin_whop_refund_items: many(admin_whop_refund_items),
}));

export const admin_whop_refund_itemsRelations = relations(admin_whop_refund_items, ({one}) => ({
	admin_whop_refund_batch: one(admin_whop_refund_batches, {
		fields: [admin_whop_refund_items.batch_id],
		references: [admin_whop_refund_batches.id]
	}),
}));

export const discord_notification_channel_settingsRelations = relations(discord_notification_channel_settings, ({one}) => ({
	discord_notification_guild: one(discord_notification_guilds, {
		fields: [discord_notification_channel_settings.guild_id],
		references: [discord_notification_guilds.guild_id]
	}),
	discord_notification_channel: one(discord_notification_channels, {
		fields: [discord_notification_channel_settings.guild_id],
		references: [discord_notification_channels.guild_id]
	}),
	admin_user: one(admin_users, {
		fields: [discord_notification_channel_settings.updated_by],
		references: [admin_users.id]
	}),
}));

export const discord_notification_guildsRelations = relations(discord_notification_guilds, ({many}) => ({
	discord_notification_channel_settings: many(discord_notification_channel_settings),
	discord_notification_channels: many(discord_notification_channels),
}));

export const discord_notification_channel_jobsRelations = relations(discord_notification_channel_jobs, ({one}) => ({
	admin_user: one(admin_users, {
		fields: [discord_notification_channel_jobs.created_by],
		references: [admin_users.id]
	}),
	discord_notification_channel: one(discord_notification_channels, {
		fields: [discord_notification_channel_jobs.guild_id],
		references: [discord_notification_channels.guild_id]
	}),
}));

export const discord_creator_deposit_jobsRelations = relations(discord_creator_deposit_jobs, ({one}) => ({
	discord_creator_setup: one(discord_creator_setups, {
		fields: [discord_creator_deposit_jobs.setup_id],
		references: [discord_creator_setups.id]
	}),
}));

export const antifraud_security_audit_eventsRelations = relations(antifraud_security_audit_events, ({one}) => ({
	admin_user: one(admin_users, {
		fields: [antifraud_security_audit_events.actor_admin_user_id],
		references: [admin_users.id]
	}),
}));

export const antifraud_review_reminder_stateRelations = relations(antifraud_review_reminder_state, ({one}) => ({
	antifraud_review: one(antifraud_reviews, {
		fields: [antifraud_review_reminder_state.review_id],
		references: [antifraud_reviews.id]
	}),
}));

export const antifraud_review_workflowRelations = relations(antifraud_review_workflow, ({one}) => ({
	admin_user: one(admin_users, {
		fields: [antifraud_review_workflow.postponed_by],
		references: [admin_users.id]
	}),
	antifraud_review: one(antifraud_reviews, {
		fields: [antifraud_review_workflow.review_id],
		references: [antifraud_reviews.id]
	}),
}));

export const pack_build_draft_revisionsRelations = relations(pack_build_draft_revisions, ({one}) => ({
	admin_user: one(admin_users, {
		fields: [pack_build_draft_revisions.changed_by],
		references: [admin_users.id]
	}),
	pack_creation_request: one(pack_creation_requests, {
		fields: [pack_build_draft_revisions.request_id],
		references: [pack_creation_requests.id]
	}),
}));

export const discord_creator_signup_jobsRelations = relations(discord_creator_signup_jobs, ({one}) => ({
	discord_creator_setup: one(discord_creator_setups, {
		fields: [discord_creator_signup_jobs.setup_id],
		references: [discord_creator_setups.id]
	}),
}));

export const admin_fiat_credit_reviewsRelations = relations(admin_fiat_credit_reviews, ({one}) => ({
	admin_user_decided_by: one(admin_users, {
		fields: [admin_fiat_credit_reviews.decided_by],
		references: [admin_users.id],
		relationName: "admin_fiat_credit_reviews_decided_by_admin_users_id"
	}),
	admin_user_resolution_requested_by: one(admin_users, {
		fields: [admin_fiat_credit_reviews.resolution_requested_by],
		references: [admin_users.id],
		relationName: "admin_fiat_credit_reviews_resolution_requested_by_admin_users_id"
	}),
	admin_user_resolved_by: one(admin_users, {
		fields: [admin_fiat_credit_reviews.resolved_by],
		references: [admin_users.id],
		relationName: "admin_fiat_credit_reviews_resolved_by_admin_users_id"
	}),
}));

export const antifraud_signalsRelations = relations(antifraud_signals, ({one}) => ({
	antifraud_review: one(antifraud_reviews, {
		fields: [antifraud_signals.review_id],
		references: [antifraud_reviews.id]
	}),
}));

export const creator_agreement_documentsRelations = relations(creator_agreement_documents, ({one, many}) => ({
	admin_user_created_by: one(admin_users, {
		fields: [creator_agreement_documents.created_by],
		references: [admin_users.id],
		relationName: "creator_agreement_documents_created_by_admin_users_id"
	}),
	admin_user_published_by: one(admin_users, {
		fields: [creator_agreement_documents.published_by],
		references: [admin_users.id],
		relationName: "creator_agreement_documents_published_by_admin_users_id"
	}),
	creator_deal_approval_requests: many(creator_deal_approval_requests),
	creator_agreement_lines: many(creator_agreement_lines),
}));

export const creator_deal_approval_eventsRelations = relations(creator_deal_approval_events, ({one}) => ({
	admin_user: one(admin_users, {
		fields: [creator_deal_approval_events.actor_admin_user_id],
		references: [admin_users.id]
	}),
	creator_deal_approval_request: one(creator_deal_approval_requests, {
		fields: [creator_deal_approval_events.request_id],
		references: [creator_deal_approval_requests.id]
	}),
}));

export const creator_agreement_linesRelations = relations(creator_agreement_lines, ({one}) => ({
	creator_agreement_document: one(creator_agreement_documents, {
		fields: [creator_agreement_lines.document_id],
		references: [creator_agreement_documents.id]
	}),
}));

export const discord_notification_channel_mentionsRelations = relations(discord_notification_channel_mentions, ({one}) => ({
	discord_notification_channel: one(discord_notification_channels, {
		fields: [discord_notification_channel_mentions.guild_id],
		references: [discord_notification_channels.guild_id]
	}),
	admin_user: one(admin_users, {
		fields: [discord_notification_channel_mentions.created_by],
		references: [admin_users.id]
	}),
}));

export const discord_partnership_transcript_messagesRelations = relations(discord_partnership_transcript_messages, ({one}) => ({
	discord_partnership_transcript: one(discord_partnership_transcripts, {
		fields: [discord_partnership_transcript_messages.transcript_id],
		references: [discord_partnership_transcripts.id]
	}),
}));