/** Client-safe timeline types for Deal Tracker UI. */

export type TimelineEventKind =
  | "deal_start"
  | "deal_end"
  | "leaderboard_start"
  | "leaderboard_end";

export type TimelineEvent = {
  id: string;
  kind: TimelineEventKind;
  atIso: string;
  /** Days from now (negative = past). */
  daysFromNow: number;
  creatorUserId: string;
  creatorUsername: string | null;
  title: string;
  subtitle: string;
  href: string;
  /** House-POV cost hint when applicable (rose context). */
  valueUsd: number | null;
  status: "past" | "today" | "upcoming";
};

export type DealTimelineResult = {
  events: TimelineEvent[];
  counts: {
    dealEnds: number;
    dealStarts: number;
    lbEnds: number;
    lbStarts: number;
    upcoming: number;
  };
  /** True when the creator roster walk failed. */
  dealsUnavailable: boolean;
  /** True when the approved-leaderboard walk failed. */
  leaderboardsUnavailable: boolean;
  /** Either source failed — legacy aggregate for callers. */
  backendUnavailable: boolean;
};
