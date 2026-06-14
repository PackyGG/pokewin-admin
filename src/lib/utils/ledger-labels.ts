/**
 * Human-readable display labels for ledger `type` strings.
 *
 * Historically every transaction surface derived its label inline with
 * `type.replace(/_/g, " ")`, which produces serviceable-but-raw text
 * ("challenge prize", "card withdrawal", "rakeback claim"). That's fine for
 * most types, but a few need a cleaner, admin-facing label — and keeping the
 * map in ONE place means the Finances table, the Recent Activity feed and the
 * global /transactions list never drift apart (the same reason
 * `ledger-direction.ts` centralises the house-POV colors).
 *
 * Anything not in the override map falls back to the humanized default, so a
 * newly-added ledger type still renders sensibly without a code change.
 */

/** Explicit, admin-facing labels for ledger types that read better than the
 *  raw snake_case → spaced default. Keep additions house-POV neutral (the
 *  label names the EVENT; the color/sign comes from `ledgerDirection`). */
const LEDGER_TYPE_LABELS: Record<string, string> = {
  // A challenge prize is balance the user won by completing a challenge and
  // claiming it — surfaced in the Finances feed so admins can see it as a
  // distinct payout (house cost) rather than an unlabeled credit.
  challenge_prize: "Challenge prize",
  // The user spent withdrawable balance to buy XP (a debit). The humanized
  // default ("Xp purchase") mis-cases the acronym, so curate it. Direction /
  // color comes from `ledgerDirection` (a house gain — emerald).
  xp_purchase: "XP purchase",
};

/** Humanize a raw ledger type: `card_withdrawal` → "Card withdrawal". */
function humanizeLedgerType(type: string): string {
  const spaced = type.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Display label for a ledger `type`. Returns the curated override when one
 * exists, otherwise a humanized fallback (first-letter capitalized).
 */
export function ledgerTypeLabel(type: string): string {
  return LEDGER_TYPE_LABELS[type] ?? humanizeLedgerType(type);
}
