/**
 * balance-adjustment-categories.ts — the SINGLE canonical definition of
 * the strict balance-adjustment category set.
 *
 * This is the ONE source of truth shared by:
 *   • the WRITER — `adjustBalance` in
 *     `src/app/(admin)/users/[id]/actions.ts` stamps the chosen category
 *     key onto the MAIN-DB ledger row's `metadata` JSON
 *     (`metadata.adjustment_category = <key>`), so the GGR / NGR / cost
 *     queries (which read the main DB) can classify each adjustment by
 *     category with NO cross-DB join.
 *   • the DIALOG — `BalanceAdjustDialog` in `user-tabs-dialogs.tsx` drives
 *     its conditional inputs + the destructive "won't be tracked" warning
 *     off this list (it is client-safe — no server-only / DB import).
 *   • the METRIC QUERIES — `getRewardCost` / `getDailyGamingMetrics`
 *     (`src/lib/metrics/queries.ts`) and `cost-breakdown.ts` lift the
 *     COUNTED categories into the reward-cost / NGR side via the canonical
 *     `metadata->>'adjustment_category'` predicate built here.
 *
 * Client-safe: no DB / `server-only` import, so the dialog component can
 * import the labels + required-input flags directly.
 *
 * ─── Counting model (house POV, per CLAUDE.md) ──────────────────────
 *
 * A categorized CREDIT adjustment that GIVES a user money is a house COST
 * (bonus / giveaway / reload / lossback / deposit-fix credit). Every
 * CREDIT category EXCEPT `other` is COUNTED: it is lifted into the
 * reward-cost side so it reduces NGR / P&L and appears as its own line in
 * the cost breakdown. `other` stays RESIDUAL / EXCLUDED (mainly for
 * content-creator bookkeeping) — exactly the treatment
 * `admin_balance_adjustment` had for EVERY reason before this feature.
 *
 * `leaderboard` is the ONE category that goes the other way: it is a
 * REMOVAL-ONLY DEBIT (admin REMOVING balance from a user, linked to a
 * creator). Because the counted-credit predicates pin `amount > 0` (money
 * GIVEN to users), a debit must never be summed there — so `leaderboard`
 * is deliberately kept OUT of {@link COUNTED_ADJUSTMENT_CATEGORY_KEYS} and
 * tracked separately in {@link REMOVAL_ONLY_ADJUSTMENT_CATEGORY_KEYS}. Its
 * downstream cost-accounting wiring (feeding the dashboard "Creators
 * Costs" / leaderboard-spend boxes) is intentionally NOT done here — the
 * adjustment only persists the creator link cleanly; the accounting lift
 * is a deliberate follow-up.
 *
 * IMPORTANT — the type partition in `src/lib/metrics/ledger-sets.ts` does
 * NOT change: `admin_balance_adjustment` stays in RESIDUAL_TYPES (so the
 * `__checks__` exhaustiveness assertions stay green). The counted-category
 * lift is a per-ROW SQL split keyed on `metadata->>'adjustment_category'`,
 * mirroring EXACTLY the existing manual-voucher carve-out
 * (`metadata->>'origin' = 'manual'` → reward cost) — a query-layer split,
 * never a whole-type bucket move.
 */


/**
 * The canonical category keys, in dropdown order. These exact strings are
 * what gets written to `ledger_transactions.metadata->>'adjustment_category'`
 * and what every metric query matches against. NEVER rename a key without
 * a backfill — old rows carry the old string.
 */
export const BALANCE_ADJUSTMENT_CATEGORY_KEYS = [
  "deposit_problem",
  "withdrawal_failed",
  "giveaway",
  "bonus",
  "deposit_bonus",
  "bugs",
  "reload",
  "trivia",
  "chat_raffle",
  "lossback",
  "ultra_lossback",
  "leaderboard",
  "remove_locked_balance",
  "fraud_abuse",
  "official_stream",
  "creator_vip_reward",
  "other",
] as const;

