import "server-only";

import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";
import { affiliateLeaderboardsApi } from "@/lib/backend-api/affiliate-leaderboards";
import {
  getConvertedFillSessionsInWindow,
  sumConvertedFillSessions,
} from "@/lib/queries/creator-converted-sessions-in-window";

/**
 * "Creators Costs (today)" dashboard box — what CREATORS cost the house for
 * the CURRENT CALENDAR DAY since 00:00 UTC (NOT a rolling past-24h window).
 * Same UTC-midnight boundary as the Reward Costs Today tile
 * (`dashboard-reward-costs-today.ts` `utcStartOfDay`) and the P&L Today tile,
 * so the three reconcile on "today".
 *
 * ─── It REUSES the canonical creator-cost definitions, not new math ──────
 *
 * Every line mirrors EXACTLY a definition that already exists elsewhere,
 * just re-scoped to [today 00:00 UTC, now):
 *
 *   • Converted deal payouts today — fill-program payout vouchers minted in
 *     the window (`vouchers.origin = 'creator_fill_conversion'`, MAIN DB —
 *     same source as `/creators` "Converted") PLUS multiplier-deal payout
 *     vouchers minted in the window (`creator_multiplier_payout`). Fill
 *     conversions are recognized at voucher mint time, not card cash-out
 *     time. The two legs are disjoint → no double-count between fill vs
 *     multiplier.
 *
 *   • Tips today — the `creator_fill_spend_tip` leg of
 *     `creators/_queries/tips-sponsor-spend.ts` (creator-funded tips handed
 *     to users from the house-funded tips/sponsor pool), scoped to today.
 *     Filtered via `type::text IN (...)` (NOT a bare enum literal) so a
 *     `creator_fill_*` member absent from the prod enum simply matches zero
 *     rows instead of throwing `invalid input value for enum` at parse time
 *     — exactly the ENUM-SAFETY pattern documented in `tips-sponsor-spend.ts`.
 *     The box safely reads $0 until the fill system is live.
 *
 *   • Leaderboard spend today — the FULL gross of today's
 *     `affiliate_leaderboard_prize` ledger payouts (`Σ |amount|`). Owner
 *     decision (2026-06-04): every affiliate leaderboard is a CREATOR-run
 *     event (see `creators-leaderboards.ts`: "affiliate leaderboards are
 *     creator-run events"), so its WHOLE gross is a creator cost counted
 *     here — there is no sponsored-% on-site split on the dashboard anymore.
 *     The sibling Reward Costs box counts $0 of it, so the two boxes never
 *     double-count: this box gets the full gross, Reward Costs gets nothing.
 *     (The separate `/creators` cost KPIs still apply the sponsored-% split
 *     from their own data source — that is a DIFFERENT surface, untouched.)
 *
 * House-POV per CLAUDE.md: every line is money the house PAID OUT (creators
 * cashing out deal payouts, house-funded tips, house-funded leaderboard
 * prizes) → a house cost → rose in the UI. The TOTAL is converted deal
 * payouts + tips + the FULL leaderboard gross.
 *
 * ─── PERFORMANCE ────────────────────────────────────────────────────────
 *
 * Today-only window — no lifetime scan. `unstable_cache` keyed on the UTC
 * day string (revalidate 60s, same cadence as the reward-costs tile),
 * wrapped in `safeQuery` at the call site, streamed in its own `<Suspense>`
 * so it never blocks the dashboard shell. Two today-bounded reads (one
 * withdrawal-voucher aggregate, one ledger tips+leaderboard aggregate). No
 * staff/blacklist scope: these are creator-fill / deal / leaderboard spend
 * legs (the receiving user is whoever the creator paid/sponsored), so the
 * gross house spend is the honest figure — matching how the canonical
 * per-creator + tile definitions sum them. The per-leaderboard / per-claimant
 * drilldown and the per-creator / per-request withdrawals drilldown are
 * SEPARATE lazy reads (`getLeaderboardGrossClaimants`,
 * `getCreatorWithdrawalsBreakdown`), fetched only when an admin expands them.
 */

/** One creator-cost line on the box. */
export type CreatorCostLine = {
  /** Stable key for React. */
  key: string;
  /** Operator-friendly label. */
  label: string;
  /** Absolute dollar magnitude (house cost, always >= 0). */
  amount: number;
};

