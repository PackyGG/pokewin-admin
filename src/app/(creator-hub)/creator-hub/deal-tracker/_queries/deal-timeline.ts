import "server-only";

import { unstable_cache } from "next/cache";

import { creatorsApi, type CreatorListItem } from "@/lib/backend-api";
import { getDb } from "@/lib/db";
import { getLeaderboardSponsorshipMap } from "../../../../(admin)/creators/_queries/leaderboard-sponsorship";
import { fetchAllApprovedLeaderboards } from "../../leaderboards/_queries/live-leaderboards";

import {
  type DealTrackerWindow,
  dealTrackerWindowDays,
} from "../_lib/tracker-window";
import type {
  DealTimelineResult,
  TimelineEvent,
  TimelineEventKind,
} from "../_lib/timeline-types";

export type { DealTrackerWindow, TimelineEvent, TimelineEventKind, DealTimelineResult };
export {
  DEAL_TRACKER_WINDOWS,
  parseDealTrackerWindow,
} from "../_lib/tracker-window";

// ─── Helpers ─────────────────────────────────────────────────────────

const PAGE_SIZE = 100;
const FETCH_CAP = 500;

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

function eventStatus(atMs: number, nowMs: number): TimelineEvent["status"] {
  const dayMs = 24 * 60 * 60 * 1000;
  const diff = atMs - nowMs;
  if (Math.abs(diff) < dayMs / 2) return "today";
  return diff < 0 ? "past" : "upcoming";
}

function inWindow(atMs: number, nowMs: number, windowDaysCount: number): boolean {
  const half = (windowDaysCount / 2) * 24 * 60 * 60 * 1000;
  return atMs >= nowMs - half && atMs <= nowMs + half;
}

async function hydrateUsernames(
  userIds: string[],
): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  if (userIds.length === 0) return map;
  try {
    const db = await getDb();
    const users = await db.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, username: true },
    });
    for (const u of users) map.set(u.id, u.username ?? null);
  } catch (err) {
    console.error("[deal-timeline] username hydration failed:", err);
  }
  return map;
}

// ─── Core query ──────────────────────────────────────────────────────

const getDealTimelineBase = unstable_cache(
  async (): Promise<{
    events: Omit<TimelineEvent, "creatorUsername" | "daysFromNow" | "status">[];
    dealsUnavailable: boolean;
    leaderboardsUnavailable: boolean;
  }> => {
    const events: Omit<
      TimelineEvent,
      "creatorUsername" | "daysFromNow" | "status"
    >[] = [];
    let dealsUnavailable = false;
    let leaderboardsUnavailable = false;

    try {
      const roster = await walkAllCreators();
      for (const c of roster) {
        const deal = c.current_deal;
        if (
          !deal ||
          (deal.status !== "active" && deal.status !== "scheduled")
        ) {
          continue;
        }

        events.push({
          id: `deal_start:${deal.id}`,
          kind: "deal_start",
          atIso: deal.week_start_utc,
          creatorUserId: c.id,
          title: "Deal starts",
          subtitle: `${deal.status} · ${deal.fills_used}/${deal.fills_allowed} fills`,
          href: `/creator-hub/creators/${c.id}`,
          valueUsd: Number(deal.per_fill_amount_usd) || null,
        });
        events.push({
          id: `deal_end:${deal.id}`,
          kind: "deal_end",
          atIso: deal.week_end_utc,
          creatorUserId: c.id,
          title: "Deal ends",
          subtitle: `${deal.status} weekly window closes`,
          href: `/creator-hub/creators/${c.id}`,
          valueUsd: null,
        });
      }
    } catch (err) {
      console.error("[deal-timeline] roster walk failed:", err);
      dealsUnavailable = true;
    }

    try {
      const leaderboards = await fetchAllApprovedLeaderboards();
      const sponsorship = await getLeaderboardSponsorshipMap(
        leaderboards.map((lb) => lb.id),
      ).catch(() => new Map<string, number>());

      for (const lb of leaderboards) {
        if (lb.cancelled_at) continue;
        // House cost mirrors the canonical live-leaderboards.ts formula:
        // net = total_prize_usd − refund_amount_usd, then × house%. Omitting
        // the refund subtraction (and the 0–100 clamp) overstated the cost and
        // disagreed with the Live Leaderboards surface for the same board.
        const prize = Number(lb.total_prize_usd) || 0;
        const refund = Number(lb.refund_amount_usd) || 0;
        const net = prize - refund;
        const housePct = Math.min(100, Math.max(0, sponsorship.get(lb.id) ?? 100));
        const houseCost = (net * housePct) / 100;

        events.push({
          id: `lb_start:${lb.id}`,
          kind: "leaderboard_start",
          atIso: lb.start_date,
          creatorUserId: lb.creator_user_id,
          title: "Leaderboard starts",
          subtitle: lb.title,
          href: `/creator-hub/creators/${lb.creator_user_id}`,
          valueUsd: houseCost > 0 ? houseCost : null,
        });
        events.push({
          id: `lb_end:${lb.id}`,
          kind: "leaderboard_end",
          atIso: lb.end_date,
          creatorUserId: lb.creator_user_id,
          title: "Leaderboard ends",
          subtitle: lb.title,
          href: `/creator-hub/creators/${lb.creator_user_id}`,
          valueUsd: houseCost > 0 ? houseCost : null,
        });
      }
    } catch (err) {
      console.error("[deal-timeline] leaderboard walk failed:", err);
      leaderboardsUnavailable = true;
    }

    return { events, dealsUnavailable, leaderboardsUnavailable };
  },
  ["creator-hub:deal-timeline-base:v2"],
  { revalidate: 60, tags: ["creator-hub-deal-timeline"] },
);

/**
 * Timeline of deal windows + leaderboard run dates for the Creator Hub
 * Deal Tracker. Reuses the backend creator roster + approved-leaderboard
 * walk (same sources as the roster + live-leaderboards modules).
 */
export async function getDealTimeline(
  window: DealTrackerWindow = "30d",
): Promise<DealTimelineResult> {
  const base = await getDealTimelineBase();
  const nowMs = Date.now();
  const days = dealTrackerWindowDays(window);

  const creatorIds = [...new Set(base.events.map((e) => e.creatorUserId))];
  const usernames = await hydrateUsernames(creatorIds);

  const events: TimelineEvent[] = base.events
    .filter((e) => inWindow(new Date(e.atIso).getTime(), nowMs, days))
    .map((e) => {
      const atMs = new Date(e.atIso).getTime();
      const daysFromNow = (atMs - nowMs) / (24 * 60 * 60 * 1000);
      return {
        ...e,
        creatorUsername: usernames.get(e.creatorUserId) ?? null,
        daysFromNow,
        status: eventStatus(atMs, nowMs),
      };
    })
    .sort((a, b) => new Date(a.atIso).getTime() - new Date(b.atIso).getTime());

  const counts = {
    dealEnds: events.filter((e) => e.kind === "deal_end").length,
    dealStarts: events.filter((e) => e.kind === "deal_start").length,
    lbEnds: events.filter((e) => e.kind === "leaderboard_end").length,
    lbStarts: events.filter((e) => e.kind === "leaderboard_start").length,
    upcoming: events.filter((e) => e.status === "upcoming").length,
  };

  return {
    events,
    counts,
    dealsUnavailable: base.dealsUnavailable,
    leaderboardsUnavailable: base.leaderboardsUnavailable,
    backendUnavailable: base.dealsUnavailable || base.leaderboardsUnavailable,
  };
}
