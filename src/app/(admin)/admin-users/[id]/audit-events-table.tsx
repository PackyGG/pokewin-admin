"use client";

import { useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, Search, X, ScrollText } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState } from "@/components/empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useFormatDateTime } from "@/components/timezone-provider";
import type { PaginatedResult } from "@/lib/types";

export type AdminAuditEventItem = {
  id: string;
  eventType: string;
  targetUserId: string | null;
  targetUsername: string | null;
  ip: string | null;
  metadata: unknown;
  createdAt: string;
};

// Exported so the per-USER audit tab (/users/[id]?tab=audit) renders the same
// event vocabulary as this per-ADMIN table — one map, two surfaces.
export const EVENT_TYPE_COLORS: Record<string, string> = {
  admin_login: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  admin_user_created: "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30",
  admin_user_activated: "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30",
  admin_user_deactivated: "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30",
  admin_role_changed: "bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30",
  admin_2fa_reset: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
  admin_password_changed: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
  admin_password_reset: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
  admin_sessions_force_expired: "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30",
  balance_adjustment: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
  account_banned: "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30",
  // One row per BATCH — the affected ids live in metadata.user_ids.
  accounts_bulk_banned: "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30",
  account_unbanned: "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30",
  account_locked: "bg-orange-500/15 text-orange-600 dark:text-orange-400 border-orange-500/30",
  account_unlocked: "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30",
  role_changed: "bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30",
  withdrawal_processed: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  withdrawal_shipped: "bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30",
  withdrawal_completed: "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30",
  withdrawal_cancelled: "bg-muted text-muted-foreground border-border",
  withdrawal_failed: "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30",
  pack_activated: "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30",
  pack_deactivated: "bg-muted text-muted-foreground border-border",
  pack_update_approved: "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30",
  pack_update_rejected: "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30",
  card_update_approved: "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30",
  card_update_rejected: "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30",
  affiliate_payout_processed: "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30",
  promo_code_created: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  promo_code_deleted: "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30",
  rakeback_config_updated: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
  race_prize_tier_updated: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
  race_period_started: "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30",
  race_period_ended: "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30",
  race_period_auto_renew_toggled: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  country_restriction_updated: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
  chat_message_deleted: "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30",
  chat_message_pinned: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  chat_message_unpinned: "bg-muted text-muted-foreground border-border",
  chat_muted: "bg-orange-500/15 text-orange-600 dark:text-orange-400 border-orange-500/30",
  chat_unmuted: "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30",
  admin_note_created: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  admin_note_deleted: "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30",
  admin_builtin_role_updated: "bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30",
};

export const EVENT_TYPE_LABELS: Record<string, string> = {
  admin_login: "Login",
  admin_user_created: "User Created",
  admin_user_activated: "Activated",
  admin_user_deactivated: "Deactivated",
  admin_role_changed: "Role Changed",
  admin_2fa_reset: "2FA Reset",
  admin_password_changed: "Password Changed",
  admin_password_reset: "Password Reset",
  admin_sessions_force_expired: "Sessions Expired",
  balance_adjustment: "Balance Adjust",
  account_banned: "Banned",
  accounts_bulk_banned: "Bulk Banned",
  account_unbanned: "Unbanned",
  account_locked: "Locked",
  account_unlocked: "Unlocked",
  role_changed: "Role Changed",
  withdrawal_processed: "WD Processed",
  withdrawal_shipped: "WD Shipped",
  withdrawal_completed: "WD Completed",
  withdrawal_cancelled: "WD Cancelled",
  withdrawal_failed: "WD Failed",
  pack_activated: "Pack Activated",
  pack_deactivated: "Pack Deactivated",
  pack_update_approved: "Pack Approved",
  pack_update_rejected: "Pack Rejected",
  card_update_approved: "Card Approved",
  card_update_rejected: "Card Rejected",
  affiliate_payout_processed: "Affiliate Payout",
  promo_code_created: "Promo Created",
  promo_code_deleted: "Promo Deleted",
  rakeback_config_updated: "Rakeback Updated",
  race_prize_tier_updated: "Race Prize Updated",
  race_period_started: "Race Started",
  race_period_ended: "Race Ended",
  race_period_auto_renew_toggled: "Auto-renew Toggled",
  country_restriction_updated: "Country Updated",
  chat_message_deleted: "Message Deleted",
  chat_message_pinned: "Message Pinned",
  chat_message_unpinned: "Message Unpinned",
  chat_muted: "User Muted",
  chat_unmuted: "User Unmuted",
  admin_note_created: "Note Added",
  admin_note_deleted: "Note Deleted",
  admin_builtin_role_updated: "Built-in Role Updated",
};