/** Minimum explanation length when category is `bugs`. */
export const BUGS_ADJUSTMENT_MIN_REASON_CHARS = 30;

/** Minimum reason length when category is `remove_locked_balance`. */
export const REMOVE_LOCKED_BALANCE_MIN_REASON_CHARS = 20;

/** Minimum explanation length when category is `fraud_abuse`. */
export const FRAUD_ABUSE_MIN_REASON_CHARS = 20;

export type BalanceAdjustmentCategory =
  (typeof BALANCE_ADJUSTMENT_CATEGORY_KEYS)[number];

/**
 * The REMOVAL-ONLY (debit) categories — the admin is REMOVING balance from
 * the user, not crediting it. Currently just `leaderboard` (balance pulled
 * from a user and linked to a creator). These are deliberately EXCLUDED
 * from {@link COUNTED_ADJUSTMENT_CATEGORY_KEYS} because the counted-credit
 * predicates pin `amount > 0`; a debit is a house gain, not a reward cost,
 * and must never be summed into the reward-cost side. The dialog uses this
 * set to gate the option to the REMOVE-balance direction only.
 */
export const REMOVAL_ONLY_ADJUSTMENT_CATEGORY_KEYS = [
  "ultra_lossback",
  "leaderboard",
  "remove_locked_balance",
  "fraud_abuse",
] as const;

export type RemovalOnlyAdjustmentCategory =
  (typeof REMOVAL_ONLY_ADJUSTMENT_CATEGORY_KEYS)[number];

/** Type-guard: is this category a removal-only (debit) category? */
export function isRemovalOnlyAdjustmentCategory(
  category: BalanceAdjustmentCategory,
): category is RemovalOnlyAdjustmentCategory {
  return (REMOVAL_ONLY_ADJUSTMENT_CATEGORY_KEYS as readonly string[]).includes(
    category,
  );
}

/**
 * The CREATOR-LINKED categories — an adjustment that must be tied to a
 * specific creator (the dialog renders the searchable creator @ picker
 * and the action stamps `metadata.creator_id` on the ledger row). This is
 * DECOUPLED from {@link REMOVAL_ONLY_ADJUSTMENT_CATEGORY_KEYS} on purpose:
 *   • `leaderboard` is BOTH removal-only AND creator-linked.
 *   • `official_stream` is creator-linked but allows BOTH directions
 *     (credit OR debit) — it is deliberately NOT in the removal-only set.
 * The dialog drives the creator @ picker off THIS set (not the removal-only
 * one) so adding a creator-linked category never accidentally forces the
 * remove-balance direction.
 */
export const CREATOR_LINKED_ADJUSTMENT_CATEGORY_KEYS = [
  "leaderboard",
  "official_stream",
  "creator_vip_reward",
] as const;

export type CreatorLinkedAdjustmentCategory =
  (typeof CREATOR_LINKED_ADJUSTMENT_CATEGORY_KEYS)[number];

/**
 * Type-guard: does this category require a linked creator (so the dialog
 * must render the creator @ picker and the action must stamp
 * `metadata.creator_id`)?
 */
export function isCreatorLinkedAdjustmentCategory(
  category: BalanceAdjustmentCategory,
): category is CreatorLinkedAdjustmentCategory {
  return (
    CREATOR_LINKED_ADJUSTMENT_CATEGORY_KEYS as readonly string[]
  ).includes(category);
}

/**
 * The COUNTED categories — every CREDIT category except `other`, the
 * removal-only debit categories, and `official_stream`. These are lifted
 * into the reward-cost / NGR side (they reduce NGR/P&L and get their own
 * cost-breakdown line). Intentionally absent (RESIDUAL/EXCLUDED):
 *   • `other` (uncounted escape hatch),
 *   • `leaderboard` (a debit — see {@link REMOVAL_ONLY_ADJUSTMENT_CATEGORY_KEYS}),
 *   • `official_stream` (a creator-linked credit/debit deliberately kept
 *     `counted: false` — it only persists the creator link; cost
 *     accounting is a separate follow-up, exactly like `leaderboard`).
 */
