import { relations } from "drizzle-orm/relations";
import { user, affiliate_code_queue, battles, deposit_addresses, vaults, provably_fair_results, game_sessions, user_inventory, shipping_addresses, affiliate_leaderboards, affiliate_leaderboard_prize_tiers, creator_deals, creator_stream_sessions, ledger_transactions, chat_messages, pinned_chat_messages, creator_multiplier_deals, upgrader_games, cards, user_wager_requirements, affiliate_codes, challenges, challenge_claims, affiliate_payouts, challenge_requirements, balances, active_seeds, affiliate_accounts, audit_events, account, card_withdrawal_requests, fingerprints, gift_cards, pack_cards, packs, creator_withdrawal_limits, pack_favorites, rains, race_leaderboard_snapshots, race_claims, raffles, rain_entries, rain_tips, promo_code_redemptions, promo_codes, two_factor, user_feature_locks, user_mutes, seed_rotation_history, user_packs, rewards, user_rewards, session, wager_period_snapshots, creator_session_pending_conversions, affiliate_leaderboard_snapshots, raffle_entries, vouchers, battle_participants, bots, affiliate_leaderboard_claims, creator_socials, leaderboard_funding_addresses, user_battle_limits, rakeback_claims, upgrader_output_cards, affiliate_leaderboard_claim_holds, user_statistics, race_claim_holds, coin_transactions, affiliate_code_usages, battle_double_down_offers, notifications, keno_games, user_kyc, fiat_deposit_intents, payment_provider_fees, announcements, announcement_reads } from "./schema";

export const affiliate_code_queueRelations = relations(affiliate_code_queue, ({one}) => ({
	user: one(user, {
		fields: [affiliate_code_queue.user_id],
		references: [user.id]
	}),
}));