export function EventDetails({ event }: { event: AdminAuditEventItem }) {
  const meta = event.metadata as Record<string, unknown> | null;
  if (!meta) return <span className="text-muted-foreground">—</span>;

  const details: React.ReactNode[] = [];

  // Auth method
  if (meta.method) {
    details.push(
      <Badge key="method" variant="outline" className="text-xs">
        {String(meta.method)}
      </Badge>
    );
  }

  // Target admin user
  if (meta.target_admin_id) {
    details.push(
      <Link
        key="admin"
        href={`/admin-users/${meta.target_admin_id}`}
        className="text-blue-400 hover:underline text-xs"
      >
        Admin {String(meta.target_admin_id).slice(0, 8)}...
      </Link>
    );
  }

  // New role
  if (meta.new_role) {
    details.push(
      <Badge key="role" variant="outline" className="text-xs uppercase">
        {String(meta.new_role)}
      </Badge>
    );
  }

  // Created admin user info
  if (meta.username && meta.email) {
    details.push(
      <span key="created-user" className="text-xs">
        <span className="font-medium">{String(meta.username)}</span>
        <span className="text-muted-foreground"> ({String(meta.email)})</span>
      </span>
    );
  }
  if (meta.role && !meta.new_role && !meta.target_admin_id) {
    details.push(
      <Badge key="created-role" variant="outline" className="text-xs uppercase">
        {String(meta.role)}
      </Badge>
    );
  }

  // Balance adjustment — house-POV: a positive credit to the user is a
  // house loss (we gave them money), a negative debit is a house gain
  // (we pulled money back). Per CLAUDE.md the sign and color both
  // follow the house's direction, not the ledger sign.
  if (meta.amount != null && event.eventType === "balance_adjustment") {
    const amt = Number(meta.amount);
    const houseGain = amt < 0;
    details.push(
      <span
        key="amount"
        className={`text-xs font-medium tabular-nums ${
          amt === 0
            ? "text-muted-foreground"
            : houseGain
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-rose-600 dark:text-rose-400"
        }`}
      >
        {houseGain ? "+" : amt > 0 ? "-" : ""}
        {Math.abs(amt).toFixed(2)} USD
      </span>
    );
  }

  // Withdrawal link
  if (meta.withdrawal_id) {
    details.push(
      <Link
        key="withdrawal"
        href={`/withdrawals/${meta.withdrawal_id}`}
        className="text-blue-400 hover:underline text-xs font-mono"
      >
        {String(meta.withdrawal_id).slice(0, 8)}...
      </Link>
    );
  }

  // Withdrawal shipping details
  if (meta.tracking_number) {
    details.push(
      <span key="tracking" className="text-xs text-muted-foreground">
        Tracking: {String(meta.tracking_number)}
      </span>
    );
  }
  if (meta.carrier) {
    details.push(
      <Badge key="carrier" variant="outline" className="text-xs">
        {String(meta.carrier)}
      </Badge>
    );
  }

  // Pack link
  if (meta.pack_id) {
    details.push(
      <Link
        key="pack"
        href={`/packs/${meta.pack_id}`}
        className="text-blue-400 hover:underline text-xs font-mono"
      >
        Pack {String(meta.pack_id).slice(0, 8)}...
      </Link>
    );
  }

  // Promo code value — credit we'll hand to users → house liability → rose.
  if (meta.value != null && event.eventType === "promo_code_created") {
    details.push(
      <span
        key="promo-value"
        className="text-xs font-medium text-rose-600 dark:text-rose-400"
      >
        ${Number(meta.value).toFixed(2)}
      </span>
    );
    if (meta.region) {
      details.push(
        <Badge key="promo-region" variant="outline" className="text-xs">
          {String(meta.region)}
        </Badge>
      );
    }
  }

  // Affiliate payout = money the house paid to the affiliate → house
  // loss → rose per CLAUDE.md.
  if (meta.amount != null && event.eventType === "affiliate_payout_processed") {
    details.push(
      <span
        key="payout-amount"
        className="text-xs font-medium text-rose-600 dark:text-rose-400"
      >
        ${Number(meta.amount).toFixed(2)}
      </span>
    );
  }

  // Feature lock toggle
  if (meta.feature) {
    details.push(
      <Badge key="feature" variant="outline" className="text-xs">
        {String(meta.feature).replace(/_/g, " ")}
      </Badge>
    );
  }

  // Chat message
  if (meta.message_id) {
    details.push(
      <Link
        key="msg"
        href={`/chat?highlight=${meta.message_id}`}
        className="text-blue-400 hover:underline text-xs font-mono"
      >
        Message {String(meta.message_id).slice(0, 8)}...
      </Link>
    );
  }

  // Reason (ban, lock, mute, cancel, fail)
  if (meta.reason) {
    details.push(
      <span key="reason" className="text-xs text-muted-foreground">
        Reason: {String(meta.reason)}
      </span>
    );
  }

  // Note preview
  if (meta.content_preview) {
    details.push(
      <span key="note" className="text-xs text-muted-foreground italic truncate max-w-[200px] inline-block align-bottom">
        &ldquo;{String(meta.content_preview)}&rdquo;
      </span>
    );
  }

  if (details.length === 0) return <span className="text-muted-foreground">—</span>;

  return <div className="flex flex-wrap items-center gap-1.5">{details}</div>;
}

