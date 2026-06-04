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
 * Client-safe: pure value module, no DB / `server-only` import, so the
 * dialog component can import the labels + required-input flags directly.
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
  "giveaway",
  "bonus",
  "reload",
  "lossback",
  "leaderboard",
  "official_stream",
  "other",
] as const;

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
export const REMOVAL_ONLY_ADJUSTMENT_CATEGORY_KEYS = ["leaderboard"] as const;

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
    !isRemovalOnlyAdjustmentCategory(k),
) as readonly Exclude<
  BalanceAdjustmentCategory,
  "other" | "official_stream" | RemovalOnlyAdjustmentCategory
>[];

/**
 * The SELECTABLE categories — the set an admin may pick in the
 * Adjust-Balance dialog dropdown GOING FORWARD. `other` is intentionally
 * excluded from the picker (it was an uncategorized residual escape hatch
 * that we no longer want admins choosing). Removal-only categories (e.g.
 * `leaderboard`) STAY selectable — the dialog gates them to the
 * remove-balance direction at render time rather than removing them here.
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
  (k) => k !== "other",
) as readonly Exclude<BalanceAdjustmentCategory, "other">[];

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
  reload: {
    key: "reload",
    label: "Reload",
    costLabel: "Reload credits",
    why: "Reload bonus credited to a user's balance. A house-funded retention cost.",
    counted: true,
  },
  lossback: {
    key: "lossback",
    label: "Lossback",
    costLabel: "Lossback credits",
    why: "Loss-rebate credited back to a user (a % of their recent losses). A house-funded retention cost.",
    counted: true,
  },
  leaderboard: {
    key: "leaderboard",
    label: "Leaderboard",
    costLabel: "Leaderboard debits",
    why: "Balance REMOVED from a user and linked to a creator's leaderboard. A removal (debit) — NOT counted in the reward-cost / NGR side here (the counted-credit predicates only sum money given to users). Creator-leaderboard cost accounting is a separate follow-up.",
    counted: false,
  },
  official_stream: {
    key: "official_stream",
    label: "Official stream",
    costLabel: "Official-stream adjustments (uncounted)",
    why: "Balance adjustment linked to a creator's official stream (can ADD or REMOVE balance). NOT counted in GGR/NGR/cost here — it only persists the creator link (`metadata.creator_id`). Cost accounting is a deliberate follow-up, exactly like `leaderboard`.",
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
