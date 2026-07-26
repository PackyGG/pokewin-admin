import "server-only";

import { unstable_cache } from "next/cache";

import {
  queryMainRows,
  queryMainRowsInTimeboxedTx,
} from "@/lib/drizzle-query";
import { toNumber } from "@/lib/utils/decimal";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { escapeBlacklistIds } from "@/lib/queries/_blacklist";
import { readDbEnv } from "@/lib/db-env";
import { CREATOR_PNL_STATEMENT_TIMEOUT_MS } from "@/lib/queries/creators-pnl";
import { WITHDRAWAL_LIABILITY_STATUSES } from "@/lib/queries/pnl";

/**
 * Creator Hub — `creators/[id]` **Risk** tab data (wager-saving / perk-abuse
 * detector). Owner spec (iridescent-mixing-lecun.md → "New tab: Risk").
 *
 * ─── WHAT THIS DETECTS ───────────────────────────────────────────────
 *
 * A user abusing a creator's code (leaderboard / rakeback / perks) by
 * "saving wager": piling up wager VOLUME while dodging the expected loss,
 * so they farm leaderboard/perk rewards without taking real risk.
 *
 * Over high volume a fair player's result converges to ≈ −(wager × edge),
 * i.e. the HOUSE PnL on that player should be ≈ +(wager × edge). We compute
 * the EXPECTED house GGR for each referred user from their actual game mix
 * and compare it to their ACTUAL realised house PnL. A user whose actual
 * house PnL is FAR BELOW expected (a large gap in the USER's favour) is the
 * suspicious case — they're not taking the edge.
 *
 *   expectedGgr = Σ_game ( wager_game × edge_game )
 *   actualPnl   = deposits − cardWithdrawals   (house-POV, depositor-gated)
 *   gap         = expectedGgr − actualPnl      (>0 ⇒ user took less loss
 *                                               than the edge predicts)
 *   shortfall%  = gap / expectedGgr            (how far below expected)
 *
 * Owner example: deposited $36k, wagered $200k, house PnL ≈ ±$100 →
 * expectedGgr ≈ 10.8% × $200k ≈ $21.6k → ~$21.6k gap → flagged.
 *
 * ─── BLENDED EDGE (owner-locked rates) ───────────────────────────────
 *
 * packs 10.8%, battles 10.8% (same as packs), upgrader 10%. These are the
 * owner's Risk-tool edge assumptions — DISTINCT from the 7.5% deal-value
 * rate used by the Profitable-Algo / Forecast tools (kept separate on
 * purpose). The expected GGR is weighted by each user's ACTUAL per-game
 * wager mix (not a flat blended %), so a pack-heavy user and a
 * battle-heavy user are each judged against their own game's edge.
 *
 * ─── WHY THESE ARE THE RIGHT NUMBERS (reuse, not reinvention) ─────────
 *
 * Attribution + the PnL definition mirror the canonical creator-PnL scan
 * (`src/lib/queries/creators-pnl.ts`) EXACTLY:
 *   • Wager   — `acu.wager_amount_usd` for `usage_type='wager'` rows under
 *     this creator. Borrow-correction is already baked into that column at
 *     write time (see leaderboard-wager-by-board.ts), so "count only the
 *     NON-borrowed wager" (owner-locked) is satisfied by sourcing this
 *     column — we add no new wager definition. Per-game split is via
 *     `acu.game_session_id → game_sessions.game_type`.
 *   • Deposits — ledger deposits whose 7-day coverage code at deposit time
 *     was THIS creator (the `COVERING_CREATOR_SQL` reconstruction), so a
 *     returning user's later non-coded deposits still attribute correctly.
 *   • Card withdrawals — value of cards/vouchers that physically left the
 *     house from sessions wagered under this creator's code (the same
 *     `inventory_item_ids / voucher_ids → source_id → acu session` chain),
 *     restricted to coverage-depositors so a wager-only user can't drag the
 *     PnL down.
 *   • actualPnl = deposits − cardWithdrawals, depositor-gated — byte-for-
 *     byte the per-user formula `creators-pnl.ts` uses.
 *
 * Everything is LIFETIME, capped at 365 days (`LIFETIME_LOOKBACK_DAYS`),
 * the same lifetime guard creators-pnl.ts uses so the scan never runs
 * unbounded. Staff / creator roles, the creator's own id, and the
 * `excluded_users` blacklist are dropped, same cohort as every creator
 * surface.
 *
 * ─── PERF (LAZY, owner-mandated) ─────────────────────────────────────
 *
 * The whole scan runs ONLY when the Risk tab is opened (the tab component
 * is the only caller), inside a single interactive transaction with a
 * raised per-statement timeout so the cold scan completes, then cached
 * per-creator (prod-pinned, same precedent as `_pnl-cache.ts`). MAIN/prod
 * game DB is READ-ONLY — every statement here is a SELECT.
 *
 * ─── DATA GAP (verified on prod, read-only, 2026-06-06) ──────────────
 *
 * The behavioural "high-win-chance (~90%) upgrader" flag (owner spec)
 * REQUIRES per-bet upgrader target-multiplier / win-chance data. Verified
 * against the live prod DB: the `game_type` enum is `{pack, battle}` only
 * — `upgrader` is NOT a value, there are ZERO upgrader game_sessions, and
 * there is NO `upgrader_games` table. Upgrader is not live on prod yet.
 * So the per-bet upgrader signal has no readable data and is reported as a
 * DATA GAP (not fabricated). The code is written to light it up
 * automatically once upgrader ships (it reads the canonical
 * `provably_fair_results.result_metadata` target-multiplier the rest of
 * the codebase uses — see `parseUpgraderMetadata`). Until then we still
 * infer low-variance abuse from the expected-vs-actual PnL gap, which does
 * not depend on upgrader.
 */

