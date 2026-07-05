"use client";

import { useMemo, type ReactNode } from "react";
import Link from "next/link";
import { Users2 } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatCompactUsd, formatNumber } from "@/lib/utils/format";

import type { RosterCreator } from "../_queries/list-roster-creators";
import { useRosterSearch, matchesRosterSearch } from "./roster-search-context";
import { useRosterView } from "./roster-view-context";

/**
 * Creator Hub roster — card grid + compact table renderer.
 *
 * Grid cards are pre-rendered server components (`RosterCard`, with lazy
 * checklist badges) passed in via `cardsById` so each card can host its own
 * Suspense island. This client shell only filters + toggles layout.
 */

function initials(name: string | null): string {
  const clean = (name ?? "").trim();
  if (!clean) return "?";
  return clean.slice(0, 2).toUpperCase();
}

function signedHouseClass(value: number | null): string {
  if (value == null || value === 0) return "text-muted-foreground";
  return value > 0
    ? "text-emerald-600 dark:text-emerald-400"
    : "text-rose-600 dark:text-rose-400";
}

function CreatorHref(id: string): string {
  return `/creator-hub/creators/${id}`;
}

export function RosterGrid({
  creators,
  cardsById,
  isPast = false,
}: {
  creators: RosterCreator[];
  /** Server-rendered `<RosterCard>` elements keyed by creator id (grid view). */
  cardsById: Record<string, ReactNode>;
  isPast?: boolean;
}) {
  const { query } = useRosterSearch();
  const { view } = useRosterView();

  const filtered = useMemo(
    () => creators.filter((c) => matchesRosterSearch(c, query)),
    [creators, query],
  );

  if (creators.length === 0) {
    return (
      <EmptyState
        title={isPast ? "No past creators" : "No creators yet"}
        body={
          isPast
            ? "Ex-creators whose role was removed will appear here."
            : "Once you add creators they'll appear here as a searchable roster."
        }
      />
    );
  }

  if (filtered.length === 0) {
    return (
      <EmptyState
        title="No creators match your search"
        body="Try a different username, email, or affiliate code."
      />
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-[11px] text-muted-foreground">
        {filtered.length === creators.length
          ? `${creators.length} creator${creators.length === 1 ? "" : "s"}`
          : `${filtered.length} of ${creators.length} creators`}
      </p>
      {view === "grid" ? (
        <div className="grid grid-cols-1 gap-3 sm:gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((c) => (
            <div key={c.id}>{cardsById[c.id]}</div>
          ))}
        </div>
      ) : (
        <RosterTable creators={filtered} isPast={isPast} />
      )}
    </div>
  );
}

function RosterTable({
  creators,
  isPast,
}: {
  creators: RosterCreator[];
  isPast: boolean;
}) {
  return (
    <div className="overflow-x-auto rounded-2xl border">
      <table className="w-full min-w-[800px] text-sm">
        <thead>
          <tr className="border-b bg-muted/40 text-left text-[11px] uppercase tracking-wider text-muted-foreground">
            <th className="px-3 py-2 font-semibold">Creator</th>
            <th className="px-3 py-2 font-semibold">Code</th>
            <th className="px-3 py-2 text-right font-semibold">Sign-ups</th>
            <th className="px-3 py-2 text-right font-semibold">FTDs</th>
            <th className="px-3 py-2 text-right font-semibold">
              {isPast ? "Lifetime wager" : "Wager"}
            </th>
            <th className="px-3 py-2 text-right font-semibold">GGR</th>
            <th className="px-3 py-2 text-right font-semibold">PnL</th>
            <th className="px-3 py-2 text-right font-semibold">Deal</th>
          </tr>
        </thead>
        <tbody>
          {creators.map((c) => {
            return (
            <tr
              key={c.id}
              className="border-b last:border-0 transition-colors hover:bg-accent/30"
            >
              <td className="px-3 py-2">
                <Link
                  href={CreatorHref(c.id)}
                  className="flex items-center gap-2.5 outline-none focus-visible:underline"
                >
                  <Avatar className="size-7 shrink-0">
                    {c.image && <AvatarImage src={c.image} alt="" />}
                    <AvatarFallback className="bg-pink-500/15 text-[10px] font-semibold text-pink-700 dark:text-pink-300">
                      {initials(c.username)}
                    </AvatarFallback>
                  </Avatar>
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate font-medium">
                      {c.username ?? "Unknown"}
                    </span>
                    {c.isPastCreator && <ExCreatorBadge />}
                    {c.isLive && <LiveDot />}
                  </span>
                </Link>
              </td>
              <td className="px-3 py-2">
                {c.code ? (
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {c.code}
                  </span>
                ) : (
                  <span className="text-[11px] text-muted-foreground/60">—</span>
                )}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {formatNumber(c.signups)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {formatNumber(c.ftds)}
              </td>
              <td className="px-3 py-2 text-right font-medium tabular-nums text-emerald-600 dark:text-emerald-400">
                {formatCompactUsd(c.windowedWagerUsd)}
              </td>
              <td
                className={cn(
                  "px-3 py-2 text-right font-medium tabular-nums",
                  signedHouseClass(c.windowedGgrUsd),
                )}
              >
                {c.windowedGgrUsd != null
                  ? formatCompactUsd(c.windowedGgrUsd)
                  : "—"}
              </td>
              <td
                className={cn(
                  "px-3 py-2 text-right font-medium tabular-nums",
                  signedHouseClass(c.lifetimePnlUsd),
                )}
              >
                {c.lifetimePnlUsd != null
                  ? formatCompactUsd(c.lifetimePnlUsd)
                  : "—"}
              </td>
              <td className="px-3 py-2 text-right font-medium tabular-nums text-rose-600 dark:text-rose-400">
                {c.dealValue ? formatCompactUsd(c.dealValue.dealValueUsd) : "—"}
              </td>
            </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ExCreatorBadge() {
  return (
    <Badge
      variant="outline"
      className="h-5 shrink-0 border-purple-500/40 bg-purple-500/10 py-0 text-[10px] font-medium text-purple-600 dark:text-purple-400"
    >
      Ex-creator
    </Badge>
  );
}

function LiveDot() {
  return (
    <span
      aria-hidden
      className="inline-block size-2 shrink-0 rounded-full bg-emerald-500 shadow-[0_0_0_3px_rgba(52,211,153,0.25)] motion-safe:animate-pulse"
    />
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex min-h-[220px] flex-col items-center justify-center gap-2 rounded-2xl border border-dashed py-12 text-center">
      <Users2 className="size-6 text-muted-foreground/60" />
      <p className="text-sm font-semibold">{title}</p>
      <p className="max-w-xs text-xs text-muted-foreground">{body}</p>
    </div>
  );
}