export const userRelations = relations(user, ({many}) => ({
	affiliate_code_queues: many(affiliate_code_queue),
	battles: many(battles),
	deposit_addresses: many(deposit_addresses),
	shipping_addresses: many(shipping_addresses),
	creator_stream_sessions: many(creator_stream_sessions),
	creator_deals_user_id: many(creator_deals, {
		relationName: "creator_deals_user_id_user_id"
	}),
	creator_deals_created_by: many(creator_deals, {
		relationName: "creator_deals_created_by_user_id"
	}),
	pinned_chat_messages: many(pinned_chat_messages),
	creator_multiplier_deals_user_id: many(creator_multiplier_deals, {
		relationName: "creator_multiplier_deals_user_id_user_id"
	}),
	creator_multiplier_deals_reviewed_by: many(creator_multiplier_deals, {
		relationName: "creator_multiplier_deals_reviewed_by_user_id"
	}),
	creator_multiplier_deals_created_by: many(creator_multiplier_deals, {
		relationName: "creator_multiplier_deals_created_by_user_id"
	}),
	upgrader_games: many(upgrader_games),
	user_wager_requirements: many(user_wager_requirements),
	game_sessions: many(game_sessions),
	affiliate_codes: many(affiliate_codes),
	challenge_claims: many(challenge_claims),
	affiliate_payouts: many(affiliate_payouts),
	balances: many(balances),
	active_seeds: many(active_seeds),
	affiliate_accounts: many(affiliate_accounts),
	audit_events: many(audit_events),
	accounts: many(account),
	card_withdrawal_requests_confirmed_by: many(card_withdrawal_requests, {
		relationName: "card_withdrawal_requests_confirmed_by_user_id"
	}),
	card_withdrawal_requests_processed_by: many(card_withdrawal_requests, {
		relationName: "card_withdrawal_requests_processed_by_user_id"
	}),
	card_withdrawal_requests_shipped_by: many(card_withdrawal_requests, {
		relationName: "card_withdrawal_requests_shipped_by_user_id"
	}),
	card_withdrawal_requests_user_id: many(card_withdrawal_requests, {
		relationName: "card_withdrawal_requests_user_id_user_id"
	}),
	fingerprints: many(fingerprints),
	gift_cards: many(gift_cards),
	ledger_transactions: many(ledger_transactions),
	creator_withdrawal_limits: many(creator_withdrawal_limits),
	pack_favorites: many(pack_favorites),
	rains: many(rains),
	race_leaderboard_snapshots: many(race_leaderboard_snapshots),
	race_claims: many(race_claims),
	raffles: many(raffles),
	rain_entries: many(rain_entries),
	rain_tips: many(rain_tips),
	promo_code_redemptions: many(promo_code_redemptions),
	two_factors: many(two_factor),
	user_feature_locks_locked_deposits_by: many(user_feature_locks, {
		relationName: "user_feature_locks_locked_deposits_by_user_id"
	}),
	user_feature_locks_locked_exchanges_by: many(user_feature_locks, {
		relationName: "user_feature_locks_locked_exchanges_by_user_id"
	}),
	user_feature_locks_locked_inventory_sales_by: many(user_feature_locks, {
		relationName: "user_feature_locks_locked_inventory_sales_by_user_id"
	}),
	user_feature_locks_locked_openings_by: many(user_feature_locks, {
		relationName: "user_feature_locks_locked_openings_by_user_id"
	}),
	user_feature_locks_locked_vault_by: many(user_feature_locks, {
		relationName: "user_feature_locks_locked_vault_by_user_id"
	}),
	user_feature_locks_locked_withdrawals_by: many(user_feature_locks, {
		relationName: "user_feature_locks_locked_withdrawals_by_user_id"
	}),
	user_feature_locks_user_id: many(user_feature_locks, {
		relationName: "user_feature_locks_user_id_user_id"
	}),
	vaults: many(vaults),
	user_mutes_muted_by: many(user_mutes, {
		relationName: "user_mutes_muted_by_user_id"
	}),
	user_mutes_unmuted_by: many(user_mutes, {
		relationName: "user_mutes_unmuted_by_user_id"
	}),
	user_mutes_user_id: many(user_mutes, {
		relationName: "user_mutes_user_id_user_id"
	}),
	seed_rotation_histories: many(seed_rotation_history),
	user_packs: many(user_packs),
	user_rewards: many(user_rewards),
	sessions: many(session),
	wager_period_snapshots: many(wager_period_snapshots),
	creator_session_pending_conversions: many(creator_session_pending_conversions),
	affiliate_leaderboard_snapshots: many(affiliate_leaderboard_snapshots),
	affiliate_leaderboards: many(affiliate_leaderboards),
	raffle_entries: many(raffle_entries),
	vouchers: many(vouchers),
	battle_participants: many(battle_participants),
	affiliate_leaderboard_claims: many(affiliate_leaderboard_claims),
	creator_socials_user_id: many(creator_socials, {
		relationName: "creator_socials_user_id_user_id"
	}),
	creator_socials_reviewed_by: many(creator_socials, {
		relationName: "creator_socials_reviewed_by_user_id"
	}),
	leaderboard_funding_addresses: many(leaderboard_funding_addresses),
	chat_messages_deleted_by: many(chat_messages, {
		relationName: "chat_messages_deleted_by_user_id"
	}),
	chat_messages_user_id: many(chat_messages, {
		relationName: "chat_messages_user_id_user_id"
	}),
	user_inventories: many(user_inventory),
	user_battle_limits: many(user_battle_limits),
	rakeback_claims: many(rakeback_claims),
	affiliate_leaderboard_claim_holds: many(affiliate_leaderboard_claim_holds),
	user_statistics: many(user_statistics),
	race_claim_holds: many(race_claim_holds),
	coin_transactions: many(coin_transactions),
	affiliate_code_usages_affiliate_user_id: many(affiliate_code_usages, {
		relationName: "affiliate_code_usages_affiliate_user_id_user_id"
	}),
	affiliate_code_usages_referred_user_id: many(affiliate_code_usages, {
		relationName: "affiliate_code_usages_referred_user_id_user_id"
	}),
	challenges: many(challenges),
	battle_double_down_offers: many(battle_double_down_offers),
	notifications: many(notifications),
	keno_games: many(keno_games),
	user_kycs: many(user_kyc),
	fiat_deposit_intents: many(fiat_deposit_intents),
	announcement_reads: many(announcement_reads),
}));

export const battlesRelations = relations(battles, ({one, many}) => ({
	user: one(user, {
		fields: [battles.user_id],
		references: [user.id]
	}),
	provably_fair_results: many(provably_fair_results),
	battle_participants: many(battle_participants),
	chat_messages: many(chat_messages),
	battle_double_down_offers: many(battle_double_down_offers),
}));

export const deposit_addressesRelations = relations(deposit_addresses, ({one, many}) => ({
	user: one(user, {
		fields: [deposit_addresses.user_id],
		references: [user.id]
	}),
	vault: one(vaults, {
		fields: [deposit_addresses.vault_id],
		references: [vaults.id]
	}),
	ledger_transactions: many(ledger_transactions),
}));

export const vaultsRelations = relations(vaults, ({one, many}) => ({
	deposit_addresses: many(deposit_addresses),
	user: one(user, {
		fields: [vaults.user_id],
		references: [user.id]
	}),
	leaderboard_funding_addresses: many(leaderboard_funding_addresses),
}));

export const provably_fair_resultsRelations = relations(provably_fair_results, ({one}) => ({
	battle: one(battles, {
		fields: [provably_fair_results.battle_id],
		references: [battles.id]
	}),
	game_session: one(game_sessions, {
		fields: [provably_fair_results.game_session_id],
		references: [game_sessions.id]
	}),
	user_inventory: one(user_inventory, {
		fields: [provably_fair_results.inventory_item_id],
		references: [user_inventory.id]
	}),
}));