export const COUNTED_ADJUSTMENT_CATEGORY_KEYS = BALANCE_ADJUSTMENT_CATEGORY_KEYS.filter(
  (k) =>
    k !== "other" &&
    k !== "official_stream" &&
    k !== "creator_vip_reward" &&
    !isRemovalOnlyAdjustmentCategory(k),
) as readonly Exclude<
  BalanceAdjustmentCategory,
  | "other"
  | "official_stream"
  | "creator_vip_reward"
  | RemovalOnlyAdjustmentCategory
>[];

/**
 * The SELECTABLE categories — the set an admin may pick in the
 * Adjust-Balance dialog dropdown GOING FORWARD. `other` is intentionally
 * excluded from the picker (it was an uncategorized residual escape hatch
 * that we no longer want admins choosing). Removal-only categories (e.g.
 * `leaderboard`) STAY selectable — the dialog gates them to the
 * remove-balance direction at render time rather than removing them here.
 *
 * `creator_vip_reward` is ALSO excluded, for a different reason: it must be
 * unforgeable by hand. The ONLY writer is `approveCreatorRewardClaim`, so
 * every such ledger row provably traces back to an approved
 * `creator_reward_claims` row (whose id it carries in `metadata.vip_claim_id`).
 * If an admin could pick it from this dropdown, that invariant — and the
 * per-user consumed-wager accounting that depends on it — would be a lie.
 *
 * `chat_raffle` is excluded on the SAME unforgeability grounds: its only
 * writer is `payChatRafflePrize`, so every such ledger row traces back to a
 * drawn `chat_raffle_prizes` row (whose id and round it carries in
 * `metadata.chat_raffle_round_id` / `chat_raffle_position`). A hand-picked
 * "chat raffle" credit with no draw behind it would break that.
 *
 * IMPORTANT — this is a PICKER-ONLY filter, not a removal from the model:
 * `other` stays a fully valid `BalanceAdjustmentCategory` and stays in
 * {@link BALANCE_ADJUSTMENT_CATEGORY_KEYS} + {@link BALANCE_ADJUSTMENT_CATEGORY_META}.
 * Old ledger rows already stamped with `metadata->>'adjustment_category' =
 * 'other'` still validate against the server enum, still resolve their
 * display label via the META map, and still classify as RESIDUAL/EXCLUDED
 * in GGR/NGR/cost exactly as before. Only the dropdown stops offering it.
 */
export const SELECTABLE_ADJUSTMENT_CATEGORY_KEYS = BALANCE_ADJUSTMENT_CATEGORY_KEYS.filter(
  (k) =>
    k !== "other" &&
    k !== "creator_vip_reward" &&
    k !== "chat_raffle" &&
    k !== "ultra_lossback",
) as readonly Exclude<
  BalanceAdjustmentCategory,
  "other" | "creator_vip_reward" | "chat_raffle" | "ultra_lossback"
>[];

/** Type-guard: is this string one of the canonical category keys? */
export function isBalanceAdjustmentCategory(
  value: unknown,
): value is BalanceAdjustmentCategory {
  return (
    typeof value === "string" &&
    (BALANCE_ADJUSTMENT_CATEGORY_KEYS as readonly string[]).includes(value)
  );
}

/**
 * Is this category COUNTED in GGR/NGR/cost? Counted = a credit category
 * other than `other` / `official_stream`. `other` (residual),
 * `official_stream` (creator-linked, deliberately uncounted) and
 * removal-only debit categories (e.g. `leaderboard`) are NOT counted.
 */
export function isCountedAdjustmentCategory(
  category: BalanceAdjustmentCategory,
): boolean {
  return (
    category !== "other" &&
    category !== "official_stream" &&
    category !== "creator_vip_reward" &&
    !isRemovalOnlyAdjustmentCategory(category)
  );
}

/**
 * UI metadata per category: dropdown label, the operator-friendly
 * cost-breakdown label, a one-line "why", and which conditional inputs the
 * dialog must render. Kept here so the dialog and the cost breakdown read
 * the SAME labels.
 */
