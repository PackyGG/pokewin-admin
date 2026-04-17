/**
 * Stable catalog of signal IDs used across the v2 risk scoring module.
 *
 * Split into its own file so TypeScript + client components can import
 * the union type from a hermetic module (no DB imports, no Prisma types
 * leaking into the client bundle). `score.ts` uses this union as its
 * `RiskSignal.id` type; a typo in a new signal's id is caught by tsc.
 */

export type SignalId =
  // ── velocity ───────────────────────────────────────────────────────
  | "velocity.deposit_burst_24h"
  | "velocity.withdraw_after_deposit"
  | "velocity.net_winner"
  | "velocity.delayed_first_wager"
  | "velocity.deposit_withdraw_wager_5m"
  | "velocity.multi_deposit_1h"
  | "velocity.withdraw_exceeds_deposit_24h"
  | "velocity.first_withdrawal_latency"
  // ── gameplay ───────────────────────────────────────────────────────
  | "gameplay.low_wager_multiplier"
  | "gameplay.abnormal_house_edge"
  | "gameplay.big_single_wager_new_account"
  | "gameplay.bankroll_dump"
  | "gameplay.wager_before_first_deposit"
  | "gameplay.never_sold_collector"
  // ── rewards ────────────────────────────────────────────────────────
  | "rewards.rakeback_stacked_on_bonus"
  | "rewards.bonus_stacking"
  | "rewards.withdraw_after_bonus"
  | "rewards.voucher_heavy"
  | "rewards.signup_reward_instant_withdraw"
  | "rewards.bonus_to_wager_ratio"
  | "rewards.bonus_heavy_over_deposit"
  | "rewards.withdrawal_attempt_pre_wager"
  | "rewards.cancelled_withdrawal_attempts"
  // ── network ────────────────────────────────────────────────────────
  | "network.shared_ip"
  | "network.shared_fingerprint"
  | "network.country_hopping"
  | "network.shared_deposit_address"
  | "network.shared_with_banned"
  | "network.self_referral_ring"
  | "network.withdrawal_ip_mismatch"
  | "network.deposit_ip_spread"
  // ── account ────────────────────────────────────────────────────────
  | "account.prior_moderation"
  | "account.suspected_alt_flag"
  | "account.active_feature_locks"
  | "account.admin_notes"
  | "account.chat_mutes"
  | "account.young_with_high_deposits"
  | "account.chat_silent_with_volume"
  | "account.email_unverified_with_deposits"
  | "account.no_2fa_with_volume";