export const game_sessionsRelations = relations(game_sessions, ({one, many}) => ({
	provably_fair_results: many(provably_fair_results),
	ledger_transaction: one(ledger_transactions, {
		fields: [game_sessions.bet_ledger_tx_id],
		references: [ledger_transactions.id],
		relationName: "game_sessions_bet_ledger_tx_id_ledger_transactions_id"
	}),
	user: one(user, {
		fields: [game_sessions.user_id],
		references: [user.id]
	}),
	ledger_transactions: many(ledger_transactions, {
		relationName: "ledger_transactions_game_session_id_game_sessions_id"
	}),
	battle_participants: many(battle_participants),
	coin_transactions: many(coin_transactions),
	affiliate_code_usages: many(affiliate_code_usages),
	battle_double_down_offers: many(battle_double_down_offers),
}));

export const user_inventoryRelations = relations(user_inventory, ({one, many}) => ({
	provably_fair_results: many(provably_fair_results),
	user: one(user, {
		fields: [user_inventory.user_id],
		references: [user.id]
	}),
}));

export const shipping_addressesRelations = relations(shipping_addresses, ({one}) => ({
	user: one(user, {
		fields: [shipping_addresses.user_id],
		references: [user.id]
	}),
}));

export const affiliate_leaderboard_prize_tiersRelations = relations(affiliate_leaderboard_prize_tiers, ({one}) => ({
	affiliate_leaderboard: one(affiliate_leaderboards, {
		fields: [affiliate_leaderboard_prize_tiers.leaderboard_id],
		references: [affiliate_leaderboards.id]
	}),
}));

export const affiliate_leaderboardsRelations = relations(affiliate_leaderboards, ({one, many}) => ({
	affiliate_leaderboard_prize_tiers: many(affiliate_leaderboard_prize_tiers),
	affiliate_leaderboard_snapshots: many(affiliate_leaderboard_snapshots),
	user: one(user, {
		fields: [affiliate_leaderboards.creator_user_id],
		references: [user.id]
	}),
	affiliate_leaderboard_claims: many(affiliate_leaderboard_claims),
	leaderboard_funding_addresses: many(leaderboard_funding_addresses),
	affiliate_leaderboard_claim_holds: many(affiliate_leaderboard_claim_holds),
}));

export const creator_stream_sessionsRelations = relations(creator_stream_sessions, ({one, many}) => ({
	creator_deal: one(creator_deals, {
		fields: [creator_stream_sessions.deal_id],
		references: [creator_deals.id]
	}),
	user: one(user, {
		fields: [creator_stream_sessions.user_id],
		references: [user.id]
	}),
	ledger_transaction_activation_ledger_id: one(ledger_transactions, {
		fields: [creator_stream_sessions.activation_ledger_id],
		references: [ledger_transactions.id],
		relationName: "creator_stream_sessions_activation_ledger_id_ledger_transactions_id"
	}),
	ledger_transaction_conversion_ledger_id: one(ledger_transactions, {
		fields: [creator_stream_sessions.conversion_ledger_id],
		references: [ledger_transactions.id],
		relationName: "creator_stream_sessions_conversion_ledger_id_ledger_transactions_id"
	}),
	balances: many(balances),
	creator_session_pending_conversions: many(creator_session_pending_conversions),
	battle_participants: many(battle_participants),
}));

export const creator_dealsRelations = relations(creator_deals, ({one, many}) => ({
	creator_stream_sessions: many(creator_stream_sessions),
	user_user_id: one(user, {
		fields: [creator_deals.user_id],
		references: [user.id],
		relationName: "creator_deals_user_id_user_id"
	}),
	user_created_by: one(user, {
		fields: [creator_deals.created_by],
		references: [user.id],
		relationName: "creator_deals_created_by_user_id"
	}),
	creator_session_pending_conversions: many(creator_session_pending_conversions),
}));