export type BalanceAdjustmentCategoryMeta = {
  key: BalanceAdjustmentCategory;
  /** Dropdown label in the dialog. */
  label: string;
  /** Operator-friendly label for the cost-breakdown reward line. */
  costLabel: string;
  /** One-line plain-English explanation for the cost-breakdown `why`. */
  why: string;
  /** Whether this category is counted in GGR/NGR/cost. */
  counted: boolean;
};

export const BALANCE_ADJUSTMENT_CATEGORY_META: Record<
  BalanceAdjustmentCategory,
  BalanceAdjustmentCategoryMeta
> = {
  deposit_problem: {
    key: "deposit_problem",
    label: "Deposit problem",
    costLabel: "Deposit-problem credits",
    why: "Balance credited to fix a stuck / under-credited deposit (coin type + on-chain tx hash recorded). A house cost — the user got balance they were owed.",
    counted: true,
  },
  withdrawal_failed: {
    key: "withdrawal_failed",
    label: "Withdrawal failed",
    costLabel: "Withdrawal-failed refunds",
    why: "Balance refunded to a user after a declined / failed withdrawal that the backend didn't auto-refund (the operator manually credits the user back). A house cost — the user got balance they were owed.",
    counted: true,
  },
  giveaway: {
    key: "giveaway",
    label: "Giveaway",
    costLabel: "Giveaway credits",
    why: "Balance handed out as a giveaway prize (sourced from a Twitter or Discord post). Pure marketing cost.",
    counted: true,
  },
  bonus: {
    key: "bonus",
    label: "Bonus",
    costLabel: "Manual bonus credits",
    why: "Discretionary admin bonus credited to a user's balance (exact reason recorded). A house-funded incentive cost.",
    counted: true,
  },
  deposit_bonus: {
    key: "deposit_bonus",
    label: "Deposit bonus",
    costLabel: "Deposit-bonus credits",
    why: "Bonus credited as a % of a user's deposit(s) — optionally calculated from selected deposits at a chosen rate. A house-funded incentive cost.",
    counted: true,
  },
  bugs: {
    key: "bugs",
    label: "Bugs",
    costLabel: "Bug-compensation credits",
    why: "Balance credited to compensate a user for a platform bug (detailed explanation required, min 30 characters). A house-funded remediation cost.",
    counted: true,
  },
  reload: {
    key: "reload",
    label: "Reload",
    costLabel: "Reload credits",
    why: "Reload bonus credited to a user's balance. A house-funded retention cost.",
    counted: true,
  },
  trivia: {
    key: "trivia",
    label: "Trivia",
    costLabel: "Trivia credits",
    why: "Balance credited as a trivia-event prize. A house-funded marketing cost.",
    counted: true,
  },
  chat_raffle: {
    key: "chat_raffle",
    label: "Chat raffle",
    costLabel: "Chat-raffle prizes",
    why: "Balance paid out to the drawn winner of a chat raffle round (tickets earned by chatting). A house-funded engagement cost. Only the /chat-raffle payout action writes this category — it always traces back to a drawn prize row.",
    counted: true,
  },
  lossback: {
    key: "lossback",
    label: "Lossback",
    costLabel: "Lossback credits",
    why: "Loss-rebate credited back to a user (a % of their recent losses). A house-funded retention cost.",
    counted: true,
  },
  ultra_lossback: {
    key: "ultra_lossback",
    label: "Ultra Lossback",
    costLabel: "Ultra-lossback removals (private)",
    why: "A private available-balance removal restricted to the motha and hifoen admin accounts. It is a real liability reduction, not a reward cost.",
    counted: false,
  },
  leaderboard: {
    key: "leaderboard",
    label: "Leaderboard",
    costLabel: "Leaderboard debits",
    why: "Balance REMOVED from a user and linked to a creator's leaderboard. A removal (debit) — NOT counted in the reward-cost / NGR side here (the counted-credit predicates only sum money given to users). Creator-leaderboard cost accounting is a separate follow-up.",
    counted: false,
  },
  remove_locked_balance: {
    key: "remove_locked_balance",
    label: "Remove locked balance",
    costLabel: "Locked-balance removals (uncounted)",
    why: "Locked (vault) balance REMOVED from a user — e.g. reversing a leaderboard deposit escrow stuck in locked_balance. NOT counted in GGR/NGR/cost or P&L (the onSiteBalance carve-out nets it out). Requires a detailed reason (min 20 characters).",
    counted: false,
  },
  fraud_abuse: {
    key: "fraud_abuse",
    label: "Fraud / abuse",
    costLabel: "Fraud / abuse clawbacks (uncounted)",
    why: "Available balance REMOVED from a user for fraud or abuse (chargeback, multi-account, bonus abuse, etc.). NOT counted in GGR/NGR reward-cost — a debit clawback, not a marketing credit. Requires a detailed explanation (min 20 characters).",
    counted: false,
  },
  official_stream: {
    key: "official_stream",
    label: "Official stream",
    costLabel: "Official-stream adjustments (uncounted)",
    why: "Balance adjustment linked to a creator's official stream (can ADD or REMOVE balance). NOT counted in GGR/NGR/cost here — it only persists the creator link (`metadata.creator_id`). Cost accounting is a deliberate follow-up, exactly like `leaderboard`.",
    counted: false,
  },
  creator_vip_reward: {
    key: "creator_vip_reward",
    label: "Creator VIP reward",
    costLabel: "Creator VIP wager rewards (uncounted)",
    why: "Wager-milestone reward paid to a user under a creator's VIP program (\"wager $X under my code, get $Y\"). Written ONLY by an approved `creator_reward_claims` row, never by hand — the ledger row carries `metadata.creator_id`, `metadata.vip_claim_id` and `metadata.vip_program_id` so every payout traces back to the claim and the program that authorized it. NOT counted in GGR/NGR/cost YET — it follows the `leaderboard` / `official_stream` precedent of persisting the creator link first; lifting it into reward cost requires updating the canonical PostgreSQL counted-category lists (see COUNTED_ADJUSTMENT_CATEGORY_KEYS).",
    counted: false,
  },
  other: {
    key: "other",
    label: "Other",
    costLabel: "Other adjustments (uncounted)",
    why: "Uncategorized manual adjustment — NOT counted in GGR/NGR/cost (mainly for content-creator bookkeeping). Routed through realized P&L's balance delta only.",
    counted: false,
  },
};

