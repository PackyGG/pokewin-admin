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
import { ScrollText } from "lucide-react";
import { formatRelative, formatCurrency } from "@/lib/utils/format";
import { useFormatDateTime } from "@/components/timezone-provider";
import type { AuditListItem } from "@/lib/queries/audit";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/empty-state";

const EVENT_COLORS: Record<string, string> = {
  admin_login: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  account_banned: "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30",
  account_unbanned: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  account_locked: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
  account_unlocked: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  balance_adjustment: "bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30",
  role_changed: "bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30",
  pack_activated: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  pack_deactivated: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
  withdrawal_processed: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  withdrawal_shipped: "bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30",
  // House-POV: completed withdrawal = user successfully took money out → rose.
  withdrawal_completed: "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30",
  withdrawal_cancelled: "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30",
  withdrawal_failed: "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30",
  chat_message_deleted: "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30",
  chat_message_pinned: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  chat_message_unpinned: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
  chat_muted: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
  chat_unmuted: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  admin_user_created: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  promo_code_created: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
};

function eventBadgeClass(eventType: string): string {
  return (
    EVENT_COLORS[eventType] ??
    "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30"
  );
}

/**
 * Audit log time cell. An audit log's defining requirement is an exact,
 * orderable timestamp — a fuzzy "2 hours ago" alone can't distinguish two
 * events in the same bucket or place them on a real clock. So we render the
 * timezone-aware absolute time (via the same `useFormatDateTime` hook the
 * sibling /admin-users audit table already uses) as the primary value, with
 * the relative string kept as a hover tooltip for at-a-glance recency.
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

/**
 * Renders the acting admin, or a distinct "System" badge when no admin is
 * attributed (the column is nullable — system/automated events are allowed,
 * and a deleted admin's id is nulled out so its logs survive). Without this,
 * a legitimately actor-less event was indistinguishable from a corrupt row.
 */
function AdminCell({ item }: { item: AuditListItem }) {
  if (item.adminUserId) {
    return (
      <Link
        href={`/admin-users/${item.adminUserId}`}
        className="text-blue-400 hover:underline truncate inline-block max-w-full"
      >
        {item.adminUsername ?? item.adminUserId.slice(0, 8)}
      </Link>
    );
  }
  return (
    <Badge
      variant="outline"
      className="h-5 px-1.5 text-[10px] bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30"
    >
      System
    </Badge>
  );
}

