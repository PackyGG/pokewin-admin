export const FIAT_WITHDRAWAL_HOLD_SIGNAL_KIND =
  "fiat_deposit_withdrawal_hold";

/**
 * Signal kinds whose raw name reads like the player did something, when the
 * underlying row is only bookkeeping.
 *
 * Every account gets one `user_rewards` row per daily reward at signup — all
 * twelve share the signup timestamp — so a "granted" row for Level 10–100 says
 * nothing about the account's level or behaviour. The player still cannot claim
 * a reward above their level. These carry no score weight, and the workspace
 * labels them plainly so an analyst does not read them as earned rewards.
 */
const SIGNAL_LABELS: Record<string, string> = {
  [FIAT_WITHDRAWAL_HOLD_SIGNAL_KIND]: "Fiat-triggered withdrawal hold",
  welcome_reward_granted: "Welcome reward enrolled at signup",
  level_one_reward_granted: "Level 1 daily pack enrolled at signup",
  daily_reward_granted: "Daily pack enrolled at signup",
  other_reward_granted: "Reward enrolled at signup",
  welcome_reward_opened: "Welcome reward opened",
  level_one_reward_opened: "Level 1 daily pack opened",
  daily_reward_opened: "Daily pack opened",
  ledger_reward_card_sale: "Reward card sold",
};

/**
 * Extra context for kinds an analyst routinely misreads. Rendered as the
 * badge tooltip so the row explains itself without a trip to the catalog.
 */
const SIGNAL_NOTES: Record<string, string> = {
  [FIAT_WITHDRAWAL_HOLD_SIGNAL_KIND]:
    "Lifetime completed deposits triggered automatic balance-to-crypto and physical-item withdrawal locks.",
  welcome_reward_granted:
    "Enrollment row written at signup, not an earned reward. Carries no risk score.",
  level_one_reward_granted:
    "Enrollment row written at signup, not an earned reward. Carries no risk score.",
  daily_reward_granted:
    "Every account is enrolled in all Level 10–100 daily packs at signup. The row does not mean the level was reached or the pack was claimed — it carries no risk score.",
  other_reward_granted:
    "Enrollment row written at signup, not an earned reward. Carries no risk score.",
};

/** Turns an unmapped `snake_case` signal kind into a readable phrase. */
function humanizeSignalKind(signal: string): string {
  const words = signal.replace(/[_-]+/g, " ").trim();
  if (!words) return signal;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function reviewSignalLabel(signal: string): string {
  return SIGNAL_LABELS[signal] ?? humanizeSignalKind(signal);
}

/** Tooltip text for a signal badge: the note when we have one, else the key. */
export function reviewSignalNote(signal: string): string {
  return SIGNAL_NOTES[signal] ?? signal;
}

export function isFiatWithdrawalHoldSignal(signal: string): boolean {
  return signal === FIAT_WITHDRAWAL_HOLD_SIGNAL_KIND;
}