/**
 * Build the canonical SQL predicate that matches a `ledger_transactions`
 * row whose `metadata->>'adjustment_category'` is one of the COUNTED
 * categories. Used by the metric queries to lift counted adjustments into
 * the reward-cost / NGR side.
 *
 * The keys are hardcoded enum-like strings from this module (never user
 * input), so injection is structurally impossible; the single-quote escape
 * is defence-in-depth, mirroring `ledgerTypesToSqlList`.
 *
 * `typeColumn` defaults to `type` (matching the unaliased
 * `ledger_transactions` reads in `metrics/queries.ts`); pass an alias
 * (e.g. `lt.type`) for aliased call sites. Likewise `metadataColumn`
 * defaults to `metadata`.
 *
 * The predicate also pins `amount::numeric > 0` so ONLY credits (house
 * gives the user money) are counted — a categorized DEBIT (clawback) is a
 * house gain and must not be summed as a reward cost. In practice the
 * counted categories are credit-only flows, but the guard keeps the metric
 * honest if a negative-amount row ever carries a counted category.
 */
export function countedAdjustmentSqlPredicate(opts?: {
  typeColumn?: string;
  metadataColumn?: string;
  amountColumn?: string;
}): string {
  const typeCol = opts?.typeColumn ?? "type";
  const metaCol = opts?.metadataColumn ?? "metadata";
  const amountCol = opts?.amountColumn ?? "amount";
  const list = COUNTED_ADJUSTMENT_CATEGORY_KEYS.map(
    (k) => `'${k.replace(/'/g, "''")}'`,
  ).join(",");
  return `${typeCol}::text = 'admin_balance_adjustment' AND ${amountCol}::numeric > 0 AND ${metaCol}->>'adjustment_category' IN (${list})`;
}

