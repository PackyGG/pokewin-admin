import "server-only";

import { getDb } from "@/lib/db";
import {
  getWagerRequirementDefaults,
  getUserWagerRequirement,
} from "@/lib/backend-api/wager-requirements";

/**
 * Per-user withdrawal wager-requirement standing (read-only).
 *
 * WHAT THIS IS
 * ────────────
 * The game backend gates balance withdrawals behind a wager requirement.
 * As of the 2026-06-14 backend rework (`PackyGG/backend` commit 74b8042c,
 * migration 0130) this is a FROZEN-RATE DEBT model, not the old cumulative
 * "Σ(lifetime total × bps) vs progress" gate:
 *
 *   • every deposit / bonus credit ADDS `amount × its_bps / 10000` to a
 *     per-balance debt counter `balances.wager_requirement_remaining`,
 *     FROZEN at the bps in effect at credit time (later admin bps changes
 *     only affect future credits);
 *   • every real weighted wager BURNS that debt down (floored at 0);
 *   • the lock is now PARTIAL, not all-or-nothing:
 *         withdrawable = max(0, available_balance − remaining_debt)
 *     i.e. the debt RESERVES that many balance dollars and everything above
 *     it is free to leave. `met` ⇔ remaining_debt ≤ 0.
 *
 * Because the debt is created at credit time, a user's HISTORICAL wager
 * surplus can no longer pre-satisfy a freshly-credited deposit/bonus (the
 * exact bug the rework fixed).
 *
 * This query READS the backend-written columns and surfaces, on the user's
 * admin profile: withdrawable-now / locked-debt (remaining) / wagered-cleared
 * + a per-source breakdown. The authoritative gate figures (`remaining`,
 * `withdrawable`, `met`) come straight from `balances.wager_requirement_
 * remaining` + `available_balance` — they are NOT recomputed here. The
 * per-source rows (lifetime totals, current weights, per-source unwagered
 * balance) are INFORMATIONAL context only: the single frozen debt is the gate
 * and is not decomposable per source from the columns.
 *
 * ENV-ADAPTIVE / DRIFT-SAFE
 * ─────────────────────────
 * The admin queries ONE schema against both the prod and dev game DBs via the
 * `admin_db_env` cookie. We probe `information_schema.columns` for the newest
 * column (`wager_requirement_remaining`) first and return `null` (→ the card's
 * muted state) if a connected DB lacks it, so schema drift degrades gracefully
 * instead of throwing 42703. No `prisma/schema.prisma` change is needed — the
 * read is raw SQL, so Prisma never selects an absent column. READ-ONLY
 * throughout.
 *
 * EXEMPTION: a per-user override of 0 bps (`user_wager_requirements`) EXEMPTS
 * the user from the entire requirement — the backend ignores the stored debt
 * live, so we mirror that by forcing `remaining = 0` (→ withdrawable = full
 * available) when exempt. The override read goes through the backend admin API
 * (degrades to non-exempt if unreachable). The per-source current weights are
 * also from that API and are informational only (they do NOT change the gate).
 */

/** Half-a-cent tolerance for the "met" comparison on Decimal(20,2) money. */
const EPSILON_USD = 0.005;

export type WagerProgressSourceKey =
  | "deposit"
  | "bonus"
  | "affiliate"
  | "rakeback"
  | "tips";

export type WagerProgressSource = {
  key: WagerProgressSourceKey;
  label: string;
  /** Lifetime total earned/deposited for this source (backend truth). */
  lifetimeTotalUsd: number;
  /** Current requirement multiplier for this bucket, in bps (informational —
   *  the live debt was frozen at credit time, which may differ). null when the
   *  backend bps read failed. */
  requirementBps: number | null;
  /** Still-locked (un-wagered) balance from this source, in USD (backend
   *  truth, `unwagered_*_usd`). From the house POV this is user money we owe
   *  but is gated. NOTE: this per-source bonus-funds counter is a DIFFERENT
   *  mechanism from the single `remaining` debt gate and the two can differ. */
  lockedUsd: number;
};