export const ledger_transactionsRelations = relations(ledger_transactions, ({one, many}) => ({
	creator_stream_sessions_activation_ledger_id: many(creator_stream_sessions, {
		relationName: "creator_stream_sessions_activation_ledger_id_ledger_transactions_id"
	}),
	creator_stream_sessions_conversion_ledger_id: many(creator_stream_sessions, {
		relationName: "creator_stream_sessions_conversion_ledger_id_ledger_transactions_id"
	}),
	creator_multiplier_deals_deposit_ledger_id: many(creator_multiplier_deals, {
		relationName: "creator_multiplier_deals_deposit_ledger_id_ledger_transactions_id"
	}),
	creator_multiplier_deals_settlement_ledger_id: many(creator_multiplier_deals, {
		relationName: "creator_multiplier_deals_settlement_ledger_id_ledger_transactions_id"
	}),
	game_sessions: many(game_sessions, {
		relationName: "game_sessions_bet_ledger_tx_id_ledger_transactions_id"
	}),
	challenge_claims: many(challenge_claims),
	balances: many(balances),
	gift_cards: many(gift_cards),
	deposit_address: one(deposit_addresses, {
		fields: [ledger_transactions.deposit_address_id],
		references: [deposit_addresses.id]
	}),
	game_session: one(game_sessions, {
		fields: [ledger_transactions.game_session_id],
		references: [game_sessions.id],
		relationName: "ledger_transactions_game_session_id_game_sessions_id"
	}),
	user: one(user, {
		fields: [ledger_transactions.user_id],
		references: [user.id]
	}),
	race_claims: many(race_claims),
	promo_code_redemptions: many(promo_code_redemptions),
	creator_session_pending_conversions: many(creator_session_pending_conversions),
	rakeback_claims: many(rakeback_claims),
	fiat_deposit_intents: many(fiat_deposit_intents),
}));

export const pinned_chat_messagesRelations = relations(pinned_chat_messages, ({one}) => ({
	chat_message: one(chat_messages, {
		fields: [pinned_chat_messages.message_id],
		references: [chat_messages.id]
	}),
	user: one(user, {
		fields: [pinned_chat_messages.pinned_by],
		references: [user.id]
	}),
}));

export const chat_messagesRelations = relations(chat_messages, ({one, many}) => ({
	pinned_chat_messages: many(pinned_chat_messages),
	chat_message: one(chat_messages, {
		fields: [chat_messages.reply_to_id],
		references: [chat_messages.id],
		relationName: "chat_messages_reply_to_id_chat_messages_id"
	}),
	chat_messages: many(chat_messages, {
		relationName: "chat_messages_reply_to_id_chat_messages_id"
	}),
	battle: one(battles, {
		fields: [chat_messages.embed_battle_id],
		references: [battles.id]
	}),
	user_deleted_by: one(user, {
		fields: [chat_messages.deleted_by],
		references: [user.id],
		relationName: "chat_messages_deleted_by_user_id"
	}),
	user_user_id: one(user, {
		fields: [chat_messages.user_id],
		references: [user.id],
		relationName: "chat_messages_user_id_user_id"
	}),
}));

export const creator_multiplier_dealsRelations = relations(creator_multiplier_deals, ({one}) => ({
	user_user_id: one(user, {
		fields: [creator_multiplier_deals.user_id],
		references: [user.id],
		relationName: "creator_multiplier_deals_user_id_user_id"
	}),
	user_reviewed_by: one(user, {
		fields: [creator_multiplier_deals.reviewed_by],
		references: [user.id],
		relationName: "creator_multiplier_deals_reviewed_by_user_id"
	}),
	ledger_transaction_deposit_ledger_id: one(ledger_transactions, {
		fields: [creator_multiplier_deals.deposit_ledger_id],
		references: [ledger_transactions.id],
		relationName: "creator_multiplier_deals_deposit_ledger_id_ledger_transactions_id"
	}),
	ledger_transaction_settlement_ledger_id: one(ledger_transactions, {
		fields: [creator_multiplier_deals.settlement_ledger_id],
		references: [ledger_transactions.id],
		relationName: "creator_multiplier_deals_settlement_ledger_id_ledger_transactions_id"
	}),
	user_created_by: one(user, {
		fields: [creator_multiplier_deals.created_by],
		references: [user.id],
		relationName: "creator_multiplier_deals_created_by_user_id"
	}),
}));

export const upgrader_gamesRelations = relations(upgrader_games, ({one}) => ({
	user: one(user, {
		fields: [upgrader_games.user_id],
		references: [user.id]
	}),
	card: one(cards, {
		fields: [upgrader_games.target_card_id],
		references: [cards.id]
	}),
}));

export const cardsRelations = relations(cards, ({many}) => ({
	upgrader_games: many(upgrader_games),
	pack_cards: many(pack_cards),
	upgrader_output_cards: many(upgrader_output_cards),
}));

export const user_wager_requirementsRelations = relations(user_wager_requirements, ({one}) => ({
	user: one(user, {
		fields: [user_wager_requirements.user_id],
		references: [user.id]
	}),
}));

export const affiliate_codesRelations = relations(affiliate_codes, ({one}) => ({
	user: one(user, {
		fields: [affiliate_codes.user_id],
		references: [user.id]
	}),
}));