function MetadataCell({
  eventType,
  metadata,
  messageContent,
  messageDeleted,
  promoCodeId,
}: {
  eventType: string;
  metadata: unknown;
  messageContent: string | null;
  messageDeleted: boolean | null;
  promoCodeId: string | null;
}) {
  if (!metadata || typeof metadata !== "object")
    return <span className="text-muted-foreground">-</span>;
  const m = metadata as Record<string, unknown>;

  const items: React.ReactNode[] = [];

  if (m.withdrawal_id) {
    items.push(
      <Link
        key="wd"
        href={`/withdrawals/${m.withdrawal_id}`}
        className="text-blue-400 hover:underline font-mono text-xs"
      >
        {(m.withdrawal_id as string).slice(0, 8)}...
      </Link>
    );
  }
  if (m.message_id && messageContent) {
    items.push(
      <span
        key="msg"
        className={`text-xs italic max-w-[300px] truncate ${messageDeleted ? "line-through text-muted-foreground" : ""}`}
        title={messageContent}
      >
        &ldquo;{messageContent}&rdquo;
      </span>
    );
  } else if (m.message_id) {
    items.push(
      <span key="msg" className="font-mono text-xs text-muted-foreground">
        msg:{(m.message_id as string).slice(0, 8)}
      </span>
    );
  }
  if (m.pack_id) {
    items.push(
      <Link
        key="pack"
        href={`/packs/${m.pack_id}`}
        className="text-blue-400 hover:underline font-mono text-xs"
      >
        pack:{(m.pack_id as string).slice(0, 8)}
      </Link>
    );
  }

  if (m.method) {
    items.push(
      <Badge key="method" variant="outline" className="text-[10px] px-1.5 py-0">
        {m.method as string}
      </Badge>
    );
  }
  if (m.action) {
    items.push(
      <Badge key="action" variant="outline" className="text-[10px] px-1.5 py-0">
        {m.action as string}
      </Badge>
    );
  }
  if (m.new_role) {
    items.push(
      <Badge
        key="role"
        variant="outline"
        className="text-[10px] px-1.5 py-0 bg-purple-500/15 text-purple-600 dark:text-purple-400"
      >
        {m.new_role as string}
      </Badge>
    );
  }
  if (m.role) {
    items.push(
      <Badge
        key="role2"
        variant="outline"
        className="text-[10px] px-1.5 py-0 bg-purple-500/15 text-purple-600 dark:text-purple-400"
      >
        {m.role as string}
      </Badge>
    );
  }
  if (m.feature) {
    items.push(
      <Badge key="feat" variant="outline" className="text-[10px] px-1.5 py-0">
        {(m.feature as string).replace(/_/g, " ")}
      </Badge>
    );
  }
  if (m.locked != null) {
    items.push(
      <Badge
        key="lock"
        variant="outline"
        className={`text-[10px] px-1.5 py-0 ${m.locked ? "bg-rose-500/15 text-rose-600 dark:text-rose-400" : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"}`}
      >
        {m.locked ? "locked" : "unlocked"}
      </Badge>
    );
  }

  if (m.amount != null) {
    // Admin balance adjustments: a positive `amount` means the admin
    // CREDITED the user — from the house's perspective that's a loss
    // (we paid the user), so it reads rose with a − sign. A negative
    // adjustment (debit) is money back to the house → emerald / +.
    const amt = Number(m.amount);
    const houseGain = amt < 0;
    items.push(
      <span
        key="amt"
        className={`text-xs font-medium ${
          amt === 0
            ? "text-muted-foreground"
            : houseGain
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-rose-600 dark:text-rose-400"
        }`}
      >
        {houseGain ? "+" : amt > 0 ? "-" : ""}
        {formatCurrency(Math.abs(amt))}
      </span>
    );
  }
  if (m.amount_usd != null) {
    // `amount_usd` is used on withdrawal_* / payout_* events — money
    // leaving the house, so colored rose per CLAUDE.md.
    items.push(
      <span
        key="amtusd"
        className="text-xs font-medium text-rose-600 dark:text-rose-400"
      >
        {formatCurrency(Number(m.amount_usd))}
      </span>
    );
  }

  if (m.reason) {
    items.push(
      <span
        key="reason"
        className="text-xs text-muted-foreground truncate max-w-[200px]"
      >
        &ldquo;{m.reason as string}&rdquo;
      </span>
    );
  }
  if (m.carrier) {
    items.push(
      <span key="carrier" className="text-xs text-muted-foreground">
        {m.carrier as string}
      </span>
    );
  }
  if (m.tracking_number) {
    items.push(
      <span key="track" className="font-mono text-xs text-muted-foreground">
        {m.tracking_number as string}
      </span>
    );
  }
  if (m.email && eventType.includes("admin_user")) {
    items.push(
      <span key="email" className="text-xs text-muted-foreground">
        {m.email as string}
      </span>
    );
  }
  if (m.username && eventType.includes("admin_user")) {
    items.push(
      <span key="uname" className="text-xs font-medium">
        {m.username as string}
      </span>
    );
  }
  if (m.code_hash) {
    if (promoCodeId) {
      items.push(
        <Link
          key="code"
          href={`/promo-codes/${promoCodeId}`}
          className="text-blue-400 hover:underline font-mono text-xs"
        >
          code:{(m.code_hash as string).slice(0, 8)}
        </Link>
      );
    } else {
      items.push(
        <span key="code" className="font-mono text-xs text-muted-foreground">
          code:{(m.code_hash as string).slice(0, 8)}
        </span>
      );
    }
  }
  if (m.region) {
    items.push(
      <Badge key="region" variant="outline" className="text-[10px] px-1.5 py-0">
        {m.region as string}
      </Badge>
    );
  }
  if (m.value != null && !m.amount && eventType.includes("promo")) {
    // Promo code value — the credit we hand out → house liability →
    // rose per CLAUDE.md.
    items.push(
      <span
        key="val"
        className="text-xs font-medium text-rose-600 dark:text-rose-400"
      >
        {formatCurrency(Number(m.value))}
      </span>
    );
  }

  // Generic ID links
  if (m.battle_id) {
    items.push(
      <Link key="battle" href={`/battles/${m.battle_id}`} className="text-blue-400 hover:underline font-mono text-xs">
        battle:{(m.battle_id as string).slice(0, 8)}
      </Link>
    );
  }
  if (m.raffle_id) {
    items.push(
      <Link key="raffle" href={`/rewards/raffles/${m.raffle_id}`} className="text-blue-400 hover:underline font-mono text-xs">
        raffle:{(m.raffle_id as string).slice(0, 8)}
      </Link>
    );
  }
  if (m.reward_id) {
    items.push(
      <Link key="reward" href={`/rewards/${m.reward_id}`} className="text-blue-400 hover:underline font-mono text-xs">
        reward:{(m.reward_id as string).slice(0, 8)}
      </Link>
    );
  }

  // Generic descriptive fields
  if (m.name) {
    items.push(
      <span key="name" className="text-xs font-medium">
        {m.name as string}
      </span>
    );
  }
  if (m.slug) {
    items.push(
      <Badge key="slug" variant="outline" className="text-[10px] px-1.5 py-0">
        {m.slug as string}
      </Badge>
    );
  }
  if (m.type) {
    items.push(
      <Badge key="type" variant="outline" className="text-[10px] px-1.5 py-0">
        {m.type as string}
      </Badge>
    );
  }

  // Site config: field + value
  if (m.field) {
    items.push(
      <span key="field" className="text-xs font-medium">
        {(m.field as string).replace(/_/g, " ")}
      </span>
    );
    if (m.value != null && !eventType.includes("promo")) {
      items.push(
        <Badge
          key="cfgval"
          variant="outline"
          className={`text-[10px] px-1.5 py-0 ${m.value === true ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" : m.value === false ? "bg-rose-500/15 text-rose-600 dark:text-rose-400" : ""}`}
        >
          {String(m.value)}
        </Badge>
      );
    }
  }

  // Always surface remaining unhandled keys as key:value chips — NOT only
  // when zero curated items matched. The metadata JSON is the immutable record
  // of what happened, so dropping extra keys whenever a row had at least one
  // recognized key would let a reviewer believe they see the full payload when
  // they don't. The curated renderers above stay for known keys; everything
  // else is appended generically so no stored field is ever invisible.
  const handled = new Set([
    "withdrawal_id", "message_id", "pack_id", "method", "action",
    "new_role", "role", "feature", "locked", "amount", "amount_usd",
    "reason", "carrier", "tracking_number", "email", "username",
    "code_hash", "region", "value", "battle_id", "raffle_id",
    "reward_id", "name", "slug", "type", "field",
  ]);
  const remaining = Object.entries(m).filter(([k]) => !handled.has(k));
  for (const [k, v] of remaining) {
    items.push(
      <span key={`rest-${k}`} className="font-mono text-xs text-muted-foreground">
        {k}:{typeof v === "string" && v.length > 16 ? v.slice(0, 16) + "…" : String(v)}
      </span>
    );
  }

  if (items.length === 0)
    return <span className="text-muted-foreground">-</span>;

  return <div className="flex flex-wrap items-center gap-1.5">{items}</div>;
}

