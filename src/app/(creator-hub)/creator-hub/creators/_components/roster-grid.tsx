"use client";

import { useMemo, type ReactNode } from "react";
import Link from "next/link";
import { MessageCircle, Users2 } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { formatCompactUsd, formatNumber } from "@/lib/utils/format";

import { HubEmptyState } from "../../_components/hub-notice";
import type { RosterCreator } from "../_queries/list-roster-creators";
import { useRosterSearch, matchesRosterSearch } from "./roster-search-context";
import { useRosterView } from "./roster-view-context";
import {
  ChecklistPill,
  CreatorHref,
  DealStatusBadge,
  ExCreatorBadge,
  LiveDot,
  PLATFORM_META,
  initials,
  signedHouseClass,
} from "./roster-bits";

/**
 * Creator Hub roster — card grid + dense table renderer.
 *
 * Grid cards are pre-rendered server components (`RosterCard`) passed in via
 * `cardsById`; the server builds them ONLY when the parsed `?view=` is grid.
 * This client shell filters + toggles layout. If the user flips list → grid
 * before the grid RSC payload lands, missing cards render as skeletons for
 * the brief transition.
 *
 * The single muted meta line merges the creator count with the page's
 * window-scope caption (previously two separate lines).
 */
export function RosterGrid({
  creators,
  cardsById,
  isPast = false,
  caption,
}: {
  creators: RosterCreator[];
  /** Server-rendered `<RosterCard>` elements keyed by creator id (grid view only). */
  cardsById: Record<string, ReactNode>;
  isPast?: boolean;
  /** Scope caption merged into the meta line ("Wager + GGR scoped to …"). */
  caption: string;
}) {
  const { query } = useRosterSearch();
  const { view } = useRosterView();

  const filtered = useMemo(
    () => creators.filter((c) => matchesRosterSearch(c, query)),
    [creators, query],
  );

  if (creators.length === 0) {
    return (
      <HubEmptyState
        icon={Users2}
        title={isPast ? "No past creators" : "No creators yet"}
        sub={
          isPast
            ? "Ex-creators whose role was removed will appear here."
            : "Once you add creators they'll appear here as a searchable roster."
        }
      />
    );
  }

  if (filtered.length === 0) {
    return (
      <HubEmptyState
        icon={Users2}
        title="No creators match your search"
        sub="Try a different username, email, or affiliate code."
      />
    );
  }

  const countText =
    filtered.length === creators.length
      ? `${creators.length} creator${creators.length === 1 ? "" : "s"}`
      : `${filtered.length} of ${creators.length} creators`;

  return (
    <div className="space-y-2">
      <p className="text-[11px] text-muted-foreground">
        <span className="font-medium text-foreground/70">{countText}</span>
        <span aria-hidden> · </span>
        {caption}
      </p>
      {view === "grid" ? (
        <div className="grid grid-cols-1 gap-3 sm:gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((c) => (
            <div key={c.id}>
              {cardsById[c.id] ?? <Skeleton className="h-56 rounded-xl" />}
            </div>
          ))}
        </div>
      ) : (
        <RosterTable creators={filtered} isPast={isPast} />
      )}
    </div>
  );
}

/**
 * List view — a true density mode with the same data the cards show:
 * checklist pill, deal-status badge, and socials as compact icons, on the
 * shared table primitives.
 */
function RosterTable({
  creators,
  isPast,
}: {
  creators: RosterCreator[];
  isPast: boolean;
}) {
  return (
    <div className="rounded-xl border">
      <Table className="min-w-[960px]">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="px-3">Creator</TableHead>
            <TableHead className="px-3">Code</TableHead>
            <TableHead className="px-3">Socials</TableHead>
            <TableHead className="px-3 text-right">Sign-ups</TableHead>
            <TableHead className="px-3 text-right">FTDs</TableHead>
            <TableHead className="px-3 text-right">
              {isPast ? "Lifetime wager" : "Wager"}
            </TableHead>
            <TableHead className="px-3 text-right">GGR</TableHead>
            <TableHead className="px-3 text-right">PnL</TableHead>
            <TableHead className="px-3 text-right">Deal</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {creators.map((c) => (
            <TableRow key={c.id}>
              <TableCell className="px-3">
                <Link
                  href={CreatorHref(c.id)}
                  className="flex items-center gap-2.5 outline-none focus-visible:underline"
                >
                  <Avatar className="size-7 shrink-0">
                    {c.image && <AvatarImage src={c.image} alt="" />}
                    <AvatarFallback className="bg-muted text-[10px] font-semibold text-muted-foreground">
                      {initials(c.username)}
                    </AvatarFallback>
                  </Avatar>
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate font-medium">
                      {c.username ?? "Unknown"}
                    </span>
                    {c.isPastCreator && <ExCreatorBadge />}
                    {c.isLive && <LiveDot />}
                    {!c.isPastCreator && c.checklist && (
                      <ChecklistPill progress={c.checklist} />
                    )}
                  </span>
                </Link>
              </TableCell>
              <TableCell className="px-3">
                {c.code ? (
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {c.code}
                  </span>
                ) : (
                  <span className="text-[11px] text-muted-foreground/60">—</span>
                )}
              </TableCell>
              <TableCell className="px-3">
                {c.socials.length > 0 ? (
                  <span className="flex items-center gap-1">
                    {c.socials.map((s) => {
                      const meta = PLATFORM_META[s.platform];
                      const Icon = meta?.icon ?? MessageCircle;
                      const label = `${meta?.label ?? s.platform}: ${s.username}`;
                      return (
                        <span
                          key={s.id}
                          className="inline-flex"
                          title={label}
                          aria-label={label}
                        >
                          <Icon
                            className={cn(
                              "size-3.5",
                              meta?.glyphClass ?? "text-muted-foreground",
                            )}
                            aria-hidden
                          />
                        </span>
                      );
                    })}
                  </span>
                ) : (
                  <span className="text-[11px] text-muted-foreground/60">—</span>
                )}
              </TableCell>
              <TableCell className="px-3 text-right tabular-nums">
                {formatNumber(c.signups)}
              </TableCell>
              <TableCell className="px-3 text-right tabular-nums">
                {formatNumber(c.ftds)}
              </TableCell>
              <TableCell className="px-3 text-right font-medium tabular-nums text-emerald-600 dark:text-emerald-400">
                {formatCompactUsd(c.windowedWagerUsd)}
              </TableCell>
              <TableCell
                className={cn(
                  "px-3 text-right font-medium tabular-nums",
                  signedHouseClass(c.windowedGgrUsd),
                )}
              >
                {c.windowedGgrUsd != null
                  ? formatCompactUsd(c.windowedGgrUsd)
                  : "—"}
              </TableCell>
              <TableCell
                className={cn(
                  "px-3 text-right font-medium tabular-nums",
                  signedHouseClass(c.lifetimePnlUsd),
                )}
              >
                {c.lifetimePnlUsd != null
                  ? formatCompactUsd(c.lifetimePnlUsd)
                  : "—"}
              </TableCell>
              <TableCell className="px-3 text-right">
                <span className="inline-flex items-center justify-end gap-1.5">
                  {!c.isPastCreator && (
                    <DealStatusBadge status={c.dealStatus} />
                  )}
                  <span className="font-medium tabular-nums text-rose-600 dark:text-rose-400">
                    {c.dealValue
                      ? formatCompactUsd(c.dealValue.dealValueUsd)
                      : "—"}
                  </span>
                </span>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