/**
 * Per-category SQL predicate (one COUNTED category at a time) — used by the
 * cost breakdown to itemize each category as its own line. Same escaping +
 * credit-only guard as {@link countedAdjustmentSqlPredicate}.
 */
export function adjustmentCategorySqlPredicate(
  category: Exclude<BalanceAdjustmentCategory, "other">,
  opts?: { typeColumn?: string; metadataColumn?: string; amountColumn?: string },
): string {
  const typeCol = opts?.typeColumn ?? "type";
  const metaCol = opts?.metadataColumn ?? "metadata";
  const amountCol = opts?.amountColumn ?? "amount";
  const key = `'${category.replace(/'/g, "''")}'`;
  return `${typeCol}::text = 'admin_balance_adjustment' AND ${amountCol}::numeric > 0 AND ${metaCol}->>'adjustment_category' = ${key}`;
}

/**
 * The FAKE-BALANCE category key — `official_stream` adjustments credit (or
 * debit) REAL `balances.available_balance` but are owner-designated as fake
 * balance that must be HIDDEN ABSOLUTELY EVERYWHERE: excluded from every
 * computed figure (PnL live-balance term + balance-delta term, cost
 * breakdowns, balance-adjustment insights, creator LTV), netted out of every
 * raw balance display, and hidden from every activity / transaction feed.
 *
 * It is detected by `admin_balance_adjustment` ledger rows carrying
 * `metadata->>'adjustment_category' = 'official_stream'`. Because the credit
 * is signed (both credit + debit are allowed) and a later clawback must
 * reverse it cleanly, callers ALWAYS use the SIGNED NET `SUM(amount)` (NOT
 * `ABS`, NOT a positive-only clamp) when subtracting it.
 */
export const OFFICIAL_STREAM_ADJUSTMENT_CATEGORY: BalanceAdjustmentCategory =
  "official_stream";

/**
 * The REMOVE-LOCKED-BALANCE category key — admin adjustments that decrement
 * `balances.locked_balance` (vault) rather than `available_balance`. Used for
 * clearing escrowed leaderboard deposits or other locked funds without moving
 * the liability through GGR/NGR/cost or the canonical P&L formula (netted out
 * of onSiteBalance the same way as {@link OFFICIAL_STREAM_ADJUSTMENT_CATEGORY}).
 */
export const REMOVE_LOCKED_BALANCE_ADJUSTMENT_CATEGORY: BalanceAdjustmentCategory =
  "remove_locked_balance";

/**
 * Categories excluded from every computed figure (PnL live-balance term,
 * balance-delta term, cost breakdowns, balance-adjustment insights). Both are
 * `admin_balance_adjustment` rows classified by `metadata.adjustment_category`.
 */
export const STATS_EXCLUDED_ADJUSTMENT_CATEGORY_KEYS = [
  OFFICIAL_STREAM_ADJUSTMENT_CATEGORY,
  REMOVE_LOCKED_BALANCE_ADJUSTMENT_CATEGORY,
] as const;

/**
 * SQL predicate matching ONLY the fake-balance `official_stream`
 * `admin_balance_adjustment` rows. Single source of truth for every
 * "subtract / exclude / hide official_stream" call site.
 *
 * Mirrors {@link countedAdjustmentSqlPredicate}'s escaping (the key is a
 * hardcoded enum string from this module, never user input, so injection is
 * structurally impossible; the single-quote escape is defence-in-depth).
 *
 * Deliberately has NO `amount` sign guard — official_stream is netted with
 * SIGNED `SUM(amount)` so a debit clawback reverses a prior credit. Pass an
 * alias (e.g. `lt.type` / `lt.metadata`) for aliased call sites; both default
 * to the unaliased `type` / `metadata` columns.
 *
 * NULL-SAFE under negation (3VL guard): rows with NO `adjustment_category`
 * (NULL `metadata`, missing key, or JSON null — i.e. every legacy
 * uncategorized adjustment; 93/93 prod rows as of 2026-06-10) make the bare
 * equality SQL NULL, so a caller's `NOT (...)` ALSO evaluated NULL and
 * silently DROPPED those rows from every exclusion-style feed. The explicit
 * `IS NOT NULL` conjunct forces the predicate to FALSE (not NULL) for
 * uncategorized rows, so `NOT (...)` keeps them. Positive (match-IN) use is
 * unchanged — a row equal to the key always has a non-NULL category.
 */