export type UserWagerProgress = {
  /** Weighted wager already cleared (lifetime) — backend truth
   *  (`balances.wager_requirement_progress`). Informational. */
  completedUsd: number;
  /** completed + remaining — informational "progress + still-owed" total
   *  (mirrors the backend's `required_wager_usd`). NOT the old cumulative
   *  Σ(total × bps) estimate. */
  requiredUsd: number;
  /** AUTHORITATIVE locked debt that gates withdrawal —
   *  `balances.wager_requirement_remaining` (0 when the user is exempt). This
   *  many balance dollars are reserved; it must be wagered off to free them. */
  remainingUsd: number;
  /** AUTHORITATIVE amount free to withdraw right now =
   *  max(0, available_balance − remaining). Equals the balance once remaining
   *  is 0. */
  withdrawableUsd: number;
  /** Current available balance (backend truth). */
  availableBalanceUsd: number;
  /** True when the requirement is satisfied (remaining ≤ 0) or the user is
   *  exempt — withdrawals are ungated. */
  met: boolean;
  /** True when the user is fully exempt (per-user override = 0). */
  exempt: boolean;
  /** Effective deposit-bucket multiplier (override ?? default), in bps. */
  effectiveDepositBps: number | null;
  /** Raw per-user override; null = no override (site default applies). */
  depositOverrideBps: number | null;
  /** Per-game weights (how much each game's wager counts), in bps. */
  gameWeights: {
    packsBps: number;
    battlesBps: number;
    upgraderBps: number;
  } | null;
  /** Per-source breakdown rows (informational context). */
  sources: WagerProgressSource[];
  /** Σ of all per-source still-locked (unwagered_*) balances. Distinct from
   *  `remaining` (the withdrawal gate, which also includes deposit debt). */
  totalLockedUsd: number;
  /** Secondary shard currency (informational). */
  shards: number;
  shardWagerProgress: number;
  /** Whether the backend bps config was reachable. When false, per-source
   *  `requirementBps` and `gameWeights` are null — but the gate figures
   *  (`remaining`/`withdrawable`/`met`) are still authoritative (column-read). */
  backendAvailable: boolean;
};

type RawBalanceRow = {
  available_balance: string | null;
  total_deposited: string | null;
  total_bonus_won: string | null;
  total_affiliate_won: string | null;
  total_rakeback_won: string | null;
  total_tips_won: string | null;
  wager_requirement_progress: string | null;
  wager_requirement_remaining: string | null;
  shards: number | null;
  shard_wager_progress: string | null;
  unwagered_race_prize_usd: string | null;
  unwagered_bonus_other_usd: string | null;
  unwagered_rakeback_usd: string | null;
  unwagered_affiliate_usd: string | null;
  unwagered_tips_usd: string | null;
};