export const challenge_claimsRelations = relations(challenge_claims, ({one}) => ({
	challenge: one(challenges, {
		fields: [challenge_claims.challenge_id],
		references: [challenges.id]
	}),
	user: one(user, {
		fields: [challenge_claims.user_id],
		references: [user.id]
	}),
	ledger_transaction: one(ledger_transactions, {
		fields: [challenge_claims.prize_ledger_id],
		references: [ledger_transactions.id]
	}),
}));

export const challengesRelations = relations(challenges, ({one, many}) => ({
	challenge_claims: many(challenge_claims),
	challenge_requirements: many(challenge_requirements),
	user: one(user, {
		fields: [challenges.created_by],
		references: [user.id]
	}),
}));

export const affiliate_payoutsRelations = relations(affiliate_payouts, ({one}) => ({
	user: one(user, {
		fields: [affiliate_payouts.affiliate_user_id],
		references: [user.id]
	}),
}));

export const challenge_requirementsRelations = relations(challenge_requirements, ({one}) => ({
	challenge: one(challenges, {
		fields: [challenge_requirements.challenge_id],
		references: [challenges.id]
	}),
}));

export const balancesRelations = relations(balances, ({one}) => ({
	creator_stream_session: one(creator_stream_sessions, {
		fields: [balances.active_stream_session_id],
		references: [creator_stream_sessions.id]
	}),
	ledger_transaction: one(ledger_transactions, {
		fields: [balances.last_transaction_id],
		references: [ledger_transactions.id]
	}),
	user: one(user, {
		fields: [balances.user_id],
		references: [user.id]
	}),
}));

export const active_seedsRelations = relations(active_seeds, ({one}) => ({
	user: one(user, {
		fields: [active_seeds.user_id],
		references: [user.id]
	}),
}));

export const affiliate_accountsRelations = relations(affiliate_accounts, ({one}) => ({
	user: one(user, {
		fields: [affiliate_accounts.user_id],
		references: [user.id]
	}),
}));

export const audit_eventsRelations = relations(audit_events, ({one}) => ({
	user: one(user, {
		fields: [audit_events.user_id],
		references: [user.id]
	}),
}));

export const accountRelations = relations(account, ({one}) => ({
	user: one(user, {
		fields: [account.userId],
		references: [user.id]
	}),
}));

export const card_withdrawal_requestsRelations = relations(card_withdrawal_requests, ({one}) => ({
	user_confirmed_by: one(user, {
		fields: [card_withdrawal_requests.confirmed_by],
		references: [user.id],
		relationName: "card_withdrawal_requests_confirmed_by_user_id"
	}),
	user_processed_by: one(user, {
		fields: [card_withdrawal_requests.processed_by],
		references: [user.id],
		relationName: "card_withdrawal_requests_processed_by_user_id"
	}),
	user_shipped_by: one(user, {
		fields: [card_withdrawal_requests.shipped_by],
		references: [user.id],
		relationName: "card_withdrawal_requests_shipped_by_user_id"
	}),
	user_user_id: one(user, {
		fields: [card_withdrawal_requests.user_id],
		references: [user.id],
		relationName: "card_withdrawal_requests_user_id_user_id"
	}),
}));

export const fingerprintsRelations = relations(fingerprints, ({one}) => ({
	user: one(user, {
		fields: [fingerprints.user_id],
		references: [user.id]
	}),
}));

export const gift_cardsRelations = relations(gift_cards, ({one}) => ({
	ledger_transaction: one(ledger_transactions, {
		fields: [gift_cards.ledger_tx_id],
		references: [ledger_transactions.id]
	}),
	user: one(user, {
		fields: [gift_cards.redeemed_by_user_id],
		references: [user.id]
	}),
}));

export const pack_cardsRelations = relations(pack_cards, ({one}) => ({
	card: one(cards, {
		fields: [pack_cards.card_id],
		references: [cards.id]
	}),
	pack: one(packs, {
		fields: [pack_cards.pack_id],
		references: [packs.id]
	}),
}));

export const packsRelations = relations(packs, ({many}) => ({
	pack_cards: many(pack_cards),
	pack_favorites: many(pack_favorites),
	user_packs: many(user_packs),
}));

export const creator_withdrawal_limitsRelations = relations(creator_withdrawal_limits, ({one}) => ({
	user: one(user, {
		fields: [creator_withdrawal_limits.user_id],
		references: [user.id]
	}),
}));

export const pack_favoritesRelations = relations(pack_favorites, ({one}) => ({
	pack: one(packs, {
		fields: [pack_favorites.pack_id],
		references: [packs.id]
	}),
	user: one(user, {
		fields: [pack_favorites.user_id],
		references: [user.id]
	}),
}));

export const rainsRelations = relations(rains, ({one, many}) => ({
	user: one(user, {
		fields: [rains.winner_user_id],
		references: [user.id]
	}),
	rain_entries: many(rain_entries),
	rain_tips: many(rain_tips),
}));

