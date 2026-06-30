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
  // NOT a standalone event: the voucher leg of a battle WIN. When a battle win
  // can't be paid out as an exact-value card, the leftover is granted as a
  // voucher (voucher == card per house rules) so card-value + voucher-value =
  // the full win. The raw default ("Battle excess to voucher") reads as a
  // cryptic mystery line; this names it as part of the win so the bet → win
  // (cash + cards + voucher) trail is human-traceable. Direction / color stay
  // house-POV via `ledgerDirection` (a house cost — rose).
  battle_excess_to_voucher: "Battle win — voucher",
  // Prize paid to a user who placed on a creator/affiliate leaderboard. The
  // raw default ("Affiliate leaderboard prize") is clunky; admins know these
  // as "leaderboard wins" (the dedicated Overview box uses the same term).
  // Direction / color stay house-POV via `ledgerDirection` (a house cost — rose).
  affiliate_leaderboard_prize: "Leaderboard win",
  // Vault movements: user moves balance INTO the Fireblocks-locked vault
  // product (available balance drops, vault grows) or BACK OUT (vault drops,
  // available grows). User-internal transfer — no house P&L, colored neutral
  // by `ledgerDirection`. Surfaced in the Deposits & Withdrawals feed so
  // operators can trace a later withdrawal back to a long-locked deposit
  // (otherwise a vault_unlock → balance_withdrawal sequence looks like the
  // withdrawal materialized out of nowhere).
  vault_lock: "Vault lock",
  vault_unlock: "Vault unlock",
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
