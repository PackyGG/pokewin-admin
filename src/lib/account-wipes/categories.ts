/**
 * categories.ts — the SINGLE client+server-safe source of truth for the
 * full account-wipe category list: which categories exist, how they group,
 * which are CREATOR-PROTECTED (disabled + server-rejected for an is/was-
 * creator), which are LIVE-FINANCIAL (need a per-category danger warning),
 * and which ship ENABLED vs DISABLED ("coming soon").
 *
 * Pure constants + pure data (no DB, no secrets, no env, no "server-only").
 * Imported by BOTH the server wipe actions AND the "use client" wipe dialog
 * so the on-screen category set, the protected/disabled flags, and the
 * server-side guard list can never drift.
 *
 * ─── WHY SOME CATEGORIES SHIP DISABLED (safety mandate) ──────────────────
 *
 * Owner mandate: this is the most destructive feature in the app — it can
 * delete live production game-DB financial / ledger / gaming history. EVERY
 * category must be snapshot-first + fully recoverable. If a category cannot
 * be GUARANTEED recoverable, it ships DISABLED ("coming soon") rather than as
 * an unrecoverable delete.
 *
 * The four original categories (adjustments / balance / vault / inventory)
 * and the new `deposits` category are pure, isolated row sets (or a fungible
 * pool) with a proven snapshot → delete → restore path and NO inbound FK
 * children that a delete would orphan — they are genuinely recoverable and
 * ship ENABLED.
 *
 * The new `wager` category (the "Wipe wager / gameplay" target) is ALSO
 * ENABLED: it deletes the user's wager + payout LEDGER legs (pack/battle/
 * upgrader bets + battle payout legs), the won pack/battle `user_inventory`
 * rows (+ their `provably_fair_results` children), and the `upgrader_games`
 * rows — exactly the rows that drive GGR / wager / gaming-margin / P&L and the
 * transaction list. Its inbound FK cycle (ledger ↔ game_sessions) is broken by
 * nulling the cross pointers (`game_sessions.bet_ledger_tx_id`,
 * `balances.last_transaction_id`) before the delete; the `game_sessions` /
 * `battles` shells are deliberately LEFT intact (deleting a battle would
 * cascade OTHER participants' rows — see the action's FK notes), and any
 * withdrawal-locked won card is skipped + flagged (it backs an in-flight
 * withdrawal). Snapshot-first + recoverable (best-effort for the gameplay
 * graph). NOT creator-protected (gameplay is the user's own activity), but it
 * never raises the balance (BALANCE RULE).
 *
 * The remaining categories touch row sets with INBOUND foreign-key children
 * or denormalized cross-table state whose faithful recovery cannot be
 * GUARANTEED in this iteration (and could not be proven against the live DB):
 *   • withdrawals  — `card_withdrawal_requests` carries shipping / crypto /
 *                    fireblocks / tracking state + multiple admin FK columns;
 *                    a delete+restore of an in-flight or completed withdrawal
 *                    cannot be guaranteed faithful.
 *   • finances     — broad financial ledger types, several of which
 *                    (gift_card_redeemed / promo_code_redeemed / race_prize /
 *                    rakeback_claim) are referenced by child rows
 *                    (gift_cards / promo_code_redemptions / race_claims /
 *                    rakeback_claims) that a delete would orphan or be
 *                    blocked by (FK RESTRICT).
 *   • rewards      — reward ledger types with the SAME inbound FK children as
 *                    finances; not safely deletable without also snapshotting
 *                    + re-linking those children.
 *   • gaming       — `battles` / `battle_participants` / `game_sessions` /
 *                    `upgrader_games` / `provably_fair_results` form a deep
 *                    FK graph (game_sessions is referenced by many tables);
 *                    a recoverable delete cannot be guaranteed here.
 *   • affiliate    — `affiliate_accounts` / `affiliate_code_usages` /
 *                    `affiliate_codes` carry denormalized lifetime counters
 *                    and attribution linkage whose faithful restore cannot be
 *                    guaranteed; also creator-protected for ever-creators.
 *   • account      — account-level fields are not yet precisely defined as a
 *                    recoverable unit.
 *
 * Each disabled category is surfaced in the UI with a "coming soon" note and
 * its reason, and is hard-rejected server-side. They are wired into the
 * taxonomy now so enabling one later is a single flag flip + its action.
 */

/** Every wipe category key. Stable string ids (used in audit + the guard). */
export type WipeCategory =
  // ── Original recoverable set (ENABLED) ──
  | "adjustments"
  | "balance"
  | "vault"
  | "inventory"
  // ── New recoverable categories (ENABLED) ──
  | "deposits"
  | "wager"
  // ── Expanded categories (shipped DISABLED — see reasons above) ──
  | "withdrawals"
  | "finances"
  | "rewards"
  | "gaming"
  | "affiliate"
  | "account";

/** Visual / organisational group a category belongs to in the panel. */
export type WipeCategoryGroup =
  | "balance_content"
  | "finance"
  | "rewards"
  | "gaming"
  | "affiliate"
  | "account";