export const race_leaderboard_snapshotsRelations = relations(race_leaderboard_snapshots, ({one}) => ({
	user: one(user, {
		fields: [race_leaderboard_snapshots.user_id],
		references: [user.id]
	}),
}));

export const race_claimsRelations = relations(race_claims, ({one}) => ({
	ledger_transaction: one(ledger_transactions, {
		fields: [race_claims.ledger_tx_id],
		references: [ledger_transactions.id]
	}),
	user: one(user, {
		fields: [race_claims.user_id],
		references: [user.id]
	}),
}));

export const rafflesRelations = relations(raffles, ({one, many}) => ({
	user: one(user, {
		fields: [raffles.winner_user_id],
		references: [user.id]
	}),
	raffle_entries: many(raffle_entries),
}));

export const rain_entriesRelations = relations(rain_entries, ({one}) => ({
	rain: one(rains, {
		fields: [rain_entries.rain_id],
		references: [rains.id]
	}),
	user: one(user, {
		fields: [rain_entries.user_id],
		references: [user.id]
	}),
}));

export const rain_tipsRelations = relations(rain_tips, ({one}) => ({
	rain: one(rains, {
		fields: [rain_tips.rain_id],
		references: [rains.id]
	}),
	user: one(user, {
		fields: [rain_tips.user_id],
		references: [user.id]
	}),
}));

export const promo_code_redemptionsRelations = relations(promo_code_redemptions, ({one}) => ({
	ledger_transaction: one(ledger_transactions, {
		fields: [promo_code_redemptions.ledger_tx_id],
		references: [ledger_transactions.id]
	}),
	promo_code: one(promo_codes, {
		fields: [promo_code_redemptions.promo_code_id],
		references: [promo_codes.id]
	}),
	user: one(user, {
		fields: [promo_code_redemptions.user_id],
		references: [user.id]
	}),
}));

export const promo_codesRelations = relations(promo_codes, ({many}) => ({
	promo_code_redemptions: many(promo_code_redemptions),
}));

export const two_factorRelations = relations(two_factor, ({one}) => ({
	user: one(user, {
		fields: [two_factor.user_id],
		references: [user.id]
	}),
}));

export const user_feature_locksRelations = relations(user_feature_locks, ({one}) => ({
	user_locked_deposits_by: one(user, {
		fields: [user_feature_locks.locked_deposits_by],
		references: [user.id],
		relationName: "user_feature_locks_locked_deposits_by_user_id"
	}),
	user_locked_exchanges_by: one(user, {
		fields: [user_feature_locks.locked_exchanges_by],
		references: [user.id],
		relationName: "user_feature_locks_locked_exchanges_by_user_id"
	}),
	user_locked_inventory_sales_by: one(user, {
		fields: [user_feature_locks.locked_inventory_sales_by],
		references: [user.id],
		relationName: "user_feature_locks_locked_inventory_sales_by_user_id"
	}),
	user_locked_openings_by: one(user, {
		fields: [user_feature_locks.locked_openings_by],
		references: [user.id],
		relationName: "user_feature_locks_locked_openings_by_user_id"
	}),
	user_locked_vault_by: one(user, {
		fields: [user_feature_locks.locked_vault_by],
		references: [user.id],
		relationName: "user_feature_locks_locked_vault_by_user_id"
	}),
	user_locked_withdrawals_by: one(user, {
		fields: [user_feature_locks.locked_withdrawals_by],
		references: [user.id],
		relationName: "user_feature_locks_locked_withdrawals_by_user_id"
	}),
	user_user_id: one(user, {
		fields: [user_feature_locks.user_id],
		references: [user.id],
		relationName: "user_feature_locks_user_id_user_id"
	}),
}));

export const user_mutesRelations = relations(user_mutes, ({one}) => ({
	user_muted_by: one(user, {
		fields: [user_mutes.muted_by],
		references: [user.id],
		relationName: "user_mutes_muted_by_user_id"
	}),
	user_unmuted_by: one(user, {
		fields: [user_mutes.unmuted_by],
		references: [user.id],
		relationName: "user_mutes_unmuted_by_user_id"
	}),
	user_user_id: one(user, {
		fields: [user_mutes.user_id],
		references: [user.id],
		relationName: "user_mutes_user_id_user_id"
	}),
}));

export const seed_rotation_historyRelations = relations(seed_rotation_history, ({one}) => ({
	user: one(user, {
		fields: [seed_rotation_history.user_id],
		references: [user.id]
	}),
}));

export const user_packsRelations = relations(user_packs, ({one}) => ({
	pack: one(packs, {
		fields: [user_packs.pack_id],
		references: [packs.id]
	}),
	user: one(user, {
		fields: [user_packs.user_id],
		references: [user.id]
	}),
}));

