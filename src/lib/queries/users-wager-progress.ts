import "server-only";

import { getDb } from "@/lib/db";
import {
  getWagerRequirementDefaults,
  getUserWagerRequirement,
} from "@/lib/backend-api/wager-requirements";

/**
 * Per-user withdrawal wager-requirement PROGRESS (read-only).
 *
 * WHAT THIS IS
 * ────────────
 * The game backend gates every balance withdrawal behind a lifetime wager
 * requirement summed across five source buckets (deposit / bonus / affiliate
 * / rakeback / tips), each scaled by its own bps knob, with per-game weights
 * scaling how much a wager counts. The backend MAINTAINS the running progress
 * value directly on `balances.wager_requirement_progress` (the weighted wager
 * a user has already cleared) plus the five lifetime source totals
 * (`total_deposited`, `total_bonus_won`, …) and the per-source still-locked
 * amounts (`unwagered_*_usd`).
 *
 * This query READS those backend-written columns and combines them with the
 * bps knobs from the backend admin API to surface, on the user's admin
 * profile: requirement total / completed / remaining + a per-source
 * breakdown. The `completed` figure and the five totals are 100% backend
 * truth (read straight from the columns); only `required` / `remaining` are
 * DERIVED here (total × bps), and are surfaced as estimates — see CAVEAT.
 *
 * DEV-ONLY / PROD-SAFE
 * ────────────────────
 * These `balances` columns exist on the DEV game DB but NOT on the current
 * PROD game DB. The admin queries ONE schema against both via the
 * `admin_db_env` cookie, so this MUST not assume the columns exist: we probe
 * `information_schema.columns` first and return `null` (→ the card's muted
 * "not available in this environment" state) when the sweepstakes columns are
 * absent. No `prisma/schema.prisma` change is needed — the read is raw SQL,
 * so Prisma never tries to select a prod-absent column. READ-ONLY throughout.
 *
 * CAVEAT (money-math — flagged, not guessed): the exact interaction of the
 * single per-user override (`wager_requirement_bps`; 0 = EXEMPT from the
 * ENTIRE requirement per the backend doc) with the four other site-default
 * buckets is backend logic. We encode: override 0 → required = 0; a non-zero
 * override scales ONLY the deposit bucket, the other four use site defaults.
 * That matches the API shape (only the deposit bucket has a per-user
 * override) but should be reconciled against the backend before the derived
 * `required`/`remaining` are treated as authoritative. The card labels them
 * as estimates and always leads with the backend-truth `completed` + inputs.
 */

const BPS_PER_X = 10000;

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
  /** Requirement multiplier for this bucket, in bps. null when the backend
   *  bps read failed (then `contributionUsd` is also null). */
  requirementBps: number | null;
  /** lifetimeTotalUsd × requirementBps / 10000 — the $ this source adds to
   *  the requirement. null when bps unavailable. */
  contributionUsd: number | null;
  /** Still-locked (un-wagered) balance from this source, in USD (backend
   *  truth). From the house POV this is user money we owe but is gated. */
  lockedUsd: number;
};

export type UserWagerProgress = {
  /** Weighted wager already cleared toward the requirement — backend truth
   *  (`balances.wager_requirement_progress`). */
  completedUsd: number;
  /** Σ per-source contributions — DERIVED. null when the backend bps read
   *  failed (we then show `completed` + inputs only, no estimate). */
  requiredUsd: number | null;
  /** max(0, required − completed) — DERIVED. null when `required` is null. */
  remainingUsd: number | null;
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
  /** Per-source breakdown rows. */
  sources: WagerProgressSource[];
  /** Σ of all per-source locked balances. */
  totalLockedUsd: number;
  /** Secondary shard currency (informational). */
  shards: number;
  shardWagerProgress: number;
  /** Whether the backend bps config was reachable. When false, `required` /
   *  `remaining` / per-source `requirementBps` are all null. */
  backendAvailable: boolean;
};

