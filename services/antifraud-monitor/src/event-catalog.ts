export type MonitorEventStatus = "live" | "planned";

export type MonitorEventDefinition = {
  key: string;
  name: string;
  category:
    | "Account"
    | "Money"
    | "Rewards"
    | "Games"
    | "Social"
    | "Security";
  description: string;
  source: string;
  status: MonitorEventStatus;
};

const event = (
  key: string,
  name: string,
  category: MonitorEventDefinition["category"],
  description: string,
  source: string,
  status: MonitorEventStatus = "live",
): MonitorEventDefinition => ({
  key,
  name,
  category,
  description,
  source,
  status,
});

/**
 * Human-facing event vocabulary for custom monitor flows.
 *
 * `live` keys are guaranteed to be written to `risk_events` while a monitor
 * session is active. `planned` keys are documentation only: they can be used
 * in disabled drafts, but the API refuses to enable a flow containing them.
 */
export const MONITOR_EVENT_CATALOG: MonitorEventDefinition[] = [
  event(
    "account_signed_up",
    "Account signed up",
    "Account",
    "The account crosses into a new signup monitor session.",
    "Signup poller",
  ),
  event(
    "fiat_deposit",
    "Fiat deposit",
    "Money",
    "A deposit linked to a completed fiat/card intent is recorded.",
    "Ledger + fiat intent",
  ),
  event(
    "crypto_deposit",
    "Crypto deposit",
    "Money",
    "A deposit with crypto settlement evidence is recorded.",
    "Ledger",
  ),
  event(
    "paid_pack_opened",
    "Paid pack opened",
    "Games",
    "The player opens a paid pack.",
    "Ledger",
  ),
  event(
    "welcome_reward_granted",
    "Welcome reward granted",
    "Rewards",
    "The one-time reward containing three welcome-rewards packs is granted.",
    "User rewards",
  ),
  event(
    "welcome_reward_opened",
    "Welcome reward opened",
    "Rewards",
    "The player opens the one-time reward containing three welcome-rewards packs.",
    "User rewards",
  ),
  event(
    "level_one_reward_granted",
    "Level 1 daily pack granted",
    "Rewards",
    "The level-0-unlocked daily reward named Level 1 is granted.",
    "User rewards",
  ),
  event(
    "level_one_reward_opened",
    "Level 1 daily pack opened",
    "Rewards",
    "The player opens the level-0-unlocked daily reward named Level 1.",
    "User rewards",
  ),
  event(
    "daily_reward_granted",
    "Level 10–100 daily pack granted",
    "Rewards",
    "A daily pack gated by an earned account level is granted.",
    "User rewards",
  ),
  event(
    "daily_reward_opened",
    "Level 10–100 daily pack opened",
    "Rewards",
    "The player opens a daily pack gated by an earned account level.",
    "User rewards",
  ),
  event(
    "other_reward_granted",
    "Other configured reward granted",
    "Rewards",
    "A configured reward outside the known welcome and daily-pack programs is granted.",
    "User rewards",
  ),
  event(
    "other_reward_opened",
    "Other configured reward opened",
    "Rewards",
    "The player opens a configured reward outside the known welcome and daily-pack programs.",
    "User rewards",
  ),
  event("ledger_battle_bet", "Battle bet", "Games", "The player pays a battle entry.", "Ledger"),
  event(
    "ledger_battle_sponsorship",
    "Battle sponsorship",
    "Games",
    "The player sponsors a battle.",
    "Ledger",
  ),
  event(
    "creator_sponsored_battle_received",
    "Sponsored battle received",
    "Games",
    "The player joins a battle funded through site or creator sponsorship.",
    "Battle participants",
  ),
  event(
    "ledger_battle_refund",
    "Battle payout or refund",
    "Games",
    "A battle win or refund is credited.",
    "Ledger",
  ),
  event("ledger_upgrader_bet", "Upgrader bet", "Games", "The player places an upgrader bet.", "Ledger"),
  event(
    "ledger_upgrader_payout",
    "Upgrader payout",
    "Games",
    "An upgrader payout is credited.",
    "Ledger",
  ),
  event("ledger_keno_bet", "Keno bet", "Games", "The player places a Keno bet.", "Ledger"),
  event("ledger_keno_payout", "Keno payout", "Games", "A Keno payout is credited.", "Ledger"),
  event("ledger_card_sale", "Card sold", "Money", "The player sells a card.", "Ledger"),
  event(
    "ledger_reward_card_sale",
    "Reward card sold",
    "Rewards",
    "The player sells a card received from a reward.",
    "Ledger",
  ),
  event("ledger_card_exchange", "Card exchanged", "Games", "The player exchanges a card.", "Ledger"),
  event(
    "ledger_exchange_excess_credit",
    "Exchange excess credited",
    "Money",
    "Cash excess from an exchange is credited.",
    "Ledger",
  ),
  event(
    "ledger_exchange_excess_to_voucher",
    "Exchange excess to voucher",
    "Rewards",
    "Exchange excess is converted into a voucher.",
    "Ledger",
  ),
  event(
    "ledger_battle_excess_to_voucher",
    "Battle excess to voucher",
    "Rewards",
    "Battle excess is converted into a voucher.",
    "Ledger",
  ),
  event("ledger_voucher_redeemed", "Voucher redeemed", "Rewards", "A voucher is redeemed.", "Ledger"),
  event("ledger_voucher_exchange", "Voucher exchanged", "Rewards", "A voucher is exchanged.", "Ledger"),
  event("ledger_vault_lock", "Item vault locked", "Security", "An item is locked in the vault.", "Ledger"),
  event("ledger_vault_unlock", "Item vault unlocked", "Security", "An item is unlocked from the vault.", "Ledger"),
  event(
    "ledger_deposit_bonus",
    "Deposit bonus received",
    "Rewards",
    "A bonus tied to a completed deposit is credited.",
    "Ledger",
  ),
  event(
    "ledger_gift_card_redeemed",
    "Gift card redeemed",
    "Rewards",
    "A gift card is redeemed into player balance.",
    "Ledger",
  ),
  event(
    "ledger_promo_code_redeemed",
    "Promo code redeemed",
    "Rewards",
    "A promo code reward is redeemed.",
    "Ledger",
  ),
  event(
    "ledger_balance_reward_claim",
    "Balance reward claimed",
    "Rewards",
    "A configured balance reward is claimed.",
    "Ledger",
  ),
  event(
    "ledger_waitlist_prize",
    "Waitlist prize received",
    "Rewards",
    "A waitlist prize is credited.",
    "Ledger",
  ),
  event("ledger_race_prize", "Race prize claimed", "Rewards", "A race prize is credited.", "Ledger"),
  event(
    "ledger_rakeback_claim",
    "Rakeback claimed",
    "Rewards",
    "Daily, weekly, or monthly rakeback is claimed.",
    "Ledger",
  ),
  event(
    "ledger_affiliate_claim",
    "Affiliate reward claimed",
    "Rewards",
    "Affiliate commission is claimed.",
    "Ledger",
  ),
  event("ledger_rain_tip", "Rain funded", "Social", "The player contributes funds to rain.", "Ledger"),
  event("ledger_rain_win", "Rain payout received", "Rewards", "The player receives a completed rain payout.", "Ledger"),
  event("ledger_creator_tip", "Creator tip received", "Social", "The player receives a creator-funded tip.", "Ledger"),
  event(
    "ledger_card_withdrawal",
    "Card withdrawal",
    "Money",
    "The player withdraws a card.",
    "Ledger",
  ),
  event(
    "ledger_balance_withdrawal",
    "Balance withdrawal",
    "Money",
    "The player withdraws balance.",
    "Ledger",
  ),
  event(
    "ledger_withdrawal_shipping_fee",
    "Withdrawal shipping fee",
    "Money",
    "A withdrawal shipping fee is charged.",
    "Ledger",
  ),
  event(
    "ledger_admin_balance_adjustment",
    "Admin balance adjustment",
    "Security",
    "Staff adjusts the player's balance.",
    "Ledger",
  ),
  event("ledger_challenge_prize", "Challenge prize", "Rewards", "A challenge prize is credited.", "Ledger"),
  event("ledger_xp_purchase", "XP purchased", "Rewards", "The player purchases XP.", "Ledger"),
  event(
    "ledger_pack_borrow_to_voucher",
    "Borrowed pack to voucher",
    "Rewards",
    "A borrowed pack is converted to a voucher.",
    "Ledger",
  ),
  event(
    "ledger_creator_deal_fill_grant",
    "Creator fill granted",
    "Money",
    "A creator deal fill is granted.",
    "Ledger",
  ),
  event(
    "ledger_creator_fill_activation",
    "Creator fill activated",
    "Money",
    "A creator fill becomes active.",
    "Ledger",
  ),
  event(
    "ledger_creator_fill_spend_tip",
    "Creator fill spent on tip",
    "Social",
    "Creator fill balance is spent on a tip.",
    "Ledger",
  ),
  event(
    "ledger_creator_fill_spend_battle",
    "Creator fill spent on battle",
    "Games",
    "Creator fill balance is spent on a battle.",
    "Ledger",
  ),
  event(
    "ledger_creator_fill_refund",
    "Creator fill refunded",
    "Money",
    "Creator fill balance is refunded.",
    "Ledger",
  ),
  event(
    "ledger_creator_fill_conversion",
    "Creator fill converted",
    "Money",
    "Creator fill balance is converted.",
    "Ledger",
  ),
  event(
    "ledger_creator_fill_forfeiture",
    "Creator fill forfeited",
    "Money",
    "Creator fill balance is forfeited.",
    "Ledger",
  ),
  event(
    "ledger_affiliate_leaderboard_creation",
    "Affiliate leaderboard created",
    "Rewards",
    "Funds are reserved for an affiliate leaderboard.",
    "Ledger",
  ),
  event(
    "ledger_affiliate_leaderboard_refund",
    "Affiliate leaderboard refunded",
    "Rewards",
    "Affiliate leaderboard funds are refunded.",
    "Ledger",
  ),
  event(
    "ledger_affiliate_leaderboard_prize",
    "Affiliate leaderboard prize",
    "Rewards",
    "An affiliate leaderboard prize is credited.",
    "Ledger",
  ),
  event(
    "ledger_creator_multiplier_deposit_lock",
    "Creator multiplier deposit locked",
    "Money",
    "A creator multiplier deposit is locked.",
    "Ledger",
  ),
  event(
    "ledger_creator_multiplier_deposit_topup",
    "Creator multiplier deposit topped up",
    "Money",
    "A creator multiplier deposit is increased.",
    "Ledger",
  ),
  event(
    "ledger_creator_multiplier_platform_credit",
    "Creator multiplier platform credit",
    "Money",
    "The platform credits a creator multiplier deal.",
    "Ledger",
  ),
  event(
    "ledger_creator_multiplier_spend_wager",
    "Creator multiplier wager",
    "Games",
    "Creator multiplier balance is spent on a wager.",
    "Ledger",
  ),
  event(
    "ledger_creator_multiplier_spend_tip",
    "Creator multiplier tip",
    "Social",
    "Creator multiplier balance is spent on a tip.",
    "Ledger",
  ),
  event(
    "ledger_creator_multiplier_spend_battle",
    "Creator multiplier battle spend",
    "Games",
    "Creator multiplier balance is spent on a battle.",
    "Ledger",
  ),
  event(
    "ledger_creator_multiplier_refund",
    "Creator multiplier refunded",
    "Money",
    "Creator multiplier balance is refunded.",
    "Ledger",
  ),
  event(
    "ledger_creator_multiplier_settlement_payout",
    "Creator multiplier payout",
    "Money",
    "A creator multiplier settlement payout is credited.",
    "Ledger",
  ),
  event(
    "ledger_creator_multiplier_settlement_deposit_return",
    "Creator multiplier deposit returned",
    "Money",
    "A creator multiplier deposit is returned at settlement.",
    "Ledger",
  ),
  event(
    "ledger_creator_multiplier_forfeiture",
    "Creator multiplier forfeited",
    "Money",
    "Creator multiplier funds are forfeited.",
    "Ledger",
  ),
  event(
    "ledger_creator_lb_deposit",
    "Creator leaderboard deposit",
    "Money",
    "A creator deposits funds for a leaderboard.",
    "Ledger",
  ),
  event("chat_message_sent", "Chat message sent", "Social", "The player sends a public chat message.", "Planned source", "planned"),
  event("rain_joined", "Rain joined", "Social", "The player joins an active rain.", "Planned source", "planned"),
  event("account_logged_in", "Account logged in", "Account", "The player starts an authenticated session.", "Planned source", "planned"),
  event("email_verified", "Email verified", "Account", "The player verifies their email address.", "Planned source", "planned"),
  event(
    "affiliate_code_applied",
    "Affiliate code applied",
    "Account",
    "The player applies or changes an affiliate code.",
    "Planned source",
    "planned",
  ),
  event("battle_joined", "Battle joined", "Games", "The player joins an existing battle.", "Planned source", "planned"),
  event("battle_completed", "Battle completed", "Games", "A joined battle settles.", "Planned source", "planned"),
  event(
    "withdrawal_requested",
    "Withdrawal requested",
    "Money",
    "The player submits a withdrawal before settlement.",
    "Planned source",
    "planned",
  ),
];

const EVENT_BY_KEY = new Map(
  MONITOR_EVENT_CATALOG.map((definition) => [definition.key, definition]),
);

export function monitorEvent(key: string): MonitorEventDefinition | undefined {
  return EVENT_BY_KEY.get(key);
}

export function isDocumentedMonitorEvent(key: string): boolean {
  return EVENT_BY_KEY.has(key);
}

export function isLiveMonitorEvent(key: string): boolean {
  return EVENT_BY_KEY.get(key)?.status === "live";
}

export function unavailableMonitorEvents(keys: string[]): string[] {
  return [...new Set(keys.filter((key) => !isLiveMonitorEvent(key)))];
}