export type WipeCategoryMeta = {
  key: WipeCategory;
  /** Lucide icon NAME (resolved to the component in the client dialog — keeps this module icon-lib-free). */
  icon: WipeCategoryIcon;
  label: string;
  /** Short one-line description shown under the label. */
  blurb: string;
  group: WipeCategoryGroup;
  /**
   * CREATOR-PROTECTED: when the target user IS or WAS a creator this category
   * is DISABLED in the UI ("Protected — creator") AND hard-rejected
   * server-side. For a non-creator it behaves normally. The owner-mandated
   * protected set: creator deal/fill data, affiliate claims, affiliate codes,
   * deposits, withdrawals.
   */
  creatorProtected: boolean;
  /**
   * LIVE-FINANCIAL: deletes real financial / transaction history (as opposed
   * to house-granted content value). Drives the per-category red danger
   * warning ("Deletes real financial/transaction history — recoverable via
   * snapshot").
   */
  liveFinancial: boolean;
  /**
   * ENABLED: a snapshot-first + fully-recoverable action exists and is wired.
   * DISABLED categories render greyed-out with `disabledReason` and are
   * hard-rejected server-side (the safety mandate: ship disabled rather than
   * unrecoverable).
   */
  enabled: boolean;
  /** Why a DISABLED category is not yet available (shown in the UI). Empty for enabled. */
  disabledReason: string;
};

/** Icon names the client dialog maps to lucide components. */
export type WipeCategoryIcon =
  | "sliders"
  | "wallet"
  | "archive"
  | "package"
  | "arrow-down-to-line"
  | "arrow-up-from-line"
  | "receipt"
  | "gift"
  | "gamepad"
  | "users"
  | "user-cog";

/**
 * The canonical ordered category list. Order is the render order in the
 * panel: the enabled recoverable set first (content + balance pools +
 * inventory + deposits), then the grouped expanded categories.
 */
export const WIPE_CATEGORIES: readonly WipeCategoryMeta[] = [
  // ── Balance & content (ENABLED — house-granted content value) ──
  {
    key: "adjustments",
    icon: "sliders",
    label: "Content balance adjustments",
    blurb:
      "Admin-granted balance credits you select below. Snapshotted + recoverable.",
    group: "balance_content",
    creatorProtected: false,
    liveFinancial: false,
    enabled: true,
    disabledReason: "",
  },
  {
    key: "balance",
    icon: "wallet",
    label: "Balance",
    blurb: "Sets spendable balance to $0. Snapshotted + recoverable.",
    group: "balance_content",
    creatorProtected: false,
    liveFinancial: false,
    enabled: true,
    disabledReason: "",
  },
  {
    key: "vault",
    icon: "archive",
    label: "Vault",
    blurb: "Sets the vault (locked balance) to $0 and clears its unlock window.",
    group: "balance_content",
    creatorProtected: false,
    liveFinancial: false,
    enabled: true,
    disabledReason: "",
  },
  {
    key: "inventory",
    icon: "package",
    label: "Inventory",
    blurb:
      "Hard-deletes every currently-held inventory item (sold/exchanged/withdrawn items are left as historical record). Snapshotted + recoverable.",
    group: "balance_content",
    creatorProtected: false,
    liveFinancial: false,
    enabled: true,
    disabledReason: "",
  },

  // ── Finance ──
  {
    key: "deposits",
    icon: "arrow-down-to-line",
    label: "Deposits",
    blurb:
      "Deletes the user's deposit ledger rows and reduces the lifetime deposited counter. Snapshotted + recoverable.",
    group: "finance",
    creatorProtected: true,
    liveFinancial: true,
    enabled: true,
    disabledReason: "",
  },
  {
    key: "withdrawals",
    icon: "arrow-up-from-line",
    label: "Withdrawals",
    blurb:
      "Deletes withdrawal requests + their ledger rows.",
    group: "finance",
    creatorProtected: true,
    liveFinancial: true,
    enabled: false,
    disabledReason:
      "Withdrawal requests carry shipping / crypto / tracking state and multiple admin references — a faithful, fully-recoverable delete is not yet guaranteed.",
  },
  {
    key: "finances",
    icon: "receipt",
    label: "Finances / transactions",
    blurb:
      "Deletes general financial transaction ledger rows.",
    group: "finance",
    creatorProtected: false,
    liveFinancial: true,
    enabled: false,
    disabledReason:
      "Several financial ledger types are referenced by child rows (gift cards / promo / race / rakeback claims) that a delete would orphan — not yet guaranteed recoverable.",
  },

  // ── Rewards ──
  {
    key: "rewards",
    icon: "gift",
    label: "Rewards",
    blurb:
      "Deletes reward-payout ledger rows (bonuses, rakeback, race/raffle prizes, gift cards, promos).",
    group: "rewards",
    creatorProtected: false,
    liveFinancial: true,
    enabled: false,
    disabledReason:
      "Reward ledger rows are linked to claim/redemption child rows (rakeback / race / promo / gift cards); deleting them safely needs those children snapshotted + re-linked — not yet guaranteed recoverable.",
  },

  // ── Gaming ──
  {
    key: "wager",
    icon: "gamepad",
    label: "Wager / gameplay",
    blurb:
      "Deletes the user's wager + payout ledger legs (pack/battle/upgrader bets + battle payouts), their won pack/battle inventory, and upgrader games — so their wager + wager-loss stop driving GGR / the gaming margin / P&L. Snapshotted + recoverable.",
    group: "gaming",
    creatorProtected: false,
    liveFinancial: true,
    enabled: true,
    disabledReason: "",
  },
  {
    key: "gaming",
    icon: "gamepad",
    label: "Gaming logs",
    blurb:
      "Deletes the user's gaming session shells (game_sessions / battles / provably-fair results).",
    group: "gaming",
    creatorProtected: false,
    liveFinancial: true,
    enabled: false,
    disabledReason:
      "The session/battle shells form a deep cross-table graph (battles cascade other participants) — a fully-recoverable delete of the shells cannot yet be guaranteed. The wager + payout legs + won inventory + upgrader games (what drives the margin) ARE deletable via “Wager / gameplay” above.",
  },

  // ── Affiliate ──
  {
    key: "affiliate",
    icon: "users",
    label: "Affiliate",
    blurb:
      "Deletes the user's affiliate account, code usages and attribution.",
    group: "affiliate",
    creatorProtected: true,
    liveFinancial: true,
    enabled: false,
    disabledReason:
      "Affiliate records carry denormalized lifetime counters and referral attribution whose faithful restore is not yet guaranteed (and is creator-protected for creators).",
  },

  // ── Account ──
  {
    key: "account",
    icon: "user-cog",
    label: "Account",
    blurb: "Resets account-level fields.",
    group: "account",
    creatorProtected: false,
    liveFinancial: false,
    enabled: false,
    disabledReason:
      "The exact account-level fields that form a recoverable unit are not yet defined.",
  },
] as const;