function AuditMobileCard({ item }: { item: AuditListItem }) {
  return (
    <div className="border-b border-border/60 last:border-b-0 px-3 py-3 hover:bg-muted/40 transition-colors">
      <div className="flex items-start justify-between gap-2">
        <Badge
          variant="outline"
          className={cn("h-5 px-1.5 text-[10px]", eventBadgeClass(item.eventType))}
        >
          {item.eventType.replace(/_/g, " ")}
        </Badge>
        <EventTime
          createdAt={item.createdAt}
          className="text-[10px] text-muted-foreground whitespace-nowrap"
        />
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <div className="space-y-0.5">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Admin
          </div>
          <div>
            <AdminCell item={item} />
          </div>
        </div>
        <div className="space-y-0.5">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Target
          </div>
          <div>
            {item.targetUserId ? (
              <Link
                href={`/users/${item.targetUserId}`}
                className="text-blue-400 hover:underline truncate inline-block max-w-full"
              >
                {item.targetUsername ?? item.targetUserId.slice(0, 8)}
              </Link>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </div>
        </div>
      </div>
      {item.ip && (
        <div className="mt-1 font-mono text-[10px] text-muted-foreground">
          IP {item.ip}
        </div>
      )}
      <div className="mt-2">
        <MetadataCell
          eventType={item.eventType}
          metadata={item.metadata}
          messageContent={item.messageContent}
          messageDeleted={item.messageDeleted}
          promoCodeId={item.promoCodeId}
        />
      </div>
    </div>
  );
}

export function AuditActivityTable({ data }: { data: AuditListItem[] }) {
  return (
    <>
      {/* Mobile card list (<lg) */}
      <div className="lg:hidden">
        {data.length === 0 ? (
          <div className="rounded-md border">
            <EmptyState
              icon={ScrollText}
              title="No audit events found"
              description="No actions match the current filters."
              compact
            />
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border">
            {data.map((item) => (
              <AuditMobileCard key={item.id} item={item} />
            ))}
          </div>
        )}
      </div>

      {/* Desktop table (>=lg) */}
      <div className="hidden rounded-md border overflow-x-auto lg:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Event</TableHead>
              <TableHead>Admin</TableHead>
              <TableHead>Target User</TableHead>
              <TableHead>IP</TableHead>
              <TableHead>Details</TableHead>
              <TableHead>Time</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((item) => (
              <TableRow key={item.id}>
                <TableCell>
                  <Badge
                    variant="outline"
                    className={eventBadgeClass(item.eventType)}
                  >
                    {item.eventType.replace(/_/g, " ")}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm font-medium">
                  <AdminCell item={item} />
                </TableCell>
                <TableCell className="text-sm">
                  {item.targetUserId ? (
                    <Link
                      href={`/users/${item.targetUserId}`}
                      className="text-blue-400 hover:underline"
                    >
                      {item.targetUsername ?? item.targetUserId.slice(0, 8)}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">-</span>
                  )}
                </TableCell>
                <TableCell>
                  <span className="font-mono text-xs">{item.ip ?? "-"}</span>
                </TableCell>
                <TableCell>
                  <MetadataCell
                    eventType={item.eventType}
                    metadata={item.metadata}
                    messageContent={item.messageContent}
                    messageDeleted={item.messageDeleted}
                    promoCodeId={item.promoCodeId}
                  />
                </TableCell>
                <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                  <EventTime createdAt={item.createdAt} />
                </TableCell>
              </TableRow>
            ))}
            {data.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={6} className="p-0">
                  <EmptyState
                    icon={ScrollText}
                    title="No audit events found"
                    description="No actions match the current filters."
                    compact
                  />
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