export function officialStreamAdjustmentSqlPredicate(opts?: {
  typeColumn?: string;
  metadataColumn?: string;
}): string {
  const typeCol = opts?.typeColumn ?? "type";
  const metaCol = opts?.metadataColumn ?? "metadata";
  const key = `'${OFFICIAL_STREAM_ADJUSTMENT_CATEGORY.replace(/'/g, "''")}'`;
  return `${typeCol}::text = 'admin_balance_adjustment' AND ${metaCol}->>'adjustment_category' IS NOT NULL AND ${metaCol}->>'adjustment_category' = ${key}`;
}

/**
 * SQL predicate matching ONLY `remove_locked_balance` `admin_balance_adjustment`
 * rows. Used to net locked-balance removals out of onSiteBalance / P&L (signed
 * `SUM(amount)` — amounts are negative debits from locked_balance).
 *
 * Carries the same `IS NOT NULL` 3VL guard as
 * {@link officialStreamAdjustmentSqlPredicate} so a negated call site never
 * silently drops uncategorized (NULL-category) adjustments. Today's call
 * sites are positive-only, where the guard is a no-op.
 */
export function removeLockedBalanceAdjustmentSqlPredicate(opts?: {
  typeColumn?: string;
  metadataColumn?: string;
}): string {
  const typeCol = opts?.typeColumn ?? "type";
  const metaCol = opts?.metadataColumn ?? "metadata";
  const key = `'${REMOVE_LOCKED_BALANCE_ADJUSTMENT_CATEGORY.replace(/'/g, "''")}'`;
  return `${typeCol}::text = 'admin_balance_adjustment' AND ${metaCol}->>'adjustment_category' IS NOT NULL AND ${metaCol}->>'adjustment_category' = ${key}`;
}

/**
 * SQL predicate matching ANY stats-excluded `admin_balance_adjustment` row
 * (`official_stream` or `remove_locked_balance`). Single source of truth for
 * insights filters and residual-adjustment carve-outs.
 *
 * NULL-SAFE under negation (same 3VL guard as
 * {@link officialStreamAdjustmentSqlPredicate}): the negated call sites —
 * `notOfficialStreamFilter` (`AND NOT (...)`, every insights
 * balance-adjustment surface) and the `AND NOT (...)` balance-delta CASEs in
 * `pnl.ts` / `users-windowed-pnl.ts` — previously dropped every
 * uncategorized (NULL-category) adjustment because `NULL IN (...)` is NULL
 * and `NOT (NULL)` is NULL. The `IS NOT NULL` conjunct makes the predicate
 * FALSE for those rows, so negation keeps them; positive use is unchanged.
 */
export function statsExcludedAdjustmentSqlPredicate(opts?: {
  typeColumn?: string;
  metadataColumn?: string;
}): string {
  const typeCol = opts?.typeColumn ?? "type";
  const metaCol = opts?.metadataColumn ?? "metadata";
  const list = STATS_EXCLUDED_ADJUSTMENT_CATEGORY_KEYS.map(
    (k) => `'${k.replace(/'/g, "''")}'`,
  ).join(",");
  return `${typeCol}::text = 'admin_balance_adjustment' AND ${metaCol}->>'adjustment_category' IS NOT NULL AND ${metaCol}->>'adjustment_category' IN (${list})`;
}