// ── Owner-locked blended-edge rates (Risk tool only) ─────────────────
// Distinct from the 7.5% deal-value rate (Profitable Algo / Forecast).
export const RISK_EDGE_BY_GAME = {
  pack: 0.108,
  battle: 0.108,
  upgrader: 0.1,
} as const;

type RiskGame = keyof typeof RISK_EDGE_BY_GAME;

// Default shortfall threshold: flag when actual house PnL is ≥50% BELOW
// the expected GGR (owner: "default threshold ~50%"). I.e. shortfall%
// (= gap / expectedGgr) ≥ 0.5 on a user with a material expected GGR.
export const RISK_DEFAULT_SHORTFALL_THRESHOLD = 0.5;

// A user needs a minimum expected GGR before a shortfall % is meaningful
// — on $5 of expected GGR a $5 gap is noise, not abuse. Mirrors the
// MIN_SAMPLE spirit of the metrics layer (don't flag thin volume).
const RISK_MIN_EXPECTED_GGR_USD = 50;

// Lifetime lookback cap — same 365-day guard as creators-pnl.ts so the
// scan is bounded.
const LIFETIME_LOOKBACK_DAYS = 365;
const LIFETIME_LOOKBACK_INTERVAL = `INTERVAL '${LIFETIME_LOOKBACK_DAYS} days'`;

// Cold-scan statement timeout — the scan runs at most once per cache TTL,
// so a generous budget is safe (same reasoning as creators-pnl.ts).

const CACHE_TTL_SECONDS = 300;

// Hard cap on referred users surfaced (worst-first). A code cohort can be
// large; the table shows the riskiest. The COHORT-WIDE summary counts are
// computed from ALL users (uncapped) before the slice.
const MAX_USERS = 200;

const WD_LIABILITY_STATUS_SQL = `(${WITHDRAWAL_LIABILITY_STATUSES.map(
  (s) => `'${s}'`,
).join(", ")})`;

// Covering-creator subquery — identical semantics to creators-pnl.ts:
// the most-recent acu code within the deposit's 7-day coverage window.
const COVERING_CREATOR_SQL = `(
  SELECT acu_c.affiliate_user_id
    FROM affiliate_code_usages acu_c
   WHERE acu_c.referred_user_id = lt.user_id
     AND acu_c.created_at <= lt.created_at
     AND acu_c.created_at >= lt.created_at - INTERVAL '7 days'
   ORDER BY acu_c.created_at DESC
   LIMIT 1
)`;

