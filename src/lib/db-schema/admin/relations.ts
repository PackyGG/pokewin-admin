import { relations } from "drizzle-orm/relations";
import { admin_users, admin_giveaway_actions, admin_roles, admin_sessions, admin_notes, admin_audit_events, admin_gift_card_actions, admin_voucher_actions, expenses, recurring_expenses, admin_shifts, admin_shift_assignments, salary_employees, salary_payouts, excluded_users, employee_workspaces, employee_board_placements, employee_managers, employee_manager_workspaces, salary_payments, admin_user_tags, admin_excluded_user_balance_v2, roadmap_items, roadmap_detail_fields, roadmap_links, roadmap_linear_links, admin_passkeys, admin_withdrawal_unlocks, creator_reward_programs, creator_reward_program_windows, creator_reward_claims, chat_raffle_rounds, chat_raffle_prizes, chat_raffle_entries, chat_raffle_adjustments, staff_profiles, staff_point_events, staff_notifications, staff_notification_channels, staff_notification_prefs, staff_quizzes, staff_quiz_questions, staff_quiz_options, staff_quiz_attempts, staff_quiz_answers, antifraud_reviews, antifraud_review_notes, antifraud_signals } from "./schema";

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
	chat_raffle_rounds_drawn_by: many(chat_raffle_rounds, {
		relationName: "chat_raffle_rounds_drawn_by_admin_users_id"
	}),
	chat_raffle_rounds_created_by: many(chat_raffle_rounds, {
		relationName: "chat_raffle_rounds_created_by_admin_users_id"
	}),
	chat_raffle_prizes: many(chat_raffle_prizes),
	chat_raffle_adjustments: many(chat_raffle_adjustments),
	staff_profiles: many(staff_profiles),
	staff_point_events: many(staff_point_events),
	staff_notifications: many(staff_notifications),
	staff_notification_channels: many(staff_notification_channels),
	staff_notification_prefs: many(staff_notification_prefs),
	staff_quiz_attempts: many(staff_quiz_attempts),
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
	admin_shift: one(admin_shifts, {
		fields: [admin_shift_assignments.shift_id],
		references: [admin_shifts.id]
	}),
	admin_user: one(admin_users, {
		fields: [admin_shift_assignments.admin_user_id],
		references: [admin_users.id]
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

export const admin_excluded_user_balance_v2Relations = relations(admin_excluded_user_balance_v2, ({one}) => ({
	admin_user: one(admin_users, {
		fields: [admin_excluded_user_balance_v2.set_by_admin_id],
		references: [admin_users.id]
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

export const creator_reward_programsRelations = relations(creator_reward_programs, ({many}) => ({
	creator_reward_program_windows: many(creator_reward_program_windows),
	creator_reward_claims: many(creator_reward_claims),
}));

export const creator_reward_claimsRelations = relations(creator_reward_claims, ({one}) => ({
	creator_reward_program: one(creator_reward_programs, {
		fields: [creator_reward_claims.program_id],
		references: [creator_reward_programs.id]
	}),
}));

export const chat_raffle_roundsRelations = relations(chat_raffle_rounds, ({one, many}) => ({
	admin_user_drawn_by: one(admin_users, {
		fields: [chat_raffle_rounds.drawn_by],
		references: [admin_users.id],
		relationName: "chat_raffle_rounds_drawn_by_admin_users_id"
	}),
	admin_user_created_by: one(admin_users, {
		fields: [chat_raffle_rounds.created_by],
		references: [admin_users.id],
		relationName: "chat_raffle_rounds_created_by_admin_users_id"
	}),
	chat_raffle_prizes: many(chat_raffle_prizes),
	chat_raffle_entries: many(chat_raffle_entries),
	chat_raffle_adjustments: many(chat_raffle_adjustments),
}));

export const chat_raffle_prizesRelations = relations(chat_raffle_prizes, ({one}) => ({
	chat_raffle_round: one(chat_raffle_rounds, {
		fields: [chat_raffle_prizes.round_id],
		references: [chat_raffle_rounds.id]
	}),
	admin_user: one(admin_users, {
		fields: [chat_raffle_prizes.paid_by],
		references: [admin_users.id]
	}),
}));

export const chat_raffle_entriesRelations = relations(chat_raffle_entries, ({one}) => ({
	chat_raffle_round: one(chat_raffle_rounds, {
		fields: [chat_raffle_entries.round_id],
		references: [chat_raffle_rounds.id]
	}),
}));

export const chat_raffle_adjustmentsRelations = relations(chat_raffle_adjustments, ({one}) => ({
	chat_raffle_round: one(chat_raffle_rounds, {
		fields: [chat_raffle_adjustments.round_id],
		references: [chat_raffle_rounds.id]
	}),
	admin_user: one(admin_users, {
		fields: [chat_raffle_adjustments.created_by],
		references: [admin_users.id]
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
	staff_quizz: one(staff_quizzes, {
		fields: [staff_quiz_attempts.quiz_id],
		references: [staff_quizzes.id]
	}),
	admin_user: one(admin_users, {
		fields: [staff_quiz_attempts.admin_user_id],
		references: [admin_users.id]
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
	antifraud_signals: many(antifraud_signals),
}));

export const antifraud_signalsRelations = relations(antifraud_signals, ({one}) => ({
	antifraud_review: one(antifraud_reviews, {
		fields: [antifraud_signals.review_id],
		references: [antifraud_reviews.id]
	}),
}));