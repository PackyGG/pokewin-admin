import "server-only";

import { creatorsApi, type CreatorListItem } from "@/lib/backend-api";

// Reuse the EXISTING (admin)-group creator data layer. The (creator-hub)
// group is a sibling of (admin) on disk, so these relative paths cross the
// route-group boundary to the canonical, verified query modules. NONE of
// this is reimplemented — the roster only orchestrates + sorts.
import {
  getCodeAndWagerByUser,
  type CreatorCodeAndWager,
} from "../../../../(admin)/creators/_queries/code-and-wager-by-user";
import { getApprovedSocialsByUser } from "../../../../(admin)/creators/_queries/socials-by-user";
import type { CreatorSocialSummary } from "../../../../(admin)/creators/_queries/socials-by-user";
import {
  getAllCreatorsNetGgr,
  type CreatorNetGgrRow,
} from "../../../../(admin)/creators/_queries/all-creators-net-pnl";
import { getAllCreatorsLifetimePnl } from "../../../../(admin)/creators/_queries/all-creators-lifetime-pnl";
import { getDealValueByUser, type CreatorDealValue } from "./deal-value-by-user";

import { type DashboardPeriod } from "@/lib/queries/dashboard-period";
import type { RosterSortMode } from "../_lib/roster-params";

/**
 * Creator Hub roster — the full enriched + sorted creator list for
 * `/creator-hub/creators`.
 *
 * Walks the live backend creator roster ONCE, merges the verified
 * per-creator metrics (code + wager + signups + FTDs, windowed cohort
 * wager + GGR, lifetime House P&L, and the composed full deal value), then
 * applies the owner's sort set in code. The roster is small (~60 creators)
 * and the legacy /creators page already walks the whole pool on one page,
 * so a single full walk + in-memory sort is the established, acceptable
 * pattern here (NOT a per-creator fan-out anti-pattern — every heavy metric
 * is a single batched/cached pass).
 *
 * Search is intentionally NOT applied here: it's an instant client-side
 * filter over the already-rendered rows (RosterSearchProvider), so a
 * keystroke never re-runs this orchestration.
 */

const PAGE_SIZE = 100;
const FETCH_CAP = 500;

/** One enriched roster row — all serializable primitives (server→client safe). */
export type RosterCreator = {
  id: string;
  username: string | null;
  email: string | null;
  image: string | null;
  createdAt: string;
  /** True when the creator's current deal is active or scheduled. */
  hasActiveDeal: boolean;
  /** Backend deal status of the current deal, when any. */
  dealStatus: CreatorListItem["current_deal"] extends infer D
    ? D extends { status: infer S }
      ? S | null
      : null
    : null;
  /** True when the creator is live right now (`active_session_id`). */
  isLive: boolean;
  /** Approved social handles (platform + handle/url) for the card chips. */
  socials: CreatorSocialSummary[];
  /** Primary affiliate code owned by the creator (oldest-first). */
  code: string | null;
  /** Lifetime sign-ups referred by the creator's code. */
  signups: number;
  /** Lifetime first-time depositors under the creator's code. */
  ftds: number;
  /** Windowed cohort affiliate wager (house gain → emerald). */
  windowedWagerUsd: number;
  /** Windowed cohort GGR (house POV). null when no attributed activity. */
  windowedGgrUsd: number | null;
  /** Lifetime House P&L (deposits − card withdrawals). null when absent. */
  lifetimePnlUsd: number | null;
  /** Composed full deal value (cap + LB×house% + tip + sponsor). null when none. */
  dealValue: CreatorDealValue | null;
};

export type RosterResult = {
  creators: RosterCreator[];
  /** True when the backend roster walk itself failed (page shows the error card). */
  rosterUnavailable: boolean;
};

async function walkAllCreators(): Promise<CreatorListItem[]> {
  const firstPage = await creatorsApi.list({ offset: 0, limit: PAGE_SIZE });
  const all = [...firstPage.data];
  const pagesNeeded = Math.min(
    Math.ceil(FETCH_CAP / PAGE_SIZE),
    Math.ceil(firstPage.total / PAGE_SIZE),
  );
  const rest: Promise<typeof firstPage>[] = [];
  for (let p = 1; p < pagesNeeded; p++) {
    rest.push(creatorsApi.list({ offset: p * PAGE_SIZE, limit: PAGE_SIZE }));
  }
  for (const page of await Promise.all(rest)) all.push(...page.data);
  return all;
}

/**
 * Apply the owner's sort set. Every comparator is total + stable-ish (ties
 * fall through to username) so the order is deterministic. The metric maps
 * are threaded in so the comparator reads pre-merged values.
 */