/** Group display labels + order for the panel section headers. */
export const WIPE_CATEGORY_GROUPS: readonly {
  key: WipeCategoryGroup;
  label: string;
}[] = [
  { key: "balance_content", label: "Balance & content" },
  { key: "finance", label: "Finance" },
  { key: "rewards", label: "Rewards" },
  { key: "gaming", label: "Gaming" },
  { key: "affiliate", label: "Affiliate" },
  { key: "account", label: "Account" },
] as const;

const META_BY_KEY: Record<WipeCategory, WipeCategoryMeta> = Object.fromEntries(
  WIPE_CATEGORIES.map((c) => [c.key, c]),
) as Record<WipeCategory, WipeCategoryMeta>;

/** Look up a category's metadata by key. */
export function wipeCategoryMeta(key: WipeCategory): WipeCategoryMeta {
  return META_BY_KEY[key];
}

/** The categories that are creator-protected (disabled + server-rejected for an ever-creator). */
export const CREATOR_PROTECTED_CATEGORIES: readonly WipeCategory[] =
  WIPE_CATEGORIES.filter((c) => c.creatorProtected).map((c) => c.key);

const CREATOR_PROTECTED_SET: ReadonlySet<WipeCategory> = new Set(
  CREATOR_PROTECTED_CATEGORIES,
);

/** True if a category is in the creator-protected set. */
export function isCreatorProtectedCategory(key: WipeCategory): boolean {
  return CREATOR_PROTECTED_SET.has(key);
}

const ENABLED_SET: ReadonlySet<string> = new Set(
  WIPE_CATEGORIES.filter((c) => c.enabled).map((c) => c.key),
);

/** True if a category has a wired, recoverable action (not shipped disabled). */
export function isEnabledCategory(key: string): key is WipeCategory {
  return ENABLED_SET.has(key);
}

/**
 * SERVER-SIDE policy gate (must mirror the UI): given a category and the
 * target user's ever-creator flag, is this category ALLOWED to be wiped?
 *
 *   • A DISABLED (coming-soon) category is NEVER allowed — it has no
 *     recoverable action.
 *   • A creator-protected category is NOT allowed when the user is/was a
 *     creator.
 *   • Otherwise allowed.
 *
 * Returns a reason string when blocked (for the action's error), or null
 * when allowed. The wipe actions call this BEFORE doing anything destructive,
 * with the server-re-derived `everCreator` flag — never a client-passed one.
 */
export function wipeCategoryBlockReason(
  key: WipeCategory,
  everCreator: boolean,
): string | null {
  const meta = META_BY_KEY[key];
  if (!meta) return "Unknown wipe category";
  if (!meta.enabled) {
    return `The "${meta.label}" wipe is not available yet`;
  }
  if (meta.creatorProtected && everCreator) {
    return `"${meta.label}" is protected for creators and cannot be wiped`;
  }
  return null;
}
