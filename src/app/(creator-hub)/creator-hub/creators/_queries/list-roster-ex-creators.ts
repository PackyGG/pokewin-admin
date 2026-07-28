import "server-only";

import type { CreatorListItem } from "@/lib/backend-api";

import { getExCreatorsList } from "../../../../(admin)/creators/_queries/list-ex-creators";
import { parseCreatorsSearchParams } from "../../../../(admin)/creators/_lib/search-params";
import {
  getCodeAndWagerByUser,
  type CreatorCodeAndWager,
} from "../../../../(admin)/creators/_queries/code-and-wager-by-user";
import { getRosterSocialsByUserCached } from "./roster-socials-cache";
import { getAllCreatorsLifetimePnl } from "../../../../(admin)/creators/_queries/all-creators-lifetime-pnl";

import type { RosterSortMode } from "../_lib/roster-params";
import {
  sortRoster,
  type RosterCreator,
  type RosterResult,
} from "./list-roster-creators";

/**
 * Creator Hub roster — past / ex-creators tab.
 *
 * Reuses the admin `getExCreatorsList` identification (artifact-anchored
 * dual-DB set, role <> creator) and enriches rows with the same lifetime
 * metrics the active roster shows where they're role-agnostic: code, lifetime
 * wager volume, signups, FTDs, lifetime House P&L, socials.
 *
 * Deliberately SKIPS windowed cohort GGR (`getAllCreatorsNetGgr` is creator-
 * gated) and active-deal deal value (ex-creators have no active/scheduled
 * deal). Windowed wager/GGR columns render lifetime wager + "—" for GGR,
 * matching the admin Past Creators tab semantics.
 */
export async function listRosterExCreators(
  sortBy: RosterSortMode,
): Promise<RosterResult> {
  let roster: CreatorListItem[];
  try {
    const page = await getExCreatorsList(parseCreatorsSearchParams({ tab: "past" }));
    roster = page.data;
  } catch (err) {
    console.error("[creator-hub roster] ex-creator list failed:", err);
    return { creators: [], rosterUnavailable: true };
  }

  const ids = roster.map((c) => c.id);
  if (ids.length === 0) {
    return { creators: [], rosterUnavailable: false };
  }

  const [codeWager, socials, lifetimePnl] = await Promise.all([
    getCodeAndWagerByUser(ids).catch((err) => {
      console.error(
        "[creator-hub roster] ex-creator code+wager fetch failed:",
        err,
      );
      return new Map<string, CreatorCodeAndWager>();
    }),
    getRosterSocialsByUserCached(ids).catch((err) => {
      console.error(
        "[creator-hub roster] ex-creator socials fetch failed:",
        err,
      );
      return new Map();
    }),
    getAllCreatorsLifetimePnl(undefined).catch((err) => {
      console.error(
        "[creator-hub roster] ex-creator lifetime PnL fetch failed:",
        err,
      );
      return null;
    }),
  ]);

  const pnlByUser = new Map<string, number>(
    (lifetimePnl?.byCreator ?? []).map((r) => [r.userId, r.pnl]),
  );

  const rows: RosterCreator[] = roster.map((c) => {
    const cw = codeWager.get(c.id);
    return {
      id: c.id,
      username: c.username,
      email: c.email,
      image: c.image,
      createdAt: c.created_at,
      hasActiveDeal: false,
      dealStatus: c.current_deal?.status ?? null,
      isLive: false,
      socials: socials.get(c.id) ?? [],
      code: cw?.code ?? null,
      signups: cw?.signups ?? 0,
      ftds: cw?.ftds ?? 0,
      // Lifetime wager — windowed GGR is creator-gated and unavailable here.
      windowedWagerUsd: cw?.wagerVolumeUsd ?? 0,
      windowedGgrUsd: null,
      lifetimePnlUsd: pnlByUser.has(c.id) ? pnlByUser.get(c.id)! : null,
      dealValue: null,
      checklist: null,
      isPastCreator: true,
    };
  });

  return { creators: sortRoster(rows, sortBy), rosterUnavailable: false };
}
