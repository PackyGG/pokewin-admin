"use client";

import * as React from "react";
import Link from "next/link";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { History } from "lucide-react";
import { formatRelative, formatCurrency } from "@/lib/utils/format";
import { useFormatDateTime } from "@/components/timezone-provider";
import { EmptyState } from "@/components/empty-state";
import { cn } from "@/lib/utils";
import type {
  CreatorChangelogEvent,
  ChangelogTone,
} from "@/lib/queries/creators-changelog";

/**
 * Creator Hub → Changelog feed.
 *
 * The Hub presentation of the SAME creator-marketing audit feed the
 * existing `/creators/changelog` renders — it consumes the identical shared
 * `CreatorChangelogEvent` shape from `@/lib/queries/creators-changelog`
 * (one query, two surfaces). Only the chrome differs: this version sits
 * inside the Hub's rounded card container (`SectionHeading` lives in the
 * page) and links target the SAME admin routes (the Hub reuses the admin
 * shell), so /admin-users/[id] + /users/[id] resolve unchanged.
 *
 * House-POV colors per CLAUDE.md: the event tone (emerald / blue / amber /
 * rose) is decided once in the query and carried on each row; the per-fill
 * deal amount is a house cost → rose. No money figure here is rendered from
 * a user POV.
 */

/**
 * House-POV badge classes per tone (mirrors the constants pattern in
 * `src/lib/constants.ts` and the existing changelog feed):
 *   - emerald / blue / amber / rose, with dark-mode variants.
 */
const TONE_BADGE: Record<ChangelogTone, string> = {
  emerald:
    "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  blue: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  amber:
    "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
  rose: "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30",
};

/**
 * Time cell — render the timezone-aware absolute time as the primary value
 * (an audit/changelog needs an exact, orderable clock) with the relative
 * string as a hover tooltip for at-a-glance recency.
 */
function EventTime({
  createdAt,
  className,
}: {
  createdAt: string;
  className?: string;
}) {
  const formatDateTime = useFormatDateTime();
  // suppressHydrationWarning: the tz-aware absolute time is SSR'd in UTC on a
  // first-ever visit (no admin_tz cookie) but the client adopts the browser
  // zone post-mount; a late-hydrating leg then mismatches (React #418). Same
  // class + fix as users/columns.tsx RegisteredCell. Span wraps only the time.
  return (
    <span
      suppressHydrationWarning
      className={className}
      title={formatRelative(createdAt)}
    >
      {formatDateTime(createdAt)}
    </span>
  );
}

/** Acting employee, or a neutral "System" badge when unattributed. */
function ActorCell({ event }: { event: CreatorChangelogEvent }) {
  if (event.adminUserId) {
    return (
      <Link
        href={`/admin-users/${event.adminUserId}`}
        className="inline-block max-w-full truncate text-blue-400 hover:underline"
      >
        {event.adminUsername ?? event.adminUserId.slice(0, 8)}
      </Link>
    );
  }
  return (
    <Badge
      variant="outline"
      className="h-5 border-zinc-500/30 bg-zinc-500/15 px-1.5 text-[10px] text-zinc-600 dark:text-zinc-400"
    >
      System
    </Badge>
  );
}

/** Target creator/user link, or an em-dash when there's no target. */
function TargetCell({ event }: { event: CreatorChangelogEvent }) {
  if (!event.targetUserId) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <Link
      href={`/users/${event.targetUserId}`}
      className="inline-block max-w-full truncate text-blue-400 hover:underline"
    >
      {event.targetUsername ?? event.targetUserId.slice(0, 8)}
    </Link>
  );
}

/**
 * Render the handful of metadata keys these creator-marketing events
 * actually carry (verified against the writers — see the source-of-truth
 * comment in `@/lib/queries/creators-changelog`):
 *   - user_made_creator           → { code } | { via, already_creator }
 *   - creator_deal_created        → { deal_id, week_start_utc, week_end_utc,
 *                                     fills_allowed, per_fill_amount_usd,
 *                                     conversion_rate_bps, via }
 *   - creator_force_reset_to_user → { backend_demoted, backend_error, via }
 *   - creator_removed (role_changed) → { prev_role, new_role }
 *   - excluded_user_added         → { reason }
 *   - excluded_user_removed       → (none)
 *
 * Anything not explicitly handled is surfaced as a generic key:value chip
 * so no stored field is ever silently dropped (the JSON is the immutable
 * record of what happened).
 */