// Withdrawn-unit derived table — identical to creators-pnl.ts: one row per
// value-unit (card OR session-linked voucher) leaving the house via a
// liability-status card_withdrawal_request, valued at obtainment, keyed on
// the producing game_session_id so it can be attributed to the creator's
// acu wager sessions.
const WITHDRAWN_UNITS_SQL = `(
  SELECT cwr_unnested.withdrawn_at,
         ui.user_id, ui.source_id, ui.value_at_obtained::numeric AS value
    FROM (
      SELECT COALESCE(cwr.shipped_at, cwr.completed_at, cwr.processing_at, cwr.requested_at) AS withdrawn_at,
             UNNEST(cwr.inventory_item_ids) AS item_id
        FROM card_withdrawal_requests cwr
       WHERE cwr.status IN ${WD_LIABILITY_STATUS_SQL}
    ) cwr_unnested
    JOIN user_inventory ui ON ui.id = cwr_unnested.item_id
   WHERE ui.source_type::text IN ('pack', 'battle')
  UNION ALL
  SELECT cwr_unnested.withdrawn_at,
         v.user_id, v.origin_id AS source_id, v.value::numeric AS value
    FROM (
      SELECT COALESCE(cwr.shipped_at, cwr.completed_at, cwr.processing_at, cwr.requested_at) AS withdrawn_at,
             UNNEST(cwr.voucher_ids) AS voucher_id
        FROM card_withdrawal_requests cwr
       WHERE cwr.status IN ${WD_LIABILITY_STATUS_SQL}
    ) cwr_unnested
    JOIN vouchers v ON v.id = cwr_unnested.voucher_id
   WHERE v.origin::text IN ('battle_excess_to_voucher', 'pack_borrow_to_voucher')
)`;

/** Per-game wager (non-borrowed, code-attributed) for one referred user. */
export type RiskGameWager = {
  game: RiskGame | "unknown";
  wagerUsd: number;
  /** Expected house GGR contribution from this game (wager × edge). */
  expectedGgrUsd: number;
};

/** One referred user's risk row (house-POV). */
export type RiskUserRow = {
  userId: string;
  username: string | null;
  image: string | null;
  /** Coverage-attributed lifetime deposits under this creator (capped 365d). */
  depositsUsd: number;
  /** Total non-borrowed wager under this creator's code (capped 365d). */
  wagerUsd: number;
  /** Per-game wager split (pack / battle / upgrader / unknown). */
  byGame: RiskGameWager[];
  /** Value of attributed card/voucher withdrawals (capped 365d). */
  cardWithdrawalsUsd: number;
  /**
   * Actual realised house PnL = deposits − cardWithdrawals. House-POV:
   * emerald positive = house kept value; rose negative = cards out
   * exceeded deposits. Depositor-gated (0 for non-depositors).
   */
  actualPnlUsd: number;
  /** Expected house GGR = Σ wager_game × edge_game (user's mix). */
  expectedGgrUsd: number;
  /**
   * Deviation gap = expectedGgr − actualPnl. POSITIVE = the user took
   * LESS loss than the edge predicts (the suspicious direction — they're
   * "saving wager"). Negative = they lost MORE than expected (fine).
   */
  gapUsd: number;
  /**
   * Shortfall fraction = gap / expectedGgr (only when expectedGgr ≥
   * RISK_MIN_EXPECTED_GGR_USD; null otherwise — too thin to judge).
   * 1.0 = took none of the edge; 0 = exactly at expectation.
   */
  shortfallPct: number | null;
  /**
   * Whether this user actually deposited cash under this creator's code
   * (has ≥1 coverage-attributed deposit). Non-depositors' card
   * withdrawals are excluded from PnL, same as creators-pnl.ts.
   */
  isDepositor: boolean;
  /** True when shortfallPct ≥ the active threshold (wager-saving flag). */
  flagged: boolean;
  /**
   * Risk score 0–100 — how far below expectation, scaled by the
   * shortfall fraction (clamped). Drives the worst-first sort + the
   * severity badge. Null when not judgeable (thin expected GGR).
   */
  riskScore: number | null;
};