const num = (v: string | number | null | undefined): number => {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Round to cents. Money values are `Decimal(20,2)`; the derived figures
 * (requirement total, withdrawable) are computed with JS floats, so round each
 * to the cent before display so nothing shows a $0.01 FP drift.
 */
const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Read the user's wager-requirement standing, or `null` when this DB doesn't
 * carry the frozen-debt column (drift) or the user has no balances row.
 */
export async function getUserWagerProgress(
  userId: string,
): Promise<UserWagerProgress | null> {
  const db = await getDb();

  // ── ENV-GUARD: column presence probe (read-only catalog lookup) ──────
  // Probe the newest column (`wager_requirement_remaining`, added by backend
  // migration 0130) before selecting it, so a DB that lacks it gets the muted
  // card (null) instead of a 42703 "column does not exist" throw. Cheap,
  // indexed catalog read — runs only on the Account tab.
  const colCheck = await db.$queryRaw<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'balances'
         AND column_name = 'wager_requirement_remaining'
    ) AS exists`;
  if (!colCheck[0]?.exists) return null;

  // ── Read the backend-written columns for this user ───────────────────
  const rows = await db.$queryRaw<RawBalanceRow[]>`
    SELECT
      available_balance::text            AS available_balance,
      total_deposited::text              AS total_deposited,
      total_bonus_won::text              AS total_bonus_won,
      total_affiliate_won::text          AS total_affiliate_won,
      total_rakeback_won::text           AS total_rakeback_won,
      total_tips_won::text               AS total_tips_won,
      wager_requirement_progress::text   AS wager_requirement_progress,
      wager_requirement_remaining::text  AS wager_requirement_remaining,
      shards                             AS shards,
      shard_wager_progress::text         AS shard_wager_progress,
      unwagered_race_prize_usd::text     AS unwagered_race_prize_usd,
      unwagered_bonus_other_usd::text    AS unwagered_bonus_other_usd,
      unwagered_rakeback_usd::text       AS unwagered_rakeback_usd,
      unwagered_affiliate_usd::text      AS unwagered_affiliate_usd,
      unwagered_tips_usd::text           AS unwagered_tips_usd
    FROM balances
    WHERE user_id = ${userId}
    LIMIT 1`;
  const row = rows[0];
  if (!row) return null;

  // ── bps knobs from the backend admin API (degrade to null on failure) ─
  // Only used for the informational per-source weights + exemption flag; the
  // gate figures below are column-read and don't depend on this.
  const [defaults, userReq] = await Promise.all([
    getWagerRequirementDefaults().catch(() => null),
    getUserWagerRequirement(userId).catch(() => null),
  ]);
  const backendAvailable = defaults !== null;

  // Per-user override semantics (per backend doc): 0 = exempt from the ENTIRE
  // requirement; a non-zero override scales the DEPOSIT bucket only.
  const depositOverrideBps = userReq?.wager_requirement_bps ?? null;
  const exempt = depositOverrideBps === 0;
  const effectiveDepositBps =
    userReq?.effective_wager_requirement_bps ??
    defaults?.wager_requirement_bps ??
    null;

  // ── AUTHORITATIVE withdrawal gate (frozen-rate debt — see header) ────
  const availableBalanceUsd = round2(num(row.available_balance));
  // Exempt users have their debt ignored live by the backend, so force 0.
  const remainingUsd = exempt
    ? 0
    : round2(num(row.wager_requirement_remaining));
  const withdrawableUsd = round2(
    Math.max(0, availableBalanceUsd - remainingUsd),
  );
  const met = exempt || remainingUsd <= EPSILON_USD;

  // Informational: lifetime weighted wager cleared + still-owed debt.
  const completedUsd = round2(num(row.wager_requirement_progress));
  const requiredUsd = round2(completedUsd + remainingUsd);

  // Resolve the informational current bps for a bucket: 0 when exempt.
  const bucketBps = (bps: number | null | undefined): number | null => {
    if (exempt) return 0;
    return bps ?? null;
  };

  const sources: WagerProgressSource[] = [
    {
      key: "deposit",
      label: "Deposits",
      lifetimeTotalUsd: num(row.total_deposited),
      requirementBps: bucketBps(effectiveDepositBps),
      lockedUsd: 0, // deposits carry no per-source unwagered bucket
    },
    {
      key: "bonus",
      label: "Bonus winnings",
      lifetimeTotalUsd: num(row.total_bonus_won),
      requirementBps: bucketBps(defaults?.bonus_wager_requirement_bps),
      lockedUsd: round2(
        num(row.unwagered_bonus_other_usd) + num(row.unwagered_race_prize_usd),
      ),
    },
    {
      key: "affiliate",
      label: "Affiliate claims",
      lifetimeTotalUsd: num(row.total_affiliate_won),
      requirementBps: bucketBps(defaults?.affiliate_wager_requirement_bps),
      lockedUsd: num(row.unwagered_affiliate_usd),
    },
    {
      key: "rakeback",
      label: "Rakeback claims",
      lifetimeTotalUsd: num(row.total_rakeback_won),
      requirementBps: bucketBps(defaults?.rakeback_wager_requirement_bps),
      lockedUsd: num(row.unwagered_rakeback_usd),
    },
    {
      key: "tips",
      label: "Tips received",
      lifetimeTotalUsd: num(row.total_tips_won),
      requirementBps: bucketBps(defaults?.tips_wager_requirement_bps),
      lockedUsd: num(row.unwagered_tips_usd),
    },
  ];

  const totalLockedUsd = round2(
    sources.reduce((acc, s) => acc + s.lockedUsd, 0),
  );

  return {
    completedUsd,
    requiredUsd,
    remainingUsd,
    withdrawableUsd,
    availableBalanceUsd,
    met,
    exempt,
    effectiveDepositBps,
    depositOverrideBps,
    gameWeights: defaults
      ? {
          packsBps: defaults.wager_weight_packs_bps,
          battlesBps: defaults.wager_weight_battles_bps,
          upgraderBps: defaults.wager_weight_upgrader_bps,
        }
      : null,
    sources,
    totalLockedUsd,
    shards: num(row.shards),
    shardWagerProgress: num(row.shard_wager_progress),
    backendAvailable,
  };
}