function MetadataCell({ event }: { event: CreatorChangelogEvent }) {
  const meta = event.metadata;
  if (!meta || typeof meta !== "object") {
    return <span className="text-muted-foreground">—</span>;
  }
  const m = meta as Record<string, unknown>;
  const items: React.ReactNode[] = [];

  if (typeof m.code === "string") {
    items.push(
      <Badge
        key="code"
        variant="outline"
        className="px-1.5 py-0 font-mono text-[10px]"
      >
        {m.code}
      </Badge>,
    );
  }
  if (typeof m.deal_id === "string") {
    items.push(
      <span key="deal" className="font-mono text-xs text-muted-foreground">
        deal:{m.deal_id.slice(0, 8)}
      </span>,
    );
  }
  if (m.fills_allowed != null) {
    items.push(
      <Badge key="fills" variant="outline" className="px-1.5 py-0 text-[10px]">
        {String(m.fills_allowed)} fills
      </Badge>,
    );
  }
  if (m.per_fill_amount_usd != null) {
    // A creator deal's per-fill amount is money the house funds → a house
    // cost → rose per CLAUDE.md.
    items.push(
      <span
        key="perfill"
        className="text-xs font-medium text-rose-600 dark:text-rose-400"
      >
        {formatCurrency(Number(m.per_fill_amount_usd))}/fill
      </span>,
    );
  }
  if (m.conversion_rate_bps != null) {
    items.push(
      <Badge key="bps" variant="outline" className="px-1.5 py-0 text-[10px]">
        {(Number(m.conversion_rate_bps) / 100).toFixed(2)}% conv
      </Badge>,
    );
  }
  if (typeof m.reason === "string" && m.reason.length > 0) {
    items.push(
      <span
        key="reason"
        className="max-w-[220px] truncate text-xs text-muted-foreground"
        title={m.reason}
      >
        &ldquo;{m.reason}&rdquo;
      </span>,
    );
  }
  if (typeof m.prev_role === "string" && typeof m.new_role === "string") {
    // Creator-removal (re-typed from a role_changed row): show the
    // before→after role transition so it's clear what the user became.
    items.push(
      <span key="role" className="text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{m.prev_role}</span>
        {" → "}
        <span className="font-medium text-foreground">{m.new_role}</span>
      </span>,
    );
  }
  if (m.backend_demoted != null) {
    // Demote backend sync result: succeeded = neutral/ok, failed = rose.
    const ok = m.backend_demoted === true;
    items.push(
      <Badge
        key="bd"
        variant="outline"
        className={cn(
          "px-1.5 py-0 text-[10px]",
          ok
            ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
            : "bg-rose-500/15 text-rose-600 dark:text-rose-400",
        )}
      >
        backend {ok ? "demoted" : "not demoted"}
      </Badge>,
    );
  }
  if (typeof m.backend_error === "string" && m.backend_error.length > 0) {
    items.push(
      <span
        key="be"
        className="max-w-[220px] truncate text-xs text-rose-600 dark:text-rose-400"
        title={m.backend_error}
      >
        {m.backend_error}
      </span>,
    );
  }

  // Surface any remaining keys generically so nothing stored is invisible.
  const handled = new Set([
    "code",
    "deal_id",
    "fills_allowed",
    "per_fill_amount_usd",
    "conversion_rate_bps",
    "reason",
    "prev_role",
    "new_role",
    "backend_demoted",
    "backend_error",
    // Noise keys that add nothing in the feed (origin tagging + already-state
    // + the verbose deal date strings which the period filter already frames).
    "via",
    "already_creator",
    "week_start_utc",
    "week_end_utc",
  ]);
  for (const [k, v] of Object.entries(m)) {
    if (handled.has(k)) continue;
    items.push(
      <span
        key={`rest-${k}`}
        className="font-mono text-xs text-muted-foreground"
      >
        {k}:
        {typeof v === "string" && v.length > 16
          ? v.slice(0, 16) + "…"
          : String(v)}
      </span>,
    );
  }

  if (items.length === 0) {
    return <span className="text-muted-foreground">—</span>;
  }
  return <div className="flex flex-wrap items-center gap-1.5">{items}</div>;
}

function EventBadge({ event }: { event: CreatorChangelogEvent }) {
  return (
    <Badge
      variant="outline"
      className={cn("whitespace-nowrap", TONE_BADGE[event.tone])}
    >
      {event.label}
    </Badge>
  );
}

function ChangelogMobileCard({ event }: { event: CreatorChangelogEvent }) {
  return (
    <div className="border-b border-border/60 px-3 py-3 transition-colors last:border-b-0 hover:bg-muted/40">
      <div className="flex items-start justify-between gap-2">
        <EventBadge event={event} />
        <EventTime
          createdAt={event.createdAt}
          className="whitespace-nowrap text-[10px] text-muted-foreground"
        />
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <div className="space-y-0.5">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Employee
          </div>
          <div>
            <ActorCell event={event} />
          </div>
        </div>
        <div className="space-y-0.5">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Creator
          </div>
          <div>
            <TargetCell event={event} />
          </div>
        </div>
      </div>
      <div className="mt-2">
        <MetadataCell event={event} />
      </div>
    </div>
  );
}

/**
 * The Hub-styled changelog feed. Wrapped in a rounded card surface that
 * matches the rest of the Hub (`rounded-2xl border bg-card`). Renders a
 * mobile card list below `lg` and a table at `lg`+ — the same responsive
 * split the existing changelog uses, so nothing is lost on small screens.
 */
export function HubChangelogFeed({ data }: { data: CreatorChangelogEvent[] }) {
  return (
    <div className="overflow-hidden rounded-2xl border bg-card">
      {/* Mobile card list (<lg) */}
      <div className="lg:hidden">
        {data.length === 0 ? (
          <EmptyState
            icon={History}
            title="No creator events"
            description="No creator-marketing actions in this period."
            compact
          />
        ) : (
          data.map((event) => (
            <ChangelogMobileCard key={event.id} event={event} />
          ))
        )}
      </div>

      {/* Desktop table (>=lg) */}
      <div className="hidden overflow-x-auto lg:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Event</TableHead>
              <TableHead>Employee</TableHead>
              <TableHead>Creator</TableHead>
              <TableHead>Details</TableHead>
              <TableHead>Time</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((event) => (
              <TableRow key={event.id}>
                <TableCell>
                  <EventBadge event={event} />
                </TableCell>
                <TableCell className="text-sm font-medium">
                  <ActorCell event={event} />
                </TableCell>
                <TableCell className="text-sm">
                  <TargetCell event={event} />
                </TableCell>
                <TableCell>
                  <MetadataCell event={event} />
                </TableCell>
                <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                  <EventTime createdAt={event.createdAt} />
                </TableCell>
              </TableRow>
            ))}
            {data.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="p-0">
                  <EmptyState
                    icon={History}
                    title="No creator events"
                    description="No creator-marketing actions in this period."
                    compact
                  />
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