export type CreatorCostsToday = {
  /**
   * Total creator cost today — creator withdrawals + tips + the FULL
   * leaderboard gross (every leaderboard prize is a creator-run-event cost).
   */
  total: number;
  /** Itemized lines, largest magnitude first. */
  lines: CreatorCostLine[];
  /** Deal-payout vouchers minted today (fill conversion + multiplier) (rose). */
  creatorWithdrawals: number;
  /** House-funded creator tips today (rose). */
  tips: number;
  /** Full leaderboard prize gross paid out today (Σ |amount|, counted 100%). */
  leaderboardGross: number;
  /** ISO timestamp of the window start (today 00:00 UTC). */
  dayStartIso: string;
};

/**
 * UTC start-of-day for the instant `now`. Mirrors the Reward Costs / P&L
 * Today boxes' boundary so all three agree on "today".
 */
function utcStartOfDay(now: Date): Date {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Cached inner computation. Keyed on the UTC day string so it re-fills when
 * the day rolls over. `revalidate: 60` matches the reward-costs tile cadence.
 *
 * Runs two reads:
 *   1. Converted deal-payout vouchers minted today (voucher aggregate).
 *   2. Today's creator tips + the full leaderboard prize gross (ledger).
 *
 * The leaderboard figure is the FULL gross (`Σ |amount|`) — every leaderboard
 * prize is a creator-run-event cost (owner, 2026-06-04), so there is no
 * sponsored-% weighting on the dashboard anymore.
 */
const cachedCreatorCostsToday = unstable_cache(
  async (
    dayKey: string,
    sinceIso: string,
  ): Promise<{
    creatorWithdrawals: number;
    tips: number;
    leaderboardGross: number;
  }> => {
    void dayKey; // part of the cache key only
    return withTiming("dashboard.creatorCostsToday", async () => {
      const db = await getDb();
      const since = `'${sinceIso}'::timestamptz`;

      // ── Converted deal payouts today ───────────────────────────────────
      // Fill: `creator_fill_conversion` vouchers minted in the window.
      // Multiplier: payout vouchers minted in the window (no fill session).
      const sinceDate = new Date(sinceIso);
      const fillSessions = await getConvertedFillSessionsInWindow(sinceDate);
      const fillConverted = sumConvertedFillSessions(fillSessions);

      type MultiplierRow = { multiplier_payouts: string };
      const multiplierRows = await db.$queryRawUnsafe<MultiplierRow[]>(
        `SELECT COALESCE(SUM(v.value::numeric), 0)::text AS multiplier_payouts
         FROM vouchers v
         WHERE v.origin::text = 'creator_multiplier_payout'
           AND v.created_at >= ${since}`,
      );
      const creatorWithdrawals =
        fillConverted + toNumber(multiplierRows[0]?.multiplier_payouts);

      // ── Creator tips today (house-funded fill-spend tip leg) ─────────
      // `type::text IN (...)` — text comparison, never an enum-membership
      // error if `creator_fill_spend_tip` is absent from the prod enum
      // (see tips-sponsor-spend.ts ENUM-SAFETY header). Matches zero rows
      // until the fill system is live → reads $0 safely.
      type TipsRow = { tips: string };
      const tipsRows = await db.$queryRawUnsafe<TipsRow[]>(
        `SELECT COALESCE(SUM(ABS(amount::numeric)), 0)::text AS tips
         FROM ledger_transactions
         WHERE status = 'completed'
           AND type::text = 'creator_fill_spend_tip'
           AND created_at >= ${since}`,
      );
      const tips = toNumber(tipsRows[0]?.tips);

      // ── Leaderboard prize payouts today (full gross) ─────────────────
      // affiliate_leaderboard_prize ledger payouts for today, counted at
      // their FULL gross (Σ |amount|). Owner decision (2026-06-04): every
      // affiliate leaderboard is a creator-run event, so its whole gross is
      // a creator cost here — no sponsored-% split on the dashboard. The
      // sibling Reward Costs box counts $0 of it, so no double-count.
      type LeaderboardRow = { gross: string };
      const leaderboardRows = await db.$queryRawUnsafe<LeaderboardRow[]>(
        `SELECT COALESCE(SUM(ABS(amount::numeric)), 0)::text AS gross
         FROM ledger_transactions
         WHERE status = 'completed'
           AND type::text = 'affiliate_leaderboard_prize'
           AND created_at >= ${since}`,
      );
      const leaderboardGross = toNumber(leaderboardRows[0]?.gross);

      return { creatorWithdrawals, tips, leaderboardGross };
    });
  },
  ["dashboard-creator-costs-today-v5-fill-vouchers"],
  { revalidate: 60, tags: ["dashboard-activity"] },
);

/**
 * Creator costs for the current calendar day (since 00:00 UTC). Resolves the
 * cached today-windowed aggregate and assembles the line roster + total.
 *
 * The TOTAL is converted deal payouts + tips + the FULL leaderboard gross —
 * every leaderboard prize is a creator-run-event cost counted in full here
 * (owner, 2026-06-04). No sponsored-% weighting on the dashboard.
 */
export async function getCreatorCostsToday(): Promise<CreatorCostsToday> {
  return withTiming("dashboard.creatorCostsToday.entry", async () => {
    const now = new Date();
    const since = utcStartOfDay(now);
    const sinceIso = since.toISOString();
    // YYYY-MM-DD in UTC — stable cache key for "today" that rolls at 00:00.
    const dayKey = sinceIso.slice(0, 10);

    const { creatorWithdrawals, tips, leaderboardGross } =
      await cachedCreatorCostsToday(dayKey, sinceIso);

    // Lines for the breakdown popover. The leaderboard line carries the FULL
    // gross (the figure that sums into the total). Keep every line — even $0
    // ones — so the breakdown always shows the full roster; the box filters
    // to non-zero for the compact face.
    const lines: CreatorCostLine[] = [
      {
        key: "creator_withdrawals",
        label: "Converted payouts",
        amount: creatorWithdrawals,
      },
      { key: "tips", label: "Tips", amount: tips },
      {
        key: "leaderboard",
        label: "Leaderboard prizes",
        amount: leaderboardGross,
      },
    ].sort((a, b) => b.amount - a.amount);

    const total = creatorWithdrawals + tips + leaderboardGross;

    return {
      total,
      lines,
      creatorWithdrawals,
      tips,
      leaderboardGross,
      dayStartIso: sinceIso,
    };
  });
}

// ─── Leaderboard gross claimant drilldown (lazy, click-to-load) ────────────

/** One per-leaderboard group inside the gross claimant drilldown. */
export type LeaderboardGrossBoard = {
  /** Backend leaderboard id, or null for prize rows with no `leaderboard_id`. */
  leaderboardId: string | null;
  /** Resolved board title (backend), or null when un-titled / un-resolvable. */
  title: string | null;
  /** Σ |amount| of this board's prize rows today (full gross pool). */
  gross: number;
  /** Per-claimant rows, gross DESC (the biggest winner first). */
  claimants: LeaderboardGrossClaimant[];
};

/** One claimant's prize within a leaderboard group. */
export type LeaderboardGrossClaimant = {
  userId: string;
  username: string | null;
  /** This claimant's gross prize on this board today (Σ |amount|). */
  gross: number;
};

export type LeaderboardGrossBreakdown = {
  /** Per-board groups, largest gross first. */
  boards: LeaderboardGrossBoard[];
  /** Σ of every board's gross — reconciles to the card's leaderboard line. */
  totalGross: number;
  /** ISO window start (today 00:00 UTC) — the same boundary the card covers. */
  dayStartIso: string;
};

/**
 * Per-claimant breakdown behind the Creators Costs card's "Leaderboard
 * prizes" line — the click-to-load drilldown that shows WHO each leaderboard
 * prize was paid to, grouped by leaderboard, at FULL gross.
 *
 * ─── WHY IT RECONCILES ──────────────────────────────────────────────────
 *
 * Every leaderboard prize is counted in full on this box (owner, 2026-06-04),
 * so there is no sponsored-% carve-out: each claimant's gross is shown as-is,
 * `Σ_claimant gross = board.gross`, and `Σ_board gross` = the card's
 * leaderboard line exactly. No derived remainder, no over/under-statement.
 *
 * ─── SCOPE / WINDOW (identical to the card's leaderboard line) ──────────
 *
 * SAME un-scoped gross + SAME window [today 00:00 UTC, now) as the card's
 * leaderboard line (`affiliate_leaderboard_prize`, status='completed', no
 * staff/blacklist filter — matching how the line total sums it), recomputed
 * from a live `now` here (the window is not passed in from the client — only
 * trusted server time defines it, so a tampered value can't widen the scan).
 *
 * ─── PERFORMANCE (lazy) ─────────────────────────────────────────────────
 *
 * NOT cached and NOT called on the dashboard's initial render — it runs ONLY
 * when an admin clicks the line to expand it (a server action fires this),
 * per CLAUDE.md's active-timeframe / lazy rule. Today-only window, one
 * grouped ledger read + a bulk best-effort title resolve (each distinct
 * board fetched at most once). Read-only against the Main DB.
 */
export async function getLeaderboardGrossClaimants(): Promise<LeaderboardGrossBreakdown> {
  return withTiming(
    "dashboard.creatorCostsToday.leaderboardClaimants",
    async () => {
      const now = new Date();
      const since = utcStartOfDay(now);
      const sinceIso = since.toISOString();

      const db = await getDb();
      const sinceSql = `'${sinceIso}'::timestamptz`;

      // Per (leaderboard, claimant) gross prize today, over the SAME un-scoped
      // window as the card's leaderboard line. NULL/missing leaderboard_id
      // folds into a single null-board bucket.
      type ClaimantRow = {
        leaderboard_id: string | null;
        user_id: string;
        username: string | null;
        gross: string;
      };
      const rows = await db.$queryRawUnsafe<ClaimantRow[]>(
        `SELECT
           lt.metadata->>'leaderboard_id' AS leaderboard_id,
           lt.user_id AS user_id,
           u.username AS username,
           COALESCE(SUM(ABS(lt.amount::numeric)), 0)::text AS gross
         FROM ledger_transactions lt
         JOIN "user" u ON u.id = lt.user_id
         WHERE lt.status = 'completed'
           AND lt.type::text = 'affiliate_leaderboard_prize'
           AND lt.created_at >= ${sinceSql}
         GROUP BY lt.metadata->>'leaderboard_id', lt.user_id, u.username`,
      );

      // Distinct board ids for the title resolve.
      const boardIds = Array.from(
        new Set(
          rows
            .map((r) => r.leaderboard_id)
            .filter(
              (id): id is string => typeof id === "string" && id.length > 0,
            ),
        ),
      );

      // Resolve board titles in parallel (best-effort, mirrors
      // users-detail.ts enrichLeaderboardWins): a 404 / failure only blanks
      // that board's title — it never throws or blocks the drilldown.
      const titleById = new Map<string, string>();
      if (boardIds.length > 0) {
        const settled = await Promise.allSettled(
          boardIds.map((id) =>
            affiliateLeaderboardsApi
              .get(id)
              .then((r) => ({ id, title: r.title })),
          ),
        );
        for (const s of settled) {
          if (s.status === "fulfilled") titleById.set(s.value.id, s.value.title);
        }
      }

      // Group rows by board.
      const byBoard = new Map<string, LeaderboardGrossBoard>();
      const boardKey = (id: string | null) => id ?? " none";
      for (const r of rows) {
        const id =
          typeof r.leaderboard_id === "string" && r.leaderboard_id.length > 0
            ? r.leaderboard_id
            : null;
        const gross = toNumber(r.gross);

        const key = boardKey(id);
        let board = byBoard.get(key);
        if (!board) {
          board = {
            leaderboardId: id,
            title: id != null ? titleById.get(id) ?? null : null,
            gross: 0,
            claimants: [],
          };
          byBoard.set(key, board);
        }
        board.gross += gross;
        board.claimants.push({
          userId: r.user_id,
          username: r.username,
          gross,
        });
      }

      const boards = Array.from(byBoard.values());
      for (const b of boards) {
        b.claimants.sort((a, c) => c.gross - a.gross);
      }
      // Biggest gross board first (matches the card's largest-first ordering).
      boards.sort((a, b) => b.gross - a.gross);

      const totalGross = boards.reduce((sum, b) => sum + b.gross, 0);

      return { boards, totalGross, dayStartIso: sinceIso };
    },
  );
}

// ─── Converted deal-payout drilldown (lazy, click-to-load) ──────────────────

/** One converted payout row in the window (fill session or multiplier voucher). */
export type CreatorConvertedPayout =
  | {
      kind: "fill_session";
      voucherId: string;
      sessionId: string | null;
      dealId: string | null;
      amount: number;
      convertedAtIso: string;
    }
  | {
      kind: "multiplier";
      voucherId: string;
      amount: number;
      mintedAtIso: string;
    };

/** One creator's converted deal payouts in the window. */
export type CreatorWithdrawalCreator = {
  creatorUserId: string;
  username: string | null;
  /** Σ payout amounts for this creator in the window. */
  amount: number;
  /** Per-session / per-voucher rows, largest amount first. */
  payouts: CreatorConvertedPayout[];
};

export type CreatorWithdrawalsBreakdown = {
  /** Per-creator groups, largest amount first. */
  creators: CreatorWithdrawalCreator[];
  /** Σ of every creator's amount — reconciles to the card's withdrawals line. */
  totalAmount: number;
  /** ISO window start (today 00:00 UTC) — the same boundary the card covers. */
  dayStartIso: string;
};

/**
 * Per-creator breakdown behind the Creators Costs card's "Converted payouts"
 * line — WHO minted a fill conversion voucher today, plus any multiplier
 * payout vouchers minted today.
 *
 * ─── WHY IT RECONCILES ──────────────────────────────────────────────────
 *
 * Same sources as the aggregate line: `creator_fill_conversion` vouchers
 * minted in [today 00:00 UTC, now) + `creator_multiplier_payout` vouchers.
 *
 * ─── SCOPE / WINDOW (identical to the card's payouts line) ────────────
 *
 * SAME window [today 00:00 UTC, now). Window derived from trusted server
 * time only.
 *
 * ─── PERFORMANCE (lazy) ─────────────────────────────────────────────────
 *
 * NOT cached and NOT called on the dashboard's initial render — runs ONLY
 * when an admin expands the line (server action). Today-only window, one
 * grouped read over the deal-payout CTE. Read-only against the Main DB.
 */
export async function getCreatorWithdrawalsBreakdown(): Promise<CreatorWithdrawalsBreakdown> {
  return withTiming(
    "dashboard.creatorCostsToday.withdrawalsBreakdown",
    async () => {
      const now = new Date();
      const since = utcStartOfDay(now);
      const sinceIso = since.toISOString();

      const db = await getDb();
      const sinceSql = `'${sinceIso}'::timestamptz`;

      const fillSessions = await getConvertedFillSessionsInWindow(since);

      type MultiplierVoucherRow = {
        creator_user_id: string;
        username: string | null;
        voucher_id: string;
        amount: string;
        minted_at: Date;
      };
      const multiplierRows = await db.$queryRawUnsafe<MultiplierVoucherRow[]>(
        `SELECT
           v.user_id AS creator_user_id,
           u.username,
           v.id AS voucher_id,
           v.value::numeric AS amount,
           v.created_at AS minted_at
         FROM vouchers v
         JOIN "user" u ON u.id = v.user_id
         WHERE v.origin::text = 'creator_multiplier_payout'
           AND v.created_at >= ${sinceSql}
         ORDER BY v.created_at DESC`,
      );

      const byCreator = new Map<string, CreatorWithdrawalCreator>();

      const ensureCreator = (
        userId: string,
        username: string | null,
      ): CreatorWithdrawalCreator => {
        let creator = byCreator.get(userId);
        if (!creator) {
          creator = {
            creatorUserId: userId,
            username,
            amount: 0,
            payouts: [],
          };
          byCreator.set(userId, creator);
        } else if (!creator.username && username) {
          creator.username = username;
        }
        return creator;
      };

      for (const s of fillSessions) {
        const creator = ensureCreator(s.userId, s.username);
        creator.amount += s.amountUsd;
        creator.payouts.push({
          kind: "fill_session",
          voucherId: s.voucherId,
          sessionId: s.sessionId,
          dealId: s.dealId,
          amount: s.amountUsd,
          convertedAtIso: s.convertedAtIso,
        });
      }

      for (const r of multiplierRows) {
        const amount = toNumber(r.amount);
        const creator = ensureCreator(r.creator_user_id, r.username);
        creator.amount += amount;
        creator.payouts.push({
          kind: "multiplier",
          voucherId: r.voucher_id,
          amount,
          mintedAtIso: new Date(r.minted_at).toISOString(),
        });
      }

      const creators = Array.from(byCreator.values());
      for (const c of creators) {
        c.payouts.sort((a, b) => b.amount - a.amount);
      }
      creators.sort((a, b) => b.amount - a.amount);

      const totalAmount = creators.reduce((sum, c) => sum + c.amount, 0);

      return { creators, totalAmount, dayStartIso: sinceIso };
    },
  );
}