function sortRoster(
  rows: RosterCreator[],
  sortBy: RosterSortMode,
): RosterCreator[] {
  const byName = (a: RosterCreator, b: RosterCreator) =>
    (a.username ?? "").localeCompare(b.username ?? "");

  const sorted = [...rows];
  switch (sortBy) {
    case "newest":
      sorted.sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() ||
          byName(a, b),
      );
      break;
    case "oldest":
      sorted.sort(
        (a, b) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() ||
          byName(a, b),
      );
      break;
    case "wager_desc":
      sorted.sort(
        (a, b) => b.windowedWagerUsd - a.windowedWagerUsd || byName(a, b),
      );
      break;
    case "ftd_desc":
      sorted.sort((a, b) => b.ftds - a.ftds || byName(a, b));
      break;
    case "signups_desc":
      sorted.sort((a, b) => b.signups - a.signups || byName(a, b));
      break;
    case "pnl_desc":
      // Best PnL first. Creators with no PnL figure sort last.
      sorted.sort(
        (a, b) =>
          (b.lifetimePnlUsd ?? -Infinity) - (a.lifetimePnlUsd ?? -Infinity) ||
          byName(a, b),
      );
      break;
    case "pnl_asc":
      // Worst PnL first. Creators with no PnL figure sort last.
      sorted.sort(
        (a, b) =>
          (a.lifetimePnlUsd ?? Infinity) - (b.lifetimePnlUsd ?? Infinity) ||
          byName(a, b),
      );
      break;
    case "deal_desc":
      sorted.sort(
        (a, b) =>
          (b.dealValue?.dealValueUsd ?? 0) -
            (a.dealValue?.dealValueUsd ?? 0) || byName(a, b),
      );
      break;
    case "deal_asc":
      // Smallest NON-ZERO deal first; creators with no deal value sort last
      // (a "$0 deal" is "no deal", not the smallest deal).
      sorted.sort((a, b) => {
        const av = a.dealValue?.dealValueUsd ?? Infinity;
        const bv = b.dealValue?.dealValueUsd ?? Infinity;
        return av - bv || byName(a, b);
      });
      break;
  }
  return sorted;
}

export async function listRosterCreators(
  period: DashboardPeriod,
  sortBy: RosterSortMode,
): Promise<RosterResult> {
  // 1) The roster walk is the backbone — if it fails, the page renders the
  //    "backend unavailable" card. Everything else degrades to empty.
  let roster: CreatorListItem[];
  try {
    roster = await walkAllCreators();
  } catch (err) {
    console.error("[creator-hub roster] backend roster walk failed:", err);
    return { creators: [], rosterUnavailable: true };
  }

  const ids = roster.map((c) => c.id);

  // 2) Enrichment passes — each independent + best-effort so one failure
  //    leaves its column empty rather than blanking the roster. The PnL +
  //    deal-value sorts need their map present BEFORE sorting, so they're
  //    awaited here (not streamed) — but they're cached/batched single
  //    passes, not per-creator fan-outs.
  const activeScheduledDeals = roster
    .filter(
      (c) =>
        c.current_deal != null &&
        (c.current_deal.status === "active" ||
          c.current_deal.status === "scheduled"),
    )
    .map((c) => ({ userId: c.id, dealId: c.current_deal!.id }));

  const [codeWager, socials, netGgr, lifetimePnl, dealValues] =
    await Promise.all([
      getCodeAndWagerByUser(ids).catch((err) => {
        console.error(
          "[creator-hub roster] code+wager fetch failed (cols render 0):",
          err,
        );
        return new Map<string, CreatorCodeAndWager>();
      }),
      getApprovedSocialsByUser().catch((err) => {
        console.error(
          "[creator-hub roster] socials fetch failed (chips hidden):",
          err,
        );
        return new Map<string, CreatorSocialSummary[]>();
      }),
      getAllCreatorsNetGgr(period).catch((err) => {
        console.error(
          "[creator-hub roster] windowed GGR fetch failed (wager col '—'):",
          err,
        );
        return null;
      }),
      getAllCreatorsLifetimePnl(undefined).catch((err) => {
        console.error(
          "[creator-hub roster] lifetime PnL fetch failed (PnL col '—'):",
          err,
        );
        return null;
      }),
      getDealValueByUser(activeScheduledDeals).catch((err) => {
        console.error(
          "[creator-hub roster] deal-value fetch failed (deal col '—'):",
          err,
        );
        return new Map<string, CreatorDealValue>();
      }),
    ]);

  const ggrByUser = new Map<string, CreatorNetGgrRow>(
    (netGgr?.byCreator ?? []).map((r) => [r.creatorUserId, r]),
  );
  const pnlByUser = new Map<string, number>(
    (lifetimePnl?.byCreator ?? []).map((r) => [r.userId, r.pnl]),
  );

  // 3) Build serializable rows.
  const rows: RosterCreator[] = roster.map((c) => {
    const cw = codeWager.get(c.id);
    const ggrRow = ggrByUser.get(c.id);
    return {
      id: c.id,
      username: c.username,
      email: c.email,
      image: c.image,
      createdAt: c.created_at,
      hasActiveDeal:
        c.current_deal?.status === "active" ||
        c.current_deal?.status === "scheduled",
      dealStatus: c.current_deal?.status ?? null,
      isLive: c.active_session_id !== null,
      socials: socials.get(c.id) ?? [],
      code: cw?.code ?? null,
      signups: cw?.signups ?? 0,
      ftds: cw?.ftds ?? 0,
      windowedWagerUsd: ggrRow?.wager ?? 0,
      windowedGgrUsd: ggrRow ? ggrRow.ggr : null,
      lifetimePnlUsd: pnlByUser.has(c.id) ? pnlByUser.get(c.id)! : null,
      dealValue: dealValues.get(c.id) ?? null,
    };
  });

  return { creators: sortRoster(rows, sortBy), rosterUnavailable: false };
}