type RawBalanceRow = {
  total_deposited: string | null;
  total_bonus_won: string | null;
  total_affiliate_won: string | null;
  total_rakeback_won: string | null;
  total_tips_won: string | null;
  wager_requirement_progress: string | null;
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
 * Read the user's wager-requirement progress, or `null` when this DB doesn't
 * carry the sweepstakes columns (prod) or the user has no balances row.
 */
export async function getUserWagerProgress(
  userId: string,
): Promise<UserWagerProgress | null> {
  const db = await getDb();

  // ── ENV-GUARD: column presence probe (read-only catalog lookup) ──────
  // The sweepstakes columns live on DEV but not on the current PROD game DB.
  // Probe before selecting them so a prod-toggled admin gets the muted card
  // (null) instead of a 42703 "column does not exist" throw. Cheap, indexed
  // catalog read — runs only on the Account tab.
  const colCheck = await db.$queryRaw<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'balances'
         AND column_name = 'wager_requirement_progress'
    ) AS exists`;
  if (!colCheck[0]?.exists) return null;

  // ── Read the backend-written progress columns for this user ──────────
  const rows = await db.$queryRaw<RawBalanceRow[]>`
    SELECT
      total_deposited::text            AS total_deposited,
      total_bonus_won::text            AS total_bonus_won,
      total_affiliate_won::text        AS total_affiliate_won,
      total_rakeback_won::text         AS total_rakeback_won,
      total_tips_won::text             AS total_tips_won,
      wager_requirement_progress::text AS wager_requirement_progress,
      shards                           AS shards,
      shard_wager_progress::text       AS shard_wager_progress,
      unwagered_race_prize_usd::text   AS unwagered_race_prize_usd,
      unwagered_bonus_other_usd::text  AS unwagered_bonus_other_usd,
      unwagered_rakeback_usd::text     AS unwagered_rakeback_usd,
      unwagered_affiliate_usd::text    AS unwagered_affiliate_usd,
      unwagered_tips_usd::text         AS unwagered_tips_usd
    FROM balances
    WHERE user_id = ${userId}
    LIMIT 1`;
  const row = rows[0];
  if (!row) return null;

  // ── bps knobs from the backend admin API (degrade to null on failure) ─
  const [defaults, userReq] = await Promise.all([
    getWagerRequirementDefaults().catch(() => null),
    getUserWagerRequirement(userId).catch(() => null),
  ]);
  const backendAvailable = defaults !== null;

  // Per-user override semantics (per backend doc): 0 = exempt from the
  // ENTIRE requirement; a non-zero override scales the DEPOSIT bucket only.
  const depositOverrideBps = userReq?.wager_requirement_bps ?? null;
  const exempt = depositOverrideBps === 0;
  const effectiveDepositBps =
    userReq?.effective_wager_requirement_bps ??
    defaults?.wager_requirement_bps ??
    null;

  const completedUsd = num(row.wager_requirement_progress);

  // Resolve the bps for a bucket: 0 when exempt, else the supplied bps.
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
      contributionUsd: null,
      lockedUsd: 0, // deposits carry no per-source unwagered bucket
    },
    {
      key: "bonus",
      label: "Bonus winnings",
      lifetimeTotalUsd: num(row.total_bonus_won),
      requirementBps: bucketBps(defaults?.bonus_wager_requirement_bps),
      contributionUsd: null,
      lockedUsd:
        num(row.unwagered_bonus_other_usd) + num(row.unwagered_race_prize_usd),
    },
    {
      key: "affiliate",
      label: "Affiliate claims",
      lifetimeTotalUsd: num(row.total_affiliate_won),
      requirementBps: bucketBps(defaults?.affiliate_wager_requirement_bps),
      contributionUsd: null,
      lockedUsd: num(row.unwagered_affiliate_usd),
    },
    {
      key: "rakeback",
      label: "Rakeback claims",
      lifetimeTotalUsd: num(row.total_rakeback_won),
      requirementBps: bucketBps(defaults?.rakeback_wager_requirement_bps),
      contributionUsd: null,
      lockedUsd: num(row.unwagered_rakeback_usd),
    },
    {
      key: "tips",
      label: "Tips received",
      lifetimeTotalUsd: num(row.total_tips_won),
      requirementBps: bucketBps(defaults?.tips_wager_requirement_bps),
      contributionUsd: null,
      lockedUsd: num(row.unwagered_tips_usd),
    },
  ];

  // Fill per-source contributions and the requirement total.
  let requiredUsd: number | null = exempt ? 0 : backendAvailable ? 0 : null;
  for (const s of sources) {
    if (s.requirementBps == null) {
      s.contributionUsd = null;
      continue;
    }
    const contribution = (s.lifetimeTotalUsd * s.requirementBps) / BPS_PER_X;
    s.contributionUsd = contribution;
    if (requiredUsd != null) requiredUsd += contribution;
  }

  const remainingUsd =
    requiredUsd != null ? Math.max(0, requiredUsd - completedUsd) : null;

  const totalLockedUsd = sources.reduce((acc, s) => acc + s.lockedUsd, 0);

  return {
    completedUsd,
    requiredUsd,
    remainingUsd,
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