export type RiskData = {
  /** Threshold (shortfall fraction) used for the flag this render. */
  threshold: number;
  /** Lifetime lookback cap in days (label context). */
  lookbackDays: number;
  /** Per-user rows, worst-first, capped at MAX_USERS. */
  users: RiskUserRow[];
  /** Cohort size considered (uncapped, post-filter). */
  cohortUserCount: number;
  /** Count of flagged users across the whole cohort (uncapped). */
  flaggedCount: number;
  /** Σ expected GGR across the cohort (uncapped). */
  totalExpectedGgrUsd: number;
  /** Σ actual PnL across the cohort (uncapped). */
  totalActualPnlUsd: number;
  /** Σ gap across the cohort (uncapped) — total value "saved" by users. */
  totalGapUsd: number;
  /**
   * Per-bet upgrader behavioural signal (high-win-chance grinding).
   * `available=false` on prod today — upgrader isn't live (see module
   * doc). When it ships this carries the readable signal.
   */
  upgraderSignal: UpgraderBehaviorSignal;
  /** True when at least one underlying scan degraded (numbers are partial). */
  partial: boolean;
};

/** Behavioural low-variance upgrader signal (data-gap-aware). */
export type UpgraderBehaviorSignal = {
  /** Whether per-bet upgrader target/chance data is readable at all. */
  available: boolean;
  /** Human reason when unavailable (shown in the UI, never fabricated). */
  unavailableReason: string | null;
  /**
   * When available: count of referred-user upgrader bets at a high target
   * win-chance (≥ HIGH_WIN_CHANCE_PCT). Null when unavailable.
   */
  highWinChanceBets: number | null;
  /** When available: total upgrader bets scanned. Null when unavailable. */
  totalUpgraderBets: number | null;
};

/** The "low-variance" upgrader threshold (owner: ~90% win chance). */
const HIGH_WIN_CHANCE_PCT = 80;

type PerUserRow = {
  user_id: string;
  username: string | null;
  image: string | null;
  deposits: string;
  card_withdrawals: string;
  is_depositor: boolean;
};

type PerGameRow = {
  user_id: string;
  game_type: string | null;
  wager: string;
};

/**
 * Detect whether upgrader per-bet data exists on this DB. On prod today
 * the `game_type` enum lacks `upgrader`, so even REFERENCING the literal
 * `'upgrader'` in a query throws (`invalid input value for enum`). We
 * therefore probe via the pg catalog (no enum literal) and only run the
 * upgrader behavioural scan when the value actually exists. This keeps the
 * whole Risk scan safe pre-upgrader-launch and self-enabling after it.
 */