export const user_rewardsRelations = relations(user_rewards, ({one}) => ({
	reward: one(rewards, {
		fields: [user_rewards.reward_id],
		references: [rewards.id]
	}),
	user: one(user, {
		fields: [user_rewards.user_id],
		references: [user.id]
	}),
}));

export const rewardsRelations = relations(rewards, ({many}) => ({
	user_rewards: many(user_rewards),
}));

export const sessionRelations = relations(session, ({one}) => ({
	user: one(user, {
		fields: [session.userId],
		references: [user.id]
	}),
}));

export const wager_period_snapshotsRelations = relations(wager_period_snapshots, ({one}) => ({
	user: one(user, {
		fields: [wager_period_snapshots.user_id],
		references: [user.id]
	}),
}));

export const creator_session_pending_conversionsRelations = relations(creator_session_pending_conversions, ({one}) => ({
	creator_stream_session: one(creator_stream_sessions, {
		fields: [creator_session_pending_conversions.session_id],
		references: [creator_stream_sessions.id]
	}),
	creator_deal: one(creator_deals, {
		fields: [creator_session_pending_conversions.deal_id],
		references: [creator_deals.id]
	}),
	user: one(user, {
		fields: [creator_session_pending_conversions.user_id],
		references: [user.id]
	}),
	ledger_transaction: one(ledger_transactions, {
		fields: [creator_session_pending_conversions.claim_ledger_id],
		references: [ledger_transactions.id]
	}),
}));

export const affiliate_leaderboard_snapshotsRelations = relations(affiliate_leaderboard_snapshots, ({one, many}) => ({
	affiliate_leaderboard: one(affiliate_leaderboards, {
		fields: [affiliate_leaderboard_snapshots.leaderboard_id],
		references: [affiliate_leaderboards.id]
	}),
	user: one(user, {
		fields: [affiliate_leaderboard_snapshots.user_id],
		references: [user.id]
	}),
	affiliate_leaderboard_claims: many(affiliate_leaderboard_claims),
}));

export const raffle_entriesRelations = relations(raffle_entries, ({one}) => ({
	raffle: one(raffles, {
		fields: [raffle_entries.raffle_id],
		references: [raffles.id]
	}),
	user: one(user, {
		fields: [raffle_entries.user_id],
		references: [user.id]
	}),
}));

export const vouchersRelations = relations(vouchers, ({one}) => ({
	user: one(user, {
		fields: [vouchers.user_id],
		references: [user.id]
	}),
}));

export const battle_participantsRelations = relations(battle_participants, ({one}) => ({
	creator_stream_session: one(creator_stream_sessions, {
		fields: [battle_participants.source_session_id],
		references: [creator_stream_sessions.id]
	}),
	battle: one(battles, {
		fields: [battle_participants.battle_id],
		references: [battles.id]
	}),
	bot: one(bots, {
		fields: [battle_participants.bot_id],
		references: [bots.id]
	}),
	game_session: one(game_sessions, {
		fields: [battle_participants.game_session_id],
		references: [game_sessions.id]
	}),
	user: one(user, {
		fields: [battle_participants.user_id],
		references: [user.id]
	}),
}));

export const botsRelations = relations(bots, ({many}) => ({
	battle_participants: many(battle_participants),
}));

export const affiliate_leaderboard_claimsRelations = relations(affiliate_leaderboard_claims, ({one}) => ({
	affiliate_leaderboard: one(affiliate_leaderboards, {
		fields: [affiliate_leaderboard_claims.leaderboard_id],
		references: [affiliate_leaderboards.id]
	}),
	user: one(user, {
		fields: [affiliate_leaderboard_claims.user_id],
		references: [user.id]
	}),
	affiliate_leaderboard_snapshot: one(affiliate_leaderboard_snapshots, {
		fields: [affiliate_leaderboard_claims.snapshot_id],
		references: [affiliate_leaderboard_snapshots.id]
	}),
}));

export const creator_socialsRelations = relations(creator_socials, ({one}) => ({
	user_user_id: one(user, {
		fields: [creator_socials.user_id],
		references: [user.id],
		relationName: "creator_socials_user_id_user_id"
	}),
	user_reviewed_by: one(user, {
		fields: [creator_socials.reviewed_by],
		references: [user.id],
		relationName: "creator_socials_reviewed_by_user_id"
	}),
}));

export const leaderboard_funding_addressesRelations = relations(leaderboard_funding_addresses, ({one}) => ({
	affiliate_leaderboard: one(affiliate_leaderboards, {
		fields: [leaderboard_funding_addresses.leaderboard_id],
		references: [affiliate_leaderboards.id]
	}),
	user: one(user, {
		fields: [leaderboard_funding_addresses.creator_user_id],
		references: [user.id]
	}),
	vault: one(vaults, {
		fields: [leaderboard_funding_addresses.vault_id],
		references: [vaults.id]
	}),
}));