/* ── Audit Events Table ── */
export function AuditEventsTable({
  auditEvents,
  activeEventType,
  activeSearch,
  onPageChange,
  onPerPageChange,
  onEventTypeChange,
  onSearchChange,
}: {
  auditEvents: PaginatedResult<AdminAuditEventItem>;
  activeEventType: string;
  activeSearch: string;
  onPageChange: (page: number) => void;
  onPerPageChange: (perPage: number) => void;
  onEventTypeChange: (value: string) => void;
  onSearchChange: (value: string) => void;
}) {
  const [searchInput, setSearchInput] = useState(activeSearch);
  const hasFilters = activeEventType !== "all" || activeSearch !== "";
  const formatDateTime = useFormatDateTime();

  function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSearchChange(searchInput);
  }

  function clearFilters() {
    setSearchInput("");
    onEventTypeChange("all");
    onSearchChange("");
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Audit Events</h2>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Rows per page</span>
          <Select
            value={String(auditEvents.perPage)}
            onValueChange={(v) => onPerPageChange(Number(v))}
          >
            <SelectTrigger className="h-8 w-[70px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[10, 20, 50, 100].map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="flex flex-wrap items-start gap-3">
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Event Type</Label>
          <Select value={activeEventType} onValueChange={(v) => v && onEventTypeChange(v)}>
            <SelectTrigger className="h-9 w-[220px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All events</SelectItem>
              {Object.entries(EVENT_TYPE_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Target User</Label>
          <form onSubmit={handleSearchSubmit} className="flex items-center gap-1">
            <div className="relative">
              <Input
                className="h-9 w-[280px] text-xs pr-8"
                placeholder="Username or user ID..."
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
              />
              <button type="submit" className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                <Search className="size-3" />
              </button>
            </div>
          </form>
        </div>
        {hasFilters && (
          <Button variant="ghost" size="sm" className="h-8 mt-5" onClick={clearFilters}>
            <X className="size-3" />
          </Button>
        )}
      </div>
      {/* Mobile card list (<lg) */}
      <div className="lg:hidden">
        {auditEvents.data.length === 0 ? (
          <div className="rounded-md border">
            <EmptyState
              icon={ScrollText}
              title="No audit events"
              description="Actions taken by or against this admin appear here."
              compact
            />
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border">
            {auditEvents.data.map((e) => (
              <div
                key={e.id}
                className="border-b border-border/60 last:border-b-0 px-3 py-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <Badge
                    variant="outline"
                    className={`text-[10px] h-5 px-1.5 ${EVENT_TYPE_COLORS[e.eventType] ?? "bg-muted text-muted-foreground border-border"}`}
                  >
                    {EVENT_TYPE_LABELS[e.eventType] ?? e.eventType}
                  </Badge>
                  <span
                    suppressHydrationWarning
                    className="text-[10px] text-muted-foreground whitespace-nowrap"
                  >
                    {formatDateTime(e.createdAt)}
                  </span>
                </div>
                {e.targetUserId && (
                  <div className="mt-1 text-xs">
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground mr-2">
                      Target:
                    </span>
                    <Link
                      href={`/users/${e.targetUserId}`}
                      className="text-blue-400 hover:underline"
                    >
                      {e.targetUsername ?? e.targetUserId.slice(0, 8)}
                    </Link>
                  </div>
                )}
                <div className="mt-2">
                  <EventDetails event={e} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Desktop table (>=lg) */}
      <div className="hidden rounded-md border overflow-x-auto lg:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Event</TableHead>
              <TableHead>Target User</TableHead>
              <TableHead>Details</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {auditEvents.data.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={4} className="p-0">
                  <EmptyState
                    icon={ScrollText}
                    title="No audit events"
                    description="Actions taken by or against this admin appear here."
                    compact
                  />
                </TableCell>
              </TableRow>
            )}
            {auditEvents.data.map((e) => (
              <TableRow key={e.id}>
                <TableCell className="text-sm whitespace-nowrap">
                  {/* suppressHydrationWarning on the inner span (not the cell):
                      first-visit SSR(UTC) vs client browser-TZ. See
                      users/columns.tsx RegisteredCell. */}
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
                  {e.targetUserId ? (
                    <Link
                      href={`/users/${e.targetUserId}`}
                      className="text-blue-400 hover:underline"
                    >
                      {e.targetUsername ?? e.targetUserId.slice(0, 8)}
                    </Link>
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell className="text-sm">
                  <EventDetails event={e} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm text-muted-foreground">
          {auditEvents.total} total event{auditEvents.total !== 1 ? "s" : ""}
        </span>
        <Pagination
          page={auditEvents.page}
          totalPages={auditEvents.totalPages}
          onPageChange={onPageChange}
        />
      </div>
    </>
  );
}

/* ── Pagination ── */
export function Pagination({
  page,
  totalPages,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}) {
  return (
    <div className="flex items-center justify-center gap-2">
      <Button
        variant="outline"
        size="icon"
        className="size-8"
        disabled={page <= 1}
        onClick={() => onPageChange(page - 1)}
      >
        <ChevronLeft className="size-4" />
      </Button>
      <span className="text-sm text-muted-foreground">
        Page {page} of {totalPages}
      </span>
      <Button
        variant="outline"
        size="icon"
        className="size-8"
        disabled={page >= totalPages}
        onClick={() => onPageChange(page + 1)}
      >
        <ChevronRight className="size-4" />
      </Button>
    </div>
  );
}