async function upgraderEnumExists(): Promise<boolean> {
  try {
    const rows = await queryMainRows<{ exists: boolean }[]>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_enum e
         JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'game_type' AND e.enumlabel = 'upgrader'
       ) AS exists`,
    );
    return rows[0]?.exists === true;
  } catch {
    return false;
  }
}

async function buildBlacklistAnd(): Promise<string> {
  const excluded = await getExcludedUserIds();
  return excluded.length > 0
    ? ` AND u.id NOT IN (${escapeBlacklistIds(excluded)})`
    : "";
}

/** Map a raw game_type to a known RiskGame, or "unknown". */
function normalizeGame(gameType: string | null): RiskGame | "unknown" {
  if (gameType === "pack" || gameType === "battle" || gameType === "upgrader") {
    return gameType;
  }
  return "unknown";
}

/**
 * Edge for a game. "unknown" (acu wager row with no/foreign game_session)
 * gets the pack/battle edge (10.8%) — the conservative, dominant case on
 * prod where only pack+battle exist; never higher than any real edge so it
 * cannot over-state the expected GGR.
 */
function edgeForGame(game: RiskGame | "unknown"): number {
  if (game === "unknown") return RISK_EDGE_BY_GAME.pack;
  return RISK_EDGE_BY_GAME[game];
}

async function computeRiskData(creatorUserId: string): Promise<RiskData> {
  const blacklistAnd = await buildBlacklistAnd();
  const hasUpgrader = await upgraderEnumExists();

  // ── Per-user deposits (coverage-attributed) + attributed card
  //    withdrawals + depositor flag, lifetime-capped. Same CTE shapes as
  //    creators-pnl.ts, grouped per user (no period cross-join — this tool
  //    is lifetime).
  const perUserSql = `WITH attr_dep AS (
       SELECT lt.user_id, u.username, u.image, lt.amount::numeric AS amount
         FROM ledger_transactions lt
         JOIN "user" u ON u.id = lt.user_id
        WHERE lt.type::text = 'deposit'
          AND lt.status = 'completed'
          AND lt.created_at >= NOW() - ${LIFETIME_LOOKBACK_INTERVAL}
          AND u.role NOT IN ('admin', 'support', 'creator')
          AND u.id != $1${blacklistAnd}
          AND $1 = ${COVERING_CREATOR_SQL}
     ),
     cov_depositors AS (
       SELECT DISTINCT lt.user_id
         FROM ledger_transactions lt
        WHERE lt.type::text = 'deposit' AND lt.status = 'completed'
          AND lt.created_at >= NOW() - ${LIFETIME_LOOKBACK_INTERVAL}
          AND $1 = ${COVERING_CREATOR_SQL}
     ),
     creator_sessions AS (
       SELECT DISTINCT acu.game_session_id
         FROM affiliate_code_usages acu
         JOIN "user" u ON u.id = acu.referred_user_id
        WHERE acu.affiliate_user_id = $1
          AND acu.usage_type::text = 'wager'
          AND acu.game_session_id IS NOT NULL
          AND acu.created_at >= NOW() - ${LIFETIME_LOOKBACK_INTERVAL}
          AND u.role NOT IN ('admin', 'support', 'creator')
          AND u.id != $1${blacklistAnd}
     ),
     attr_wd AS (
       SELECT wu.user_id, wu.value AS amount
         FROM ${WITHDRAWN_UNITS_SQL} wu
        WHERE wu.withdrawn_at >= NOW() - ${LIFETIME_LOOKBACK_INTERVAL}
          AND wu.user_id IN (SELECT user_id FROM cov_depositors)
          AND wu.source_id IN (SELECT game_session_id FROM creator_sessions)
     ),
     dep_by_user AS (
       SELECT user_id, MAX(username) AS username, MAX(image) AS image,
              SUM(amount) AS deposits
         FROM attr_dep
        GROUP BY user_id
     ),
     wd_by_user AS (
       SELECT user_id, SUM(amount) AS card_withdrawals
         FROM attr_wd
        GROUP BY user_id
     )
     SELECT d.user_id AS user_id,
            d.username AS username,
            d.image AS image,
            COALESCE(d.deposits, 0)::text AS deposits,
            COALESCE(w.card_withdrawals, 0)::text AS card_withdrawals,
            TRUE AS is_depositor
       FROM dep_by_user d
       LEFT JOIN wd_by_user w ON w.user_id = d.user_id`;

  // ── Per-user, per-game wager split (non-borrowed, code-attributed).
  //    acu.wager_amount_usd grouped by referred user × game_sessions
  //    game_type. NULL game_session_id / game_type → "unknown" bucket.
  //    game_type compared via ::text so a dev-DB enum lag never throws.
  const perGameSql = `SELECT acu.referred_user_id AS user_id,
            gs.game_type::text AS game_type,
            COALESCE(SUM(acu.wager_amount_usd::numeric), 0)::text AS wager
       FROM affiliate_code_usages acu
       JOIN "user" u ON u.id = acu.referred_user_id
       LEFT JOIN game_sessions gs ON gs.id = acu.game_session_id
      WHERE acu.affiliate_user_id = $1
        AND acu.usage_type::text = 'wager'
        AND acu.created_at >= NOW() - ${LIFETIME_LOOKBACK_INTERVAL}
        AND u.role NOT IN ('admin', 'support', 'creator')
        AND u.id != $1${blacklistAnd}
      GROUP BY acu.referred_user_id, gs.game_type`;

  let perUserRows: PerUserRow[] = [];
  let perGameRows: PerGameRow[] = [];
  let partial = false;

  try {
    [perUserRows, perGameRows] = await queryMainRowsInTimeboxedTx(
      CREATOR_PNL_STATEMENT_TIMEOUT_MS,
      async (query) => [
        await query<PerUserRow[]>(perUserSql, creatorUserId),
        await query<PerGameRow[]>(perGameSql, creatorUserId),
      ] as const,
    );
  } catch (e) {
    console.error("[creator-hub.creators.risk] core scan failed:", e);
    partial = true;
  }

  // Assemble per-user wager + game split from the per-game rows. A user
  // may appear in perGameRows (wagered) without appearing in perUserRows
  // (never a coverage-depositor) — we still surface them (wager-only) with
  // PnL = 0 + isDepositor = false, the same way creators-pnl.ts surfaces
  // non-depositors for context.
  type Agg = {
    username: string | null;
    image: string | null;
    deposits: number;
    cardWithdrawals: number;
    isDepositor: boolean;
    games: Map<RiskGame | "unknown", number>;
  };
  const byUser = new Map<string, Agg>();

  const ensure = (userId: string): Agg => {
    let a = byUser.get(userId);
    if (!a) {
      a = {
        username: null,
        image: null,
        deposits: 0,
        cardWithdrawals: 0,
        isDepositor: false,
        games: new Map(),
      };
      byUser.set(userId, a);
    }
    return a;
  };

  for (const r of perUserRows) {
    const a = ensure(r.user_id);
    a.username = r.username;
    a.image = r.image;
    a.deposits = toNumber(r.deposits);
    a.cardWithdrawals = toNumber(r.card_withdrawals);
    a.isDepositor = r.is_depositor === true;
  }

  // Resolve usernames for wager-only users (not in perUserRows). Cheap
  // batched lookup, best-effort.
  const wagerOnlyIds = new Set<string>();
  for (const r of perGameRows) {
    const a = ensure(r.user_id);
    const game = normalizeGame(r.game_type);
    a.games.set(game, (a.games.get(game) ?? 0) + toNumber(r.wager));
    if (!perUserRows.some((u) => u.user_id === r.user_id)) {
      wagerOnlyIds.add(r.user_id);
    }
  }
  if (wagerOnlyIds.size > 0) {
    try {
      const idList = Array.from(wagerOnlyIds);
      const nameRows = await queryMainRows<
        { id: string; username: string | null; image: string | null }[]
      >(
        `SELECT id, username, image FROM "user" WHERE id = ANY($1::text[])`,
        idList,
      );
      const nameById = new Map(
        nameRows.map((n) => [n.id, { username: n.username, image: n.image }]),
      );
      for (const id of wagerOnlyIds) {
        const a = byUser.get(id);
        const n = nameById.get(id);
        if (a && n) {
          a.username = n.username;
          a.image = n.image;
        }
      }
    } catch (e) {
      console.error(
        "[creator-hub.creators.risk] wager-only username lookup failed:",
        e,
      );
      // Non-fatal — rows still render with id-derived display.
    }
  }

  const threshold = RISK_DEFAULT_SHORTFALL_THRESHOLD;
  const rows: RiskUserRow[] = [];

  for (const [userId, a] of byUser) {
    const byGame: RiskGameWager[] = [];
    let wagerUsd = 0;
    let expectedGgrUsd = 0;
    for (const [game, gw] of a.games) {
      const edge = edgeForGame(game);
      const exp = gw * edge;
      wagerUsd += gw;
      expectedGgrUsd += exp;
      byGame.push({ game, wagerUsd: gw, expectedGgrUsd: exp });
    }
    byGame.sort((x, y) => y.wagerUsd - x.wagerUsd);

    // Skip users with no wager AND no deposits (no activity to judge).
    if (wagerUsd <= 0 && a.deposits <= 0 && a.cardWithdrawals <= 0) continue;

    const actualPnlUsd = a.isDepositor ? a.deposits - a.cardWithdrawals : 0;
    const gapUsd = expectedGgrUsd - actualPnlUsd;

    const judgeable = expectedGgrUsd >= RISK_MIN_EXPECTED_GGR_USD;
    const shortfallPct = judgeable ? gapUsd / expectedGgrUsd : null;
    const flagged = shortfallPct != null && shortfallPct >= threshold;
    // Score: shortfall fraction → 0..100, clamped. Only for judgeable
    // users with a positive gap (the suspicious direction).
    const riskScore =
      shortfallPct == null
        ? null
        : Math.max(0, Math.min(100, Math.round(shortfallPct * 100)));

    rows.push({
      userId,
      username: a.username,
      image: a.image,
      depositsUsd: a.deposits,
      wagerUsd,
      byGame,
      cardWithdrawalsUsd: a.cardWithdrawals,
      actualPnlUsd,
      expectedGgrUsd,
      gapUsd,
      shortfallPct,
      isDepositor: a.isDepositor,
      flagged,
      riskScore,
    });
  }

  // Cohort-wide summary (uncapped) BEFORE slicing.
  const cohortUserCount = rows.length;
  let flaggedCount = 0;
  let totalExpectedGgrUsd = 0;
  let totalActualPnlUsd = 0;
  let totalGapUsd = 0;
  for (const r of rows) {
    if (r.flagged) flaggedCount++;
    totalExpectedGgrUsd += r.expectedGgrUsd;
    totalActualPnlUsd += r.actualPnlUsd;
    totalGapUsd += r.gapUsd;
  }

  // Worst-first: flagged first, then by gap (largest value saved), then by
  // shortfall fraction, then by wager volume.
  rows.sort((x, y) => {
    if (x.flagged !== y.flagged) return x.flagged ? -1 : 1;
    if (y.gapUsd !== x.gapUsd) return y.gapUsd - x.gapUsd;
    const sx = x.shortfallPct ?? -Infinity;
    const sy = y.shortfallPct ?? -Infinity;
    if (sy !== sx) return sy - sx;
    return y.wagerUsd - x.wagerUsd;
  });

  const upgraderSignal = hasUpgrader
    ? await scanUpgraderSignal(creatorUserId, blacklistAnd)
    : {
        available: false,
        unavailableReason:
          "Upgrader is not live on this database yet (the game_type enum has no 'upgrader' value, and there are no upgrader sessions). Per-bet win-chance data will appear here automatically once Upgrader ships. Low-variance abuse is still caught by the expected-vs-actual PnL gap below.",
        highWinChanceBets: null,
        totalUpgraderBets: null,
      };

  return {
    threshold,
    lookbackDays: LIFETIME_LOOKBACK_DAYS,
    users: rows.slice(0, MAX_USERS),
    cohortUserCount,
    flaggedCount,
    totalExpectedGgrUsd,
    totalActualPnlUsd,
    totalGapUsd,
    upgraderSignal,
    partial,
  };
}

/**
 * Upgrader behavioural scan — ONLY runs when the upgrader enum exists
 * (verified by the caller). Counts this creator's referred-user upgrader
 * bets at a high target win-chance (≥ HIGH_WIN_CHANCE_PCT), reading the
 * target multiplier off `provably_fair_results.result_metadata` via the
 * canonical key-coalesce convention (mirrors `parseUpgraderMetadata`).
 * High win-chance ⇔ low target multiplier (chance ≈ 1/multiplier), so we
 * derive the chance from the multiplier when an explicit chance key is
 * absent. Best-effort: any failure returns an "unavailable" signal.
 */
async function scanUpgraderSignal(
  creatorUserId: string,
  blacklistAnd: string,
): Promise<UpgraderBehaviorSignal> {
  // Target multiplier via the same COALESCE convention as
  // insights-games/upgrader.ts. Win-chance via explicit chance keys when
  // present, else derived as (1 / multiplier) * 100.
  const targetMultExpr = `COALESCE(
    NULLIF(pf.result_metadata->>'target_multiplier', '')::numeric,
    NULLIF(pf.result_metadata->>'targetMultiplier', '')::numeric,
    NULLIF(pf.result_metadata->>'multiplier', '')::numeric,
    NULLIF(pf.result_metadata->>'target_payout', '')::numeric,
    NULLIF(pf.result_metadata->>'payout_multiplier', '')::numeric,
    NULLIF(pf.result_metadata->>'cashout_multiplier', '')::numeric,
    NULLIF(pf.result_metadata->>'cashout', '')::numeric,
    NULLIF(pf.result_metadata->>'payout', '')::numeric
  )`;
  const chanceExpr = `COALESCE(
    NULLIF(pf.result_metadata->>'target_chance', '')::numeric,
    NULLIF(pf.result_metadata->>'targetChance', '')::numeric,
    NULLIF(pf.result_metadata->>'win_chance', '')::numeric,
    NULLIF(pf.result_metadata->>'winChance', '')::numeric,
    NULLIF(pf.result_metadata->>'chance', '')::numeric,
    NULLIF(pf.result_metadata->>'probability', '')::numeric,
    NULLIF(pf.result_metadata->>'win_probability', '')::numeric
  )`;

  // Normalise an explicit chance (could be 0-1 fraction or 0-100) and fall
  // back to derived (1/mult)*100. Then compare to HIGH_WIN_CHANCE_PCT.
  // game_type compared via ::text so the cast is safe (enum existence was
  // pre-verified, but ::text keeps it uniform with the rest of the layer).
  const sql = `WITH upg AS (
       SELECT acu.game_session_id AS sid
         FROM affiliate_code_usages acu
         JOIN "user" u ON u.id = acu.referred_user_id
         JOIN game_sessions gs ON gs.id = acu.game_session_id
        WHERE acu.affiliate_user_id = $1
          AND acu.usage_type::text = 'wager'
          AND gs.game_type::text = 'upgrader'
          AND acu.created_at >= NOW() - ${LIFETIME_LOOKBACK_INTERVAL}
          AND u.role NOT IN ('admin', 'support', 'creator')
          AND u.id != $1${blacklistAnd}
     ),
     bets AS (
       SELECT
         CASE
           WHEN ${chanceExpr} IS NOT NULL THEN
             CASE WHEN ${chanceExpr} > 0 AND ${chanceExpr} <= 1
                  THEN ${chanceExpr} * 100
                  ELSE LEAST(100, ${chanceExpr}) END
           WHEN ${targetMultExpr} IS NOT NULL AND ${targetMultExpr} > 1 THEN
             (1.0 / ${targetMultExpr}) * 100
           ELSE NULL
         END AS chance_pct
       FROM upg u
       JOIN provably_fair_results pf ON pf.game_session_id = u.sid
     )
     SELECT COUNT(*)::text AS total,
            COUNT(*) FILTER (WHERE chance_pct >= ${HIGH_WIN_CHANCE_PCT})::text AS high
       FROM bets`;

  try {
    const rows = await queryMainRows<{ total: string; high: string }[]>(
      sql,
      creatorUserId,
    );
    const total = Number(rows[0]?.total ?? 0);
    const high = Number(rows[0]?.high ?? 0);
    if (total === 0) {
      return {
        available: false,
        unavailableReason:
          "No upgrader bets recorded under this creator's code yet.",
        highWinChanceBets: null,
        totalUpgraderBets: null,
      };
    }
    return {
      available: true,
      unavailableReason: null,
      highWinChanceBets: high,
      totalUpgraderBets: total,
    };
  } catch (e) {
    console.error("[creator-hub.creators.risk] upgrader signal failed:", e);
    return {
      available: false,
      unavailableReason:
        "Upgrader per-bet data could not be read (metadata shape unavailable).",
      highWinChanceBets: null,
      totalUpgraderBets: null,
    };
  }
}

const cachedRiskData = unstable_cache(
  (creatorUserId: string): Promise<RiskData> => computeRiskData(creatorUserId),
  ["creator-hub-creators-risk-v1"],
  { revalidate: CACHE_TTL_SECONDS, tags: ["creator-hub-creators-risk"] },
);

/**
 * Public entry — cached on prod (the real-data path), uncached on a
 * dev-toggled admin so they see live dev data. Same prod-pinned cache
 * pattern as `_pnl-cache.ts` (unstable_cache resolves the env to prod
 * outside the request scope, so we only cache when the request itself is
 * on prod).
 */
export async function getRiskData(creatorUserId: string): Promise<RiskData> {
  const env = await readDbEnv();
  if (env !== "prod") return computeRiskData(creatorUserId);
  return cachedRiskData(creatorUserId);
}