export const user_battle_limitsRelations = relations(user_battle_limits, ({one}) => ({
	user: one(user, {
		fields: [user_battle_limits.user_id],
		references: [user.id]
	}),
}));

export const rakeback_claimsRelations = relations(rakeback_claims, ({one}) => ({
	ledger_transaction: one(ledger_transactions, {
		fields: [rakeback_claims.ledger_tx_id],
		references: [ledger_transactions.id]
	}),
	user: one(user, {
		fields: [rakeback_claims.user_id],
		references: [user.id]
	}),
}));

export const upgrader_output_cardsRelations = relations(upgrader_output_cards, ({one}) => ({
	card: one(cards, {
		fields: [upgrader_output_cards.card_id],
		references: [cards.id]
	}),
}));

export const affiliate_leaderboard_claim_holdsRelations = relations(affiliate_leaderboard_claim_holds, ({one}) => ({
	affiliate_leaderboard: one(affiliate_leaderboards, {
		fields: [affiliate_leaderboard_claim_holds.leaderboard_id],
		references: [affiliate_leaderboards.id]
	}),
	user: one(user, {
		fields: [affiliate_leaderboard_claim_holds.user_id],
		references: [user.id]
	}),
}));

export const user_statisticsRelations = relations(user_statistics, ({one}) => ({
	user: one(user, {
		fields: [user_statistics.user_id],
		references: [user.id]
	}),
}));

export const race_claim_holdsRelations = relations(race_claim_holds, ({one}) => ({
	user: one(user, {
		fields: [race_claim_holds.user_id],
		references: [user.id]
	}),
}));

export const coin_transactionsRelations = relations(coin_transactions, ({one}) => ({
	user: one(user, {
		fields: [coin_transactions.user_id],
		references: [user.id]
	}),
	game_session: one(game_sessions, {
		fields: [coin_transactions.game_session_id],
		references: [game_sessions.id]
	}),
}));

export const affiliate_code_usagesRelations = relations(affiliate_code_usages, ({one}) => ({
	user_affiliate_user_id: one(user, {
		fields: [affiliate_code_usages.affiliate_user_id],
		references: [user.id],
		relationName: "affiliate_code_usages_affiliate_user_id_user_id"
	}),
	game_session: one(game_sessions, {
		fields: [affiliate_code_usages.game_session_id],
		references: [game_sessions.id]
	}),
	user_referred_user_id: one(user, {
		fields: [affiliate_code_usages.referred_user_id],
		references: [user.id],
		relationName: "affiliate_code_usages_referred_user_id_user_id"
	}),
}));

export const battle_double_down_offersRelations = relations(battle_double_down_offers, ({one}) => ({
	battle: one(battles, {
		fields: [battle_double_down_offers.battle_id],
		references: [battles.id]
	}),
	user: one(user, {
		fields: [battle_double_down_offers.user_id],
		references: [user.id]
	}),
	game_session: one(game_sessions, {
		fields: [battle_double_down_offers.game_session_id],
		references: [game_sessions.id]
	}),
}));

export const notificationsRelations = relations(notifications, ({one}) => ({
	user: one(user, {
		fields: [notifications.user_id],
		references: [user.id]
	}),
}));

export const keno_gamesRelations = relations(keno_games, ({one}) => ({
	user: one(user, {
		fields: [keno_games.user_id],
		references: [user.id]
	}),
}));

export const user_kycRelations = relations(user_kyc, ({one}) => ({
	user: one(user, {
		fields: [user_kyc.user_id],
		references: [user.id]
	}),
}));

export const payment_provider_feesRelations = relations(payment_provider_fees, ({one}) => ({
	fiat_deposit_intent: one(fiat_deposit_intents, {
		fields: [payment_provider_fees.deposit_intent_id],
		references: [fiat_deposit_intents.id]
	}),
}));

export const fiat_deposit_intentsRelations = relations(fiat_deposit_intents, ({one, many}) => ({
	payment_provider_fees: many(payment_provider_fees),
	user: one(user, {
		fields: [fiat_deposit_intents.user_id],
		references: [user.id]
	}),
	ledger_transaction: one(ledger_transactions, {
		fields: [fiat_deposit_intents.completed_ledger_id],
		references: [ledger_transactions.id]
	}),
}));

export const announcement_readsRelations = relations(announcement_reads, ({one}) => ({
	announcement: one(announcements, {
		fields: [announcement_reads.announcement_id],
		references: [announcements.id]
	}),
	user: one(user, {
		fields: [announcement_reads.user_id],
		references: [user.id]
	}),
}));

export const announcementsRelations = relations(announcements, ({many}) => ({
	announcement_reads: many(announcement_reads),
}));