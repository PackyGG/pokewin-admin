"use client";

/**
 * AUDIT TAB (/users/[id]?tab=audit) — the admin action trail for ONE user.
 *
 * Purpose (owner): a user shows up banned/locked and nothing on the page says
 * WHO did it or WHY. `user.bannedBy` is a main-DB id that's usually null (the
 * acting admin lives in the ADMIN DB), so the authoritative answer is the
 * `admin_audit_events` row written by the ban action — actor + reason +
 * timestamp. This tab surfaces that row front-and-centre, then the full
 * chronological log of every admin action taken against the account.
 *
 * Data: `getUserAdminAuditFeed` (admin DB only, indexed on target_user_id),
 * kicked by page.tsx ONLY when ?tab=audit is active (Active-Timeframe-Only)
 * and streamed behind Suspense. The event vocabulary (labels / colors /
 * detail chips) is REUSED from the per-admin audit table so both surfaces
 * read identically.
 */

import { useMemo, useState, use, Suspense } from "react";
import Link from "next/link";
import { Ban, Lock, ScrollText, ChevronLeft, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/empty-state";
import { SkeletonTable } from "@/components/ux";
import { useFormatDateTime } from "@/components/timezone-provider";
import {
  EVENT_TYPE_COLORS,
  EVENT_TYPE_LABELS,
  EventDetails,
} from "@/app/(admin)/admin-users/[id]/audit-events-table";
import type { SafeQueryResult } from "@/lib/errors/safe-query";
import type {
  UserAdminAuditEvent,
  UserAdminAuditFeed,
} from "@/lib/queries/users-admin-audit";
import type { UserDetail } from "./user-tabs-types";
import { SectionHeading } from "./user-view-modern-panels";
import { BandError } from "./band-error";

const PER_PAGE = 20;

export function AuditTab({
  data,
  auditPromise,
}: {
  data: UserDetail;
  auditPromise: Promise<SafeQueryResult<UserAdminAuditFeed>> | null;
}) {
  return (
    <div className="space-y-6">
      {auditPromise ? (
        <Suspense fallback={<SkeletonTable rows={6} columns={5} leadingAvatar={false} />}>
          <AuditStreamed user={data.user} auditPromise={auditPromise} />
        </Suspense>
      ) : (
        <SkeletonTable rows={6} columns={5} leadingAvatar={false} />
      )}
    </div>
  );
}

function AuditStreamed({
  user,
  auditPromise,
}: {
  user: UserDetail["user"];
  auditPromise: Promise<SafeQueryResult<UserAdminAuditFeed>>;
}) {
  const result = use(auditPromise);
  const feed = result.data;

  if (result.error) {
    return (
      <BandError
        title="Audit trail failed to load"
        hint="The admin action log for this user couldn't be read. Retry to re-run it."
      />
    );
  }

  return (
    <div className="space-y-6">
      <EnforcementSummary user={user} events={feed.events} />
      <AuditLog feed={feed} />
    </div>
  );
}

/**
 * Newest audit row among the given types — the row that produced the CURRENT
 * enforcement state (the log is already ordered created_at DESC).
 */
function latestOf(events: UserAdminAuditEvent[], ...eventTypes: string[]) {
  return events.find((e) => eventTypes.includes(e.eventType)) ?? null;
}

function metaReason(event: UserAdminAuditEvent | null): string | null {
  if (!event) return null;
  const meta = event.metadata as Record<string, unknown> | null;
  const reason = meta?.reason;
  return typeof reason === "string" && reason.trim() ? reason : null;
}

/**
 * "Who put this account in its current state, and why" — the one thing an
 * admin opening this tab is looking for. Only renders when the account is
 * actually banned or locked; the reason falls back to the main-DB column
 * when the audit row carries none.
 */
function EnforcementSummary({
  user,
  events,
}: {
  user: UserDetail["user"];
  events: UserAdminAuditEvent[];
}) {
  const formatDateTime = useFormatDateTime();
  if (!user.isBanned && !user.isLocked) return null;

  // A ban can come from the single-user action OR from a bulk ban (one audit
  // row covering the whole batch) — both answer "who and why", so both count.
  const banEvent = user.isBanned
    ? latestOf(events, "account_banned", "accounts_bulk_banned")
    : null;
  const lockEvent = user.isLocked ? latestOf(events, "account_locked") : null;

  const cards: Array<{
    key: string;
    icon: typeof Ban;
    title: string;
    reason: string | null;
    at: string | null;
    actor: string | null;
    actorId: string | null;
    unattributed: boolean;
    /** Extra context, e.g. "part of a bulk ban of 5,011 accounts". */
    note: string | null;
  }> = [];

  if (user.isBanned) {
    cards.push({
      key: "ban",
      icon: Ban,
      title: "Banned",
      reason: metaReason(banEvent) ?? user.bannedReason,
      at: banEvent?.createdAt ?? user.bannedAt,
      actor: banEvent?.adminUsername ?? null,
      actorId: banEvent?.adminUserId ?? null,
      unattributed: !banEvent,
      note: banEvent?.bulkCount
        ? `Part of a bulk ban of ${banEvent.bulkCount.toLocaleString()} accounts`
        : null,
    });
  }
  if (user.isLocked) {
    cards.push({
      key: "lock",
      icon: Lock,
      title: "Locked",
      reason: metaReason(lockEvent) ?? user.lockedReason,
      at: lockEvent?.createdAt ?? user.lockedAt,
      actor: lockEvent?.adminUsername ?? null,
      actorId: lockEvent?.adminUserId ?? null,
      unattributed: !lockEvent,
      note: null,
    });
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {cards.map((c) => (
        <Card key={c.key}>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="flex size-8 items-center justify-center rounded-md border bg-muted/40">
                <c.icon className="size-4 text-muted-foreground" />
              </span>
              <div>
                <p className="text-sm font-medium">{c.title}</p>
                <p
                  suppressHydrationWarning
                  className="text-xs text-muted-foreground"
                >
                  {c.at ? formatDateTime(c.at) : "date unknown"}
                </p>
              </div>
            </div>
            <div className="space-y-1 text-xs">
              <p>
                <span className="text-muted-foreground">By: </span>
                {c.actor ? (
                  c.actorId ? (
                    <Link
                      href={`/admin-users/${c.actorId}`}
                      className="text-blue-400 hover:underline"
                    >
                      {c.actor}
                    </Link>
                  ) : (
                    <span className="font-medium">{c.actor}</span>
                  )
                ) : (
                  <span className="text-muted-foreground italic">
                    {c.unattributed
                      ? "no audit row (set outside the admin panel)"
                      : "system"}
                  </span>
                )}
              </p>
              <p>
                <span className="text-muted-foreground">Reason: </span>
                {c.reason ?? (
                  <span className="text-muted-foreground italic">none given</span>
                )}
              </p>
              {c.note && <p className="text-muted-foreground">{c.note}</p>}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/** Full chronological log, filterable by event type + paged client-side. */
function AuditLog({ feed }: { feed: UserAdminAuditFeed }) {
  const formatDateTime = useFormatDateTime();
  const [eventType, setEventType] = useState("all");
  const [page, setPage] = useState(1);

  // Only the types this user actually has — a 40-entry global dropdown of
  // mostly-empty filters would be noise on a per-user log.
  const presentTypes = useMemo(() => {
    const seen = new Set(feed.events.map((e) => e.eventType));
    return [...seen].sort((a, b) =>
      (EVENT_TYPE_LABELS[a] ?? a).localeCompare(EVENT_TYPE_LABELS[b] ?? b),
    );
  }, [feed.events]);

  const filtered = useMemo(
    () =>
      eventType === "all"
        ? feed.events
        : feed.events.filter((e) => e.eventType === eventType),
    [feed.events, eventType],
  );

  const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  const safePage = Math.min(page, totalPages);
  const rows = filtered.slice((safePage - 1) * PER_PAGE, safePage * PER_PAGE);

  return (
    <div className="space-y-4">
      <SectionHeading icon={ScrollText} title="Admin Action Log" />

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Event Type</Label>
          <Select
            value={eventType}
            onValueChange={(v) => {
              if (!v) return;
              setEventType(v);
              setPage(1);
            }}
          >
            <SelectTrigger className="h-9 w-[220px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All events</SelectItem>
              {presentTypes.map((t) => (
                <SelectItem key={t} value={t}>
                  {EVENT_TYPE_LABELS[t] ?? t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="text-xs text-muted-foreground">
          {feed.total} action{feed.total !== 1 ? "s" : ""} against this account
          {feed.truncated ? ` · showing the latest ${feed.events.length}` : ""}
        </p>
      </div>

      {/* Mobile card list (<lg) */}
      <div className="lg:hidden">
        {rows.length === 0 ? (
          <div className="rounded-md border">
            <EmptyState
              icon={ScrollText}
              title="No admin actions"
              description="Nothing has been done to this account from the admin panel."
              compact
            />
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border">
            {rows.map((e) => (
              <div
                key={e.id}
                className="border-b border-border/60 px-3 py-3 last:border-b-0"
              >
                <div className="flex items-start justify-between gap-2">
                  <Badge
                    variant="outline"
                    className={`h-5 px-1.5 text-[10px] ${EVENT_TYPE_COLORS[e.eventType] ?? "bg-muted text-muted-foreground border-border"}`}
                  >
                    {EVENT_TYPE_LABELS[e.eventType] ?? e.eventType}
                  </Badge>
                  <span
                    suppressHydrationWarning
                    className="whitespace-nowrap text-[10px] text-muted-foreground"
                  >
                    {formatDateTime(e.createdAt)}
                  </span>
                </div>
                <div className="mt-1 text-xs">
                  <span className="mr-2 text-[10px] uppercase tracking-wide text-muted-foreground">
                    By:
                  </span>
                  <AdminCell event={e} />
                </div>
                <div className="mt-2">
                  <DetailsCell event={e} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Desktop table (>=lg) */}
      <div className="hidden overflow-x-auto rounded-md border lg:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Event</TableHead>
              <TableHead>Admin</TableHead>
              <TableHead>Details</TableHead>
              <TableHead>IP</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="p-0">
                  <EmptyState
                    icon={ScrollText}
                    title="No admin actions"
                    description="Nothing has been done to this account from the admin panel."
                    compact
                  />
                </TableCell>
              </TableRow>
            )}
            {rows.map((e) => (
              <TableRow key={e.id}>
                <TableCell className="whitespace-nowrap text-sm">
                  {/* suppressHydrationWarning: first-visit SSR(UTC) vs the
                      client's browser timezone. Same as the admin audit table. */}
                  <span suppressHydrationWarning>
                    {formatDateTime(e.createdAt)}
                  </span>
                </TableCell>
                <TableCell>
                  <Badge
                    variant="outline"
                    className={`text-xs ${EVENT_TYPE_COLORS[e.eventType] ?? "bg-muted text-muted-foreground border-border"}`}
                  >
                    {EVENT_TYPE_LABELS[e.eventType] ?? e.eventType}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm">
                  <AdminCell event={e} />
                </TableCell>
                <TableCell className="text-sm">
                  <DetailsCell event={e} />
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {e.ip ?? "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            disabled={safePage <= 1}
            onClick={() => setPage(safePage - 1)}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {safePage} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            disabled={safePage >= totalPages}
            onClick={() => setPage(safePage + 1)}
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      )}
    </div>
  );
}

function AdminCell({ event }: { event: UserAdminAuditEvent }) {
  if (!event.adminUsername) {
    return <span className="text-muted-foreground">system</span>;
  }
  return event.adminUserId ? (
    <Link
      href={`/admin-users/${event.adminUserId}`}
      className="text-blue-400 hover:underline"
    >
      {event.adminUsername}
    </Link>
  ) : (
    <span>{event.adminUsername}</span>
  );
}

/**
 * Shared event-detail chips (reason, amount, links …) plus, for a BULK row,
 * how many accounts that one action covered — otherwise "Bulk Banned" reads
 * as if it were about this account alone.
 *
 * Target user/username are null by construction: on THIS page the target is
 * the page subject, so the shared renderer's target chips don't apply.
 */
function DetailsCell({ event }: { event: UserAdminAuditEvent }) {
  return (
    <div className="space-y-1">
      <EventDetails
        event={{
          id: event.id,
          eventType: event.eventType,
          targetUserId: null,
          targetUsername: null,
          ip: event.ip,
          metadata: event.metadata,
          createdAt: event.createdAt,
        }}
      />
      {event.bulkCount ? (
        <p className="text-xs text-muted-foreground">
          Batch action across {event.bulkCount.toLocaleString()} accounts
        </p>
      ) : null}
    </div>
  );
}
