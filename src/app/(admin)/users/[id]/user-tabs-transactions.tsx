"use client";

import React, { useEffect, useState, useTransition } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { toast } from "sonner";
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Dices,
  ExternalLink,
  KeyRound,
  Loader2,
  Receipt,
  RefreshCw,
  Target,
  TrendingDown,
  Trophy,
  X,
} from "lucide-react";
import { revealBattlePassword } from "@/lib/actions/battle-password";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { STATUS_COLORS } from "@/lib/constants";
import { cn } from "@/lib/utils";
import {
  formatCurrency,
  formatDateTime,
  formatRelative,
} from "@/lib/utils/format";
import {
  formatUpgraderMultiplier,
  formatUpgraderWinChanceLabel,
} from "@/lib/utils/upgrader-metadata";
import {
  amountColorFor,
  balanceMovementSign,
  ledgerDirection,
} from "@/lib/utils/ledger-direction";
import { ledgerTypeLabel } from "@/lib/utils/ledger-labels";
import { BorrowBadge } from "@/components/borrow-badge";
import { EmptyState } from "@/components/empty-state";
import { InlineError } from "@/components/entity-surface/inline-error";
import { battleUrl } from "@/lib/utils/main-site";
import { fetchUserTransactions } from "./actions";
import type { WagerRequirementSummary } from "@/lib/queries/users-wager-progress-shared";
import type {
  Transaction,
  PaginatedTransactions,
} from "./user-tabs-types";

// The transaction detail modal is heavy (Dialog primitives + provably-fair
// game-session viewer + a large metadata-label map) and only mounts when an
// admin clicks a row, so it's lazy-loaded to keep it out of the table's
// critical bundle. ssr:false is safe — the modal never renders on first
// paint (it's gated on a selected transaction).
const TransactionDetailModal = dynamic(
  () =>
    import("./transaction-detail-modal").then((m) => m.TransactionDetailModal),
  { ssr: false },
);

const BalanceAdjustmentEditDialog = dynamic(
  () =>
    import("./balance-adjustment-edit-dialog").then(
      (m) => m.BalanceAdjustmentEditDialog,
    ),
  { ssr: false },
);

const TX_STATUSES = ["all", "pending", "completed", "failed"] as const;

/**
 * Pull a useful display string out of a ledger row's `metadata` blob
 * without parsing every possible shape. Each lookup tries a small list
 * of plausible keys (different backend events spell things differently —
 * `unlock_at` vs `unlockAt`, `hours` vs `lock_hours` …) and returns the
 * first plausible non-empty string. Returning null is the signal to skip
 * the chip entirely so we never render an empty badge.
 */
function metaString(
  meta: unknown,
  keys: readonly string[],
): string | null {
  if (!meta || typeof meta !== "object") return null;
  const obj = meta as Record<string, unknown>;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim() !== "") return v;
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

function metaNumber(meta: unknown, keys: readonly string[]): number | null {
  if (!meta || typeof meta !== "object") return null;
  const obj = meta as Record<string, unknown>;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "") {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

/** Truncate a long hex/blockchain identifier to `0xabcd…wxyz` shape. */
function shortenAddress(s: string, head = 6, tail = 4): string {
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

/**
 * Inline "address / tx hash" chip rendered under the Description on
 * crypto-bearing rows (deposits, crypto-balance withdrawals,
 * card-shipping withdrawals, fireblocks-routed events). Shows ONE chip per
 * useful identifier so the operator can spot the chain + address /
 * transaction without opening the modal — same identifiers the modal
 * already surfaces, just shorter and inline. Click-to-copy keeps the
 * full string usable (the truncated form would be useless when copied).
 *
 * House-POV color is NOT applied here — these chips are neutral
 * identifiers, not money values. The Amount column carries the money
 * signal.
 */
function AddressChip({
  label,
  value,
  full,
}: {
  label: string;
  value: string;
  /** Full string to write to the clipboard on click; defaults to `value`. */
  full?: string;
}) {
  const fullStr = full ?? value;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        if (typeof navigator !== "undefined" && navigator.clipboard) {
          navigator.clipboard.writeText(fullStr).then(
            () => toast.success(`${label} copied`),
            () => toast.error(`Couldn't copy ${label}`),
          );
        }
      }}
      title={`${label} — click to copy ${fullStr}`}
      className="inline-flex items-center gap-1 rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <span className="text-[9px] font-semibold uppercase tracking-wider opacity-70">
        {label}
      </span>
      <span className="truncate">{value}</span>
    </button>
  );
}

/**
 * Format an absolute `unlock_at` timestamp as a compact "in 23h"-style
 * remaining-time string. Past timestamps read "unlocked" — the vault has
 * already become spendable but the ledger row stays around for history.
 * Returns null on unparseable input so the chip can safely skip.
 */
function formatUnlockIn(iso: string): string | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const diffMs = t - Date.now();
  if (diffMs <= 0) return "unlocked";
  const sec = Math.floor(diffMs / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);
  if (day >= 1) return `in ${day}d ${hr % 24}h`;
  if (hr >= 1) return `in ${hr}h ${min % 60}m`;
  if (min >= 1) return `in ${min}m`;
  return "in <1m";
}

// Merged "P&L / Won" cell for the Gaming tab. Shows ONE number to read:
//   main (large) = House Profit, house-POV color (house gain → emerald,
//   house loss → rose, flat → muted) with its +/- sign;
//   small muted = the total Won Value, inline directly behind it.
// `profitColor` is an optional override for the rare cases where the win
// is real but the won amount isn't traceable (we still want the house-loss
// rose without deriving a profit number). `extra` carries inline badges
// (e.g. upgrader realized/target multiplier, "Lost" chip) that used to sit
// next to the Won Value, kept here so no signal is dropped.
function MergedPnlCell({
  profit,
  won,
  wonLabel,
  profitColor,
  extra,
}: {
  profit?: number | null;
  won?: number | null;
  wonLabel?: React.ReactNode;
  profitColor?: string;
  extra?: React.ReactNode;
}) {
  const profitClass =
    profitColor ??
    (profit != null && profit > 0
      ? "text-emerald-600 dark:text-emerald-400"
      : profit != null && profit < 0
        ? "text-rose-600 dark:text-rose-400"
        : "text-muted-foreground");
  // Only surface the small Won Value when the user actually won something.
  // A $0.00 won (house win where the player took nothing — coerced safely
  // since `won` may be a Decimal/string/number, and null/undefined/0 all
  // count as "nothing won") shows ONLY the main House Profit number, with
  // nothing muted behind it.
  const showWon = won != null && Number(won) > 0;
  return (
    <TableCell className="tabular-nums">
      <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
        <span className={`text-sm font-medium ${profitClass}`}>
          {wonLabel ??
            (profit != null
              ? `${profit > 0 ? "+" : ""}${formatCurrency(profit)}`
              : "—")}
        </span>
        {(showWon || extra) && (
          <span className="text-[11px] text-muted-foreground">
            {showWon ? formatCurrency(won) : null}
          </span>
        )}
        {extra}
      </div>
    </TableCell>
  );
}

export const CategoryTransactionsTable = React.memo(
  function CategoryTransactionsTable({
    title,
    userId,
    types,
    initialTx,
    initialLoadError = null,
    showCardsValue = false,
    isAdmin = false,
    canEditBalanceAdjustments = false,
    wagerRequirement = null,
    groups = null,
  }: {
    title: string;
    userId: string;
    types: readonly string[];
    initialTx: PaginatedTransactions;
    /**
     * Error string from the server-side safeQuery that produced
     * `initialTx` (null on success). When set, `initialTx` is the empty
     * fallback page — so the table body shows a VISIBLE InlineError
     * instead of the misleading "No transactions" empty state (error ≠
     * empty, always distinguishable). Cleared by any successful client
     * `load()` or by a recovered server re-seed.
     */
    initialLoadError?: string | null;
    showCardsValue?: boolean;
    /**
     * Gates the admin-only "reveal + copy + open Watch URL with
     * password" affordance on private-battle rows. Defaults to false so
     * non-gaming tables (which never render the Watch button anyway)
     * and non-admin viewers (support/marketing/creator) get the plain
     * static link.
     */
    isAdmin?: boolean;
    /** Motha-only — opens the balance-adjustment edit dialog on ID click. */
    canEditBalanceAdjustments?: boolean;
    /**
     * Account-level withdrawal wager-requirement status (filled vs required
     * + %). Surfaced inside the transaction-detail popup on the Deposits &
     * Withdrawals table so an operator sees how far the user is from being
     * able to cash out. Plain serializable object — null on the Gaming table
     * (not passed) and when the connected DB lacks the sweepstakes columns.
     */
    wagerRequirement?: WagerRequirementSummary | null;
    /**
     * Optional high-level segmented filter rendered above the Type dropdown
     * (e.g. All / Deposits / Withdrawals on the Deposits & Withdrawals
     * table). Each group carries a subset of `types`; selecting one narrows
     * BOTH the server query (only that subset is requested) AND the Type
     * dropdown (only that subset is listed). The first entry is treated as
     * the "all" group and must carry the full `types` set. Serializable
     * plain data — no function props across the RSC boundary. null → the
     * segmented control isn't rendered (every non-financial table).
     */
    groups?: readonly { key: string; label: string; types: readonly string[] }[] | null;
  }) {
    const [txData, setTxData] = useState(initialTx);
    const [loadError, setLoadError] = useState<string | null>(
      initialLoadError ?? null,
    );
    const [typeFilter, setTypeFilter] = useState("all");
    const [statusFilter, setStatusFilter] = useState("all");
    const [dateFrom, setDateFrom] = useState("");
    const [dateTo, setDateTo] = useState("");
    const [selectedTx, setSelectedTx] = useState<Transaction | null>(null);
    const [editAdjustmentTx, setEditAdjustmentTx] =
      useState<Transaction | null>(null);
    const [editDialogOpen, setEditDialogOpen] = useState(false);
    const [isPending, startTransition] = useTransition();
    const [currentPerPage, setCurrentPerPage] = useState(initialTx.perPage);
    // High-level group filter (All / Deposits / Withdrawals …). Defaults to
    // the first group (the "all" group). null `groups` → control not rendered.
    const [groupKey, setGroupKey] = useState<string>(groups?.[0]?.key ?? "all");
    // The types this table currently scopes to: the active group's subset
    // when a non-default group is picked, otherwise the full `types`. Used
    // for BOTH the server query (when no single type is chosen) and to scope
    // the Type dropdown's option list.
    const activeGroup = groups?.find((g) => g.key === groupKey) ?? null;
    const isDefaultGroup = !activeGroup || activeGroup.key === groups?.[0]?.key;
    const baseTypes: readonly string[] =
      activeGroup && !isDefaultGroup ? activeGroup.types : types;

    // The parent /users/[id] page re-renders every 60s via AutoRefresh.
    // Each re-render produces a fresh `initialTx` from the server. If
    // the admin hasn't applied a filter and is on page 1, re-seed the
    // local table state so new gaming/financial events show up without
    // a manual reload. Filters/pagination keep their state — the
    // admin's view isn't yanked back to defaults mid-investigation.
    //
    // CRITICAL: the server always hands `initialTx` at the DEFAULT page
    // size (10). If the admin switched the rows-per-page selector to a
    // larger size, blindly re-seeding with `initialTx` would snap the
    // table back to 10 rows (the selector still reading "20"/"50") — the
    // reported "I picked 20 but only 10 show" bug. So we only direct-seed
    // when the chosen page size still matches the server default; if the
    // admin enlarged it, we re-fetch page 1 at THEIR size instead, which
    // both respects their choice and still surfaces new events.
    const filtersUnchanged =
      typeFilter === "all" &&
      statusFilter === "all" &&
      isDefaultGroup &&
      !dateFrom &&
      !dateTo &&
      txData.page === 1;
    useEffect(() => {
      if (!filtersUnchanged) return;
      if (currentPerPage === initialTx.perPage) {
        // Default page size → the fresh server payload already matches the
        // admin's view; seed it directly (no extra round-trip). The error
        // flag tracks the payload: a recovered refresh clears it, a still-
        // degraded one re-raises it.
        setTxData(initialTx);
        setLoadError(initialLoadError ?? null);
      } else {
        // Admin enlarged the page size → re-fetch page 1 at their size so
        // the refresh keeps the larger view instead of reverting to 10.
        load(1);
      }
      // We deliberately depend ONLY on `initialTx` — we re-seed when the
      // server hands us a NEW payload, NOT when the admin toggles a filter
      // back to "all" or changes the page size (those have their own
      // explicit `load(...)` calls).
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [initialTx]);

    function buildFilters(overrides?: {
      type?: string;
      status?: string;
      from?: string;
      to?: string;
      // Group changes reset typeFilter to "all" in the same tick that
      // setGroupKey runs, so `baseTypes` (derived from state) is stale here.
      // The handler passes the new scope explicitly to avoid a wrong query.
      baseTypes?: readonly string[];
    }) {
      const tf = overrides?.type ?? typeFilter;
      const sf = overrides?.status ?? statusFilter;
      const df = overrides?.from ?? dateFrom;
      const dt = overrides?.to ?? dateTo;
      const bt = overrides?.baseTypes ?? baseTypes;
      return {
        type: tf !== "all" ? tf : undefined,
        types: tf === "all" ? [...bt] : undefined,
        status: sf !== "all" ? sf : undefined,
        dateFrom: df || undefined,
        dateTo: dt || undefined,
      };
    }

    function load(
      newPage: number,
      newPerPage?: number,
      filterOverrides?: {
        type?: string;
        status?: string;
        from?: string;
        to?: string;
        baseTypes?: readonly string[];
      },
    ) {
      const pp = newPerPage ?? currentPerPage;
      if (newPerPage) setCurrentPerPage(newPerPage);
      startTransition(async () => {
        try {
          const result = await fetchUserTransactions(
            userId,
            newPage,
            pp,
            buildFilters(filterOverrides),
          );
          setTxData(result);
          setLoadError(null);
        } catch {
          // A rejected await inside startTransition escalates to the
          // segment error boundary and replaces the WHOLE page with
          // error.tsx — exactly the failure mode this remake kills. Keep
          // the previous rows on screen and surface a toast instead.
          toast.error("Couldn't load transactions — try again");
        }
      });
    }

    function handleTypeChange(value: string) {
      setTypeFilter(value);
      load(1, undefined, { type: value });
    }

    function handleGroupChange(key: string) {
      if (!groups || key === groupKey) return;
      const next = groups.find((g) => g.key === key) ?? null;
      const isDefault = !next || next.key === groups[0]?.key;
      const nextBaseTypes = next && !isDefault ? next.types : types;
      setGroupKey(key);
      // Switching the high-level group resets the fine-grained Type dropdown
      // back to "all" (the previously-selected type may not exist in the new
      // group) and re-queries the server scoped to the new group's subset.
      setTypeFilter("all");
      load(1, undefined, { type: "all", baseTypes: nextBaseTypes });
    }

    function handleStatusChange(value: string) {
      setStatusFilter(value);
      load(1, undefined, { status: value });
    }

    function handleFromChange(value: string) {
      setDateFrom(value);
      load(1, undefined, { from: value });
    }

    function handleToChange(value: string) {
      setDateTo(value);
      load(1, undefined, { to: value });
    }

    // Manual refresh — re-fetches the CURRENT page with the CURRENT filters
    // via the uncached `fetchUserTransactions` server action (NOT the
    // page-level cached read), so the click pulls the freshest rows
    // immediately instead of a cache-warmed snapshot. Preserves the admin's
    // page position and filters.
    function handleRefresh() {
      load(txData.page);
    }

    const hasFilters =
      typeFilter !== "all" ||
      statusFilter !== "all" ||
      !isDefaultGroup ||
      dateFrom ||
      dateTo;

    function clearFilters() {
      setTypeFilter("all");
      setStatusFilter("all");
      setDateFrom("");
      setDateTo("");
      const defaultKey = groups?.[0]?.key ?? "all";
      setGroupKey(defaultKey);
      load(1, undefined, {
        type: "all",
        status: "all",
        from: "",
        to: "",
        baseTypes: types,
      });
    }

    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">{title}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-start gap-3">
            {groups && groups.length > 1 && (
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Show</Label>
                <div className="inline-flex h-8 items-center gap-1 rounded-md border bg-muted/40 p-0.5">
                  {groups.map((g) => {
                    const active = g.key === groupKey;
                    return (
                      <Button
                        key={g.key}
                        type="button"
                        variant={active ? "secondary" : "ghost"}
                        size="sm"
                        aria-pressed={active}
                        className={cn(
                          "h-7 px-2.5 text-xs font-medium",
                          active
                            ? "shadow-sm"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                        onClick={() => handleGroupChange(g.key)}
                      >
                        {g.label}
                      </Button>
                    );
                  })}
                </div>
              </div>
            )}
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Type</Label>
              <Select
                value={typeFilter}
                onValueChange={(v) => v && handleTypeChange(v)}
              >
                <SelectTrigger className="h-8 w-[200px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All types</SelectItem>
                  {baseTypes.map((t) => (
                    <SelectItem key={t} value={t}>
                      {ledgerTypeLabel(t)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Status</Label>
              <Select
                value={statusFilter}
                onValueChange={(v) => v && handleStatusChange(v)}
              >
                <SelectTrigger className="h-8 w-[130px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TX_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s === "all" ? "All statuses" : s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">From</Label>
              <Input
                type="date"
                className="h-8 w-[150px]"
                value={dateFrom}
                onChange={(e) => handleFromChange(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">To</Label>
              <Input
                type="date"
                className="h-8 w-[150px]"
                value={dateTo}
                onChange={(e) => handleToChange(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">&nbsp;</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8"
                onClick={handleRefresh}
                disabled={isPending}
                title="Refresh — fetch the latest transactions now"
              >
                <RefreshCw
                  className={cn("size-3.5", isPending && "animate-spin")}
                />
                Refresh
              </Button>
            </div>
            {hasFilters && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8"
                onClick={clearFilters}
              >
                <X className="size-3" />
              </Button>
            )}
            {isPending && (
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            )}
          </div>
          {/* Wide multi-column transaction table — let it horizontal-scroll
              inside the card on phone instead of forcing the page to scroll.
              `no-scrollbar` (globals.css) hides the track/thumb while wheel /
              trackpad / drag-scroll keep working — this is the one scroll
              container inside every CategoryTransactionsTable instance (Deposits
              & Withdrawals, Gaming, Card Sales, Battle Vouchers, Admin
              Adjustments all share this component). */}
          <div className="overflow-x-auto -mx-6 px-6 sm:mx-0 sm:px-0 no-scrollbar">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>ID</TableHead>
                {showCardsValue && <TableHead>Battle</TableHead>}
                <TableHead>Type</TableHead>
                <TableHead>Amount</TableHead>
                {showCardsValue && <TableHead>P&amp;L / Won</TableHead>}
                <TableHead>Worth Before</TableHead>
                <TableHead>Worth After</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {txData.data.map((t) => {
                // Synthetic post-battle DOUBLE-DOWN row — its own dedicated
                // row (injected chronologically between the battle bet and the
                // next event by getUserTransactions). It has no ledger row, so
                // it renders a compact, self-contained row rather than going
                // through the ledger-oriented cell logic below. House-POV:
                //   • dd LOST → winnings forfeited → HOUSE WIN → emerald
                //   • dd WON  → house paid the doubled winnings → HOUSE LOSS → rose
                if (t.syntheticKind === "double_down") {
                  const isWin = t.doubleDownResult === "win";
                  const amount = t.doubleDownAmount ?? 0;
                  return (
                    <TableRow key={t.id} className="bg-muted/20">
                      <TableCell>
                        {/* Clickable ID → opens the transaction-detail modal,
                            same as every real row. The synthetic dd row is NOT
                            an admin_balance_adjustment, so it never routes to
                            the edit dialog — just setSelectedTx(t). */}
                        <button
                          onClick={() => setSelectedTx(t)}
                          className="font-mono text-xs text-blue-400 hover:underline"
                          title="View transaction details"
                        >
                          <Dices className="mr-1 inline size-3.5" />
                          {t.id.slice(0, 8)}...
                        </button>
                      </TableCell>
                      {showCardsValue && (
                        <TableCell>
                          {/* Same battle "watch live" link the real battle_bet
                              row shows, so the double-down leg ties back to its
                              battle. Nested clickable — no stopPropagation
                              needed here since the row itself has no onClick
                              (only the ID button opens the modal). */}
                          {t.battleId ? (
                            <WatchButton
                              battleId={t.battleId}
                              hasPassword={t.hasPassword === true && isAdmin}
                            />
                          ) : null}
                        </TableCell>
                      )}
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge
                            variant="outline"
                            className="gap-1 text-xs"
                            title="Post-battle double-or-nothing on the battle winnings"
                          >
                            <Dices className="size-3" />
                            Double Down
                          </Badge>
                          <span
                            className={cn(
                              "inline-flex items-center rounded border px-1.5 py-0 text-[10px] font-medium",
                              isWin
                                ? "border-rose-500/30 bg-rose-500/15 text-rose-600 dark:text-rose-400"
                                : "border-emerald-500/30 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
                            )}
                          >
                            {isWin ? "Won" : "Lost"}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {formatCurrency(amount)}
                      </TableCell>
                      {showCardsValue && (
                        // House P&L: LOSE → +stake (house gain, emerald);
                        // WIN → −payout (house loss, rose). `won` mirrors the
                        // money the user walked away with on a win.
                        <MergedPnlCell
                          profit={isWin ? -amount : amount}
                          won={isWin ? amount : 0}
                        />
                      )}
                      <TableCell className="text-muted-foreground tabular-nums">
                        —
                      </TableCell>
                      <TableCell className="tabular-nums text-muted-foreground">
                        —
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={STATUS_COLORS[t.status] ?? ""}
                        >
                          {t.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="max-w-[280px] text-xs text-muted-foreground">
                        <span className="truncate block">{t.description}</span>
                      </TableCell>
                      <TableCell
                        className="whitespace-nowrap text-xs"
                        title={formatRelative(t.createdAt)}
                      >
                        <div className="flex flex-col gap-0.5">
                          <span className="font-medium tabular-nums text-foreground">
                            {formatDateTime(t.createdAt)}
                          </span>
                          <span className="text-[10px] text-muted-foreground">
                            {formatRelative(t.createdAt)}
                          </span>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                }
                return (
                <TableRow key={t.id}>
                  <TableCell>
                    <button
                      onClick={() => {
                        if (
                          canEditBalanceAdjustments &&
                          t.type === "admin_balance_adjustment"
                        ) {
                          setEditAdjustmentTx(t);
                          setEditDialogOpen(true);
                          return;
                        }
                        setSelectedTx(t);
                      }}
                      className="font-mono text-xs text-blue-400 hover:underline"
                      title={
                        canEditBalanceAdjustments &&
                        t.type === "admin_balance_adjustment"
                          ? "Edit balance adjustment"
                          : "View transaction details"
                      }
                    >
                      {t.id.slice(0, 8)}...
                    </button>
                  </TableCell>
                  {/* Dedicated "watch live" button — gaming tab. Opens
                      packy.gg/games/battles/<id> in a new tab. Shown on the battle bet
                      row AND on the battle_excess_to_voucher row (the voucher
                      leg of that same battle win), so the voucher leg ties back
                      to its battle just like the bet does. Empty cell on other
                      gaming rows keeps the column aligned. Private battles +
                      admin viewer: WatchButton reveals the password on click,
                      copies the URL with ?password=<pw>, and opens the live
                      battle URL. */}
                  {showCardsValue && (
                    <TableCell>
                      {(t.type === "battle_bet" ||
                        t.type === "battle_excess_to_voucher") &&
                      t.battleId ? (
                        <WatchButton
                          battleId={t.battleId}
                          hasPassword={t.hasPassword === true && isAdmin}
                        />
                      ) : null}
                    </TableCell>
                  )}
                  <TableCell>
                    <div className="flex flex-col items-start gap-0.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge
                          variant="outline"
                          className="text-xs"
                          title={t.type}
                        >
                          {t.type === "challenge_prize" && (
                            <Target className="mr-1 size-3 text-rose-500" />
                          )}
                          {/* Instant (early-claimed) rakeback reads as
                              "Instant rakeback"; a normal claim stays
                              "Rakeback claim". The signal
                              (rakeback_claims.last_preclaim_at) is joined
                              server-side onto the ledger row. */}
                          {t.type === "rakeback_claim"
                            ? t.isInstantRakeback === true
                              ? "Instant rakeback"
                              : "Rakeback"
                            : ledgerTypeLabel(t.type)}
                        </Badge>
                        {t.type === "upgrader_bet" &&
                          t.upgraderTargetMultiplier != null && (
                            <span
                              className="inline-flex items-center rounded border border-cyan-500/30 bg-cyan-500/15 px-1.5 py-0 text-[10px] font-medium text-cyan-600 dark:text-cyan-400"
                              title="Target multiplier the user picked before the spin"
                            >
                              ⇡{" "}
                              {formatUpgraderMultiplier(
                                t.upgraderTargetMultiplier,
                              )}
                            </span>
                          )}
                        {t.type === "upgrader_bet" &&
                          t.upgraderTargetChance != null &&
                          (() => {
                            const chanceLabel = formatUpgraderWinChanceLabel(
                              t.upgraderTargetChance,
                              t.upgraderTargetChanceDerived === true,
                            );
                            if (!chanceLabel) return null;
                            return (
                              <span
                                className={
                                  chanceLabel.aboveProductCap
                                    ? "text-[10px] text-amber-600 dark:text-amber-400"
                                    : "text-[10px] text-muted-foreground"
                                }
                                title={chanceLabel.title}
                              >
                                {chanceLabel.text}
                              </span>
                            );
                          })()}
                        {/* Borrow signal sits INLINE next to the type chip
                            (same row), so the "Battle bet" label and its
                            borrow-mode % read side by side. wrap-safe via the
                            flex-wrap parent. Renders nothing for non-borrowed
                            events. */}
                        <BorrowBadge
                          percent={t.borrowPercentage}
                          amountUsd={t.borrowedAmountUsd}
                          size="sm"
                        />
                      </div>
                      {/* Battle-win voucher leg — name it as part of the win,
                          not a standalone mystery line. The voucher is the
                          leftover when the win couldn't be paid as an exact
                          card (voucher == card per house rules), so it reads
                          alongside the cash leg (battle_refund) and the kept
                          cards as one win. */}
                      {t.type === "battle_excess_to_voucher" && (
                        <span className="text-[10px] text-muted-foreground">
                          Part of a battle win (voucher leg)
                        </span>
                      )}
                      {/* Sponsorship signal — flags battle rows where the
                          creator fronted the entry (others join free).
                          100% = fully sponsored. Null/0 on everything
                          else. */}
                      {t.sponsorshipPercentage != null &&
                        t.sponsorshipPercentage > 0 && (
                          <Badge
                            variant="outline"
                            className="border-violet-500/30 bg-violet-500/15 text-[10px] font-medium text-violet-600 dark:text-violet-400"
                          >
                            {t.sponsorshipPercentage >= 100
                              ? "Fully sponsored"
                              : `Sponsored ${t.sponsorshipPercentage}%`}
                          </Badge>
                        )}
                    </div>
                  </TableCell>
                  {showCardsValue ? (
                    // Gaming tab: Amount is the raw stake/wager, not a
                    // P&L. Keep it neutral so only the House Profit
                    // column carries the green/red signal.
                    <TableCell className="tabular-nums">
                      {formatCurrency(t.amount)}
                    </TableCell>
                  ) : (
                    (() => {
                      // Finances / overview: Amount IS the signal. COLOR is
                      // house-POV (classified by ledger type, matching every
                      // other tx surface — a rakeback claim is a house loss →
                      // rose). The SIGN follows the user's real balance
                      // movement so it never contradicts the Before/After
                      // columns to the right (a credit reads "+", a debit "−").
                      // abs-guard the magnitude against the rare genuinely-
                      // signed row (admin_balance_adjustment).
                      const dir = ledgerDirection(t.type);
                      return (
                        <TableCell className={amountColorFor(dir)}>
                          {balanceMovementSign(t.balanceBefore, t.balanceAfter)}
                          {formatCurrency(Math.abs(t.amount))}
                        </TableCell>
                      );
                    })()
                  )}
                  {showCardsValue &&
                    (() => {
                      // Sponsorship funds someone else's play — the house
                      // simply takes the amount in (shown in Amount). We
                      // don't derive a win/loss P&L for it.
                      if (t.type === "battle_sponsorship") {
                        // House takes the amount in, no won value paid out.
                        return <MergedPnlCell profit={t.amount} won={null} />;
                      }
                      if (t.type === "battle_bet") {
                        // The post-battle double-down (double-or-nothing on the
                        // winnings) is surfaced as its OWN dedicated row, injected
                        // chronologically just above this battle_bet — see the
                        // synthetic-row branch at the top of this map. It is no
                        // longer shown as a badge on this row.
                        //
                        // Win/loss is the battle outcome (winner_team vs
                        // team_number), surfaced as gameResult. null = the
                        // battle hasn't resolved yet.
                        if (t.gameResult === null) {
                          // Battle not settled. While PENDING we can still
                          // show the win/loss DIRECTION (winner_team vs the
                          // user's team) even though the exact dollar amount
                          // is not derivable yet and stays "resolving".
                          // House-POV: user win = rose (our loss), user loss
                          // = emerald (our gain).
                          if (t.battleOutcomePending === "win") {
                            return (
                              <TableCell>
                                <div className="flex items-center gap-1.5">
                                  <Badge
                                    variant="outline"
                                    className="gap-1 border-rose-500/30 bg-rose-500/15 text-[10px] font-medium text-rose-600 dark:text-rose-400"
                                  >
                                    <Trophy className="size-3" />
                                    Winning
                                  </Badge>
                                  <span className="text-[11px] italic text-muted-foreground">
                                    amount resolving…
                                  </span>
                                </div>
                              </TableCell>
                            );
                          }
                          if (t.battleOutcomePending === "loss") {
                            return (
                              <TableCell>
                                <div className="flex items-center gap-1.5">
                                  <Badge
                                    variant="outline"
                                    className="gap-1 border-emerald-500/30 bg-emerald-500/15 text-[10px] font-medium text-emerald-600 dark:text-emerald-400"
                                  >
                                    <TrendingDown className="size-3" />
                                    Losing
                                  </Badge>
                                  <span className="text-[11px] italic text-muted-foreground">
                                    amount resolving…
                                  </span>
                                </div>
                              </TableCell>
                            );
                          }
                          // winner_team not materialized yet (in_progress)
                          // → no fabricated direction.
                          return (
                            <TableCell className="text-xs italic text-muted-foreground">
                              Pending — battle still resolving
                            </TableCell>
                          );
                        }
                        if (t.gameResult === "lose") {
                          // LOSS: player won nothing → house keeps the
                          // full bet. Won Value = $0, House Profit = +bet
                          // (house gain = emerald).
                          return (
                            <MergedPnlCell profit={t.amount} won={0} />
                          );
                        }
                        // WIN: winnings = the cards the player actually took
                        // from the battle (their battle-sourced inventory).
                        if (
                          t.battleWinnings == null ||
                          t.battleWinnings <= 0
                        ) {
                          // Won, but no traceable kept cards — show the
                          // truthful outcome (house loss = rose) rather than a
                          // misleading +bet, with no won number behind it.
                          return (
                            <MergedPnlCell
                              wonLabel="Player won"
                              profitColor="text-rose-600 dark:text-rose-400"
                            />
                          );
                        }
                        // House P&L on the battle = bet we took in minus the
                        // winnings we paid out. Negative = house lost (rose),
                        // positive = house won (emerald) — already house-POV.
                        // What happened to those winnings afterward (the
                        // double-down) is its OWN row above this one now.
                        return (
                          <MergedPnlCell
                            profit={t.amount - t.battleWinnings}
                            won={t.battleWinnings}
                          />
                        );
                      }
                      // Upgrader: win/loss + winnings sourced from
                      // upgrader_games (the canonical record — see
                      // users-transactions.ts notes). Win = won_amount
                      // > 0, loss = won_amount = 0. House Profit = bet
                      // − won. Wins also surface the realized
                      // multiplier (won / bet) as an inline badge so
                      // admins can spot fat-multiplier hits (5×, 100×,
                      // 1k×) at a glance.
                      if (t.type === "upgrader_bet") {
                        // Configuration the user picked before the spin
                        // (target multiplier + win-chance %). Both come
                        // from `provably_fair_results.result_metadata`
                        // via `parseUpgraderMetadata` — see the query
                        // file for details. Either can be null when
                        // the backend didn't store it; the chip / sub-
                        // line just skips in that case.
                        const targetMultiplier = t.upgraderTargetMultiplier;
                        const targetBadge =
                          targetMultiplier != null ? (
                            <span
                              className="ml-1.5 inline-flex items-center rounded border border-cyan-500/30 bg-cyan-500/15 px-1.5 py-0 text-[10px] font-medium text-cyan-600 dark:text-cyan-400"
                              title="Target multiplier the user picked before the spin"
                            >
                              ⇡ {formatUpgraderMultiplier(targetMultiplier)}
                            </span>
                          ) : null;

                        if (t.upgraderResult === "lose") {
                          // LOSS: bet kept by the house. Won = $0,
                          // House Profit = +bet (emerald). "Lost" status
                          // chip + target multiplier badge so the row
                          // reads as "user aimed at X×, lost". Win
                          // chance % is shown once in the Type column.
                          return (
                            <MergedPnlCell
                              profit={t.amount}
                              won={0}
                              extra={
                                <>
                                  <span className="inline-flex items-center rounded border border-emerald-500/30 bg-emerald-500/15 px-1.5 py-0 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                                    Lost
                                  </span>
                                  {targetBadge}
                                </>
                              }
                            />
                          );
                        }
                        if (t.upgraderResult === "win" && t.upgraderWinnings != null) {
                          // Realized multiplier — how many times the
                          // bet the user actually took out. Skip the
                          // chip on a zero-stake row (defensive — bet
                          // amount should always be > 0 for upgrader
                          // games, but guard the division regardless).
                          const multiplier =
                            t.amount > 0 ? t.upgraderWinnings / t.amount : null;
                          return (
                            <MergedPnlCell
                              profit={t.amount - t.upgraderWinnings}
                              won={t.upgraderWinnings}
                              extra={
                                multiplier != null ? (
                                  <span
                                    className="inline-flex items-center rounded border border-rose-500/30 bg-rose-500/15 px-1.5 py-0 text-[10px] font-medium text-rose-600 dark:text-rose-400"
                                    title="Realized multiplier (won ÷ bet)"
                                  >
                                    {formatUpgraderMultiplier(multiplier)}
                                  </span>
                                ) : null
                              }
                            />
                          );
                        }
                        // upgraderResult === null → row hasn't been
                        // enriched (defensive — shouldn't happen).
                        return <MergedPnlCell />;
                      }
                      // Gaming is pack/battle only. Item cash-outs (card_sale /
                      // reward_card_sale / voucher_redeemed) live on the
                      // Inventory tab now, so the fallback below only handles
                      // pack_opening (cardsValue present) and the remaining
                      // gaming types where cardsValue is absent — incl.
                      // battle_excess_to_voucher (the voucher leg of a battle
                      // win; its Amount carries the voucher value, while the
                      // win's Won-Value / House-Profit P&L is shown on the
                      // paired battle_bet row, so this leg shows "—" here).
                      const cv = t.cardsValue;
                      // House profit on the session: bet we took in minus
                      // value of cards + vouchers we handed back. Positive =
                      // house win (emerald), negative = user pulled above bet
                      // (rose) — already house-POV, no sign flip. cv == null
                      // (e.g. battle_excess_to_voucher) → no P&L on this leg,
                      // render "—".
                      return cv != null ? (
                        <MergedPnlCell profit={t.amount - cv} won={cv} />
                      ) : (
                        <MergedPnlCell />
                      );
                    })()}
                  {/* Before / After show TOTAL WORTH = cash balance + held
                      inventory worth (cards + vouchers) at that moment, not
                      cash alone. The breakdown (cash + inventory) is in each
                      cell's tooltip, so a separate Inventory column is
                      redundant. Matches the detail modal's Worth rows. */}
                  <TableCell
                    className="text-muted-foreground tabular-nums"
                    title={`Cash ${formatCurrency(t.balanceBefore)} + inventory ${formatCurrency(
                      Math.max(0, t.worthBefore - t.balanceBefore),
                    )}`}
                  >
                    {formatCurrency(t.worthBefore)}
                  </TableCell>
                  <TableCell
                    className="tabular-nums"
                    title={`Cash ${formatCurrency(
                      t.balanceAfter,
                    )} + inventory ${formatCurrency(t.inventoryValue)}`}
                  >
                    {formatCurrency(t.worthAfter)}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={STATUS_COLORS[t.status] ?? ""}
                    >
                      {t.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-[280px] text-xs text-muted-foreground">
                    {t.packName ? (
                      <Link
                        href={`/packs/${t.packId}`}
                        className="text-blue-400 hover:underline truncate block"
                      >
                        {t.packName}
                      </Link>
                    ) : t.soldCard ? (
                      <span className="truncate block">
                        Sold: {t.soldCard.name}
                      </span>
                    ) : t.type === "upgrader_bet" &&
                      t.upgraderTargetMultiplier != null ? (
                      <span className="truncate block">
                        {t.description}
                        <span className="text-cyan-600 dark:text-cyan-400">
                          {" "}
                          · Aimed for{" "}
                          {formatUpgraderMultiplier(t.upgraderTargetMultiplier)}
                        </span>
                      </span>
                    ) : (
                      <span className="truncate block">{t.description}</span>
                    )}
                    {/* Inline metadata chips — surface the most useful crypto /
                        vault identifiers without opening the modal. House-POV
                        coloring is intentionally NOT applied to these chips:
                        they're neutral identifiers, not money values. */}
                    <RowMetadataChips tx={t} />
                  </TableCell>
                  <TableCell
                    className="whitespace-nowrap text-xs"
                    title={formatRelative(t.createdAt)}
                  >
                    {/* Date+time deserves more weight than the muted run-on it
                        used to be — operators scan this column to anchor every
                        event in time. Foreground color + tabular-nums for clean
                        column alignment; the muted relative-time line beneath
                        keeps the "5 minutes ago" affordance without losing the
                        absolute timestamp. */}
                    <div className="flex flex-col gap-0.5">
                      <span className="font-medium tabular-nums text-foreground">
                        {formatDateTime(t.createdAt)}
                      </span>
                      <span className="text-[10px] text-muted-foreground">
                        {formatRelative(t.createdAt)}
                      </span>
                    </div>
                  </TableCell>
                </TableRow>
                );
              })}
              {txData.data.length === 0 && (
                <TableRow className="hover:bg-transparent">
                  <TableCell
                    colSpan={showCardsValue ? 10 : 8}
                    className="p-0"
                  >
                    {loadError ? (
                      // The seeded page came from a FAILED/timed-out query —
                      // showing the normal empty state here would disguise a
                      // broken feed as a quiet account. Visible error + retry
                      // (router.refresh re-runs the server query; a recovered
                      // payload re-seeds and clears the flag).
                      <InlineError
                        compact
                        title="Couldn't load transactions"
                        hint="This is a load failure, not an empty history — retry to re-run the query."
                      />
                    ) : (
                      <EmptyState
                        icon={Receipt}
                        title="No transactions"
                        description="Nothing matches the current filters."
                        compact
                      />
                    )}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          </div>

          <TransactionDetailModal
            transaction={selectedTx}
            userId={userId}
            onClose={() => setSelectedTx(null)}
            isAdmin={isAdmin}
            wagerRequirement={wagerRequirement}
          />
          {canEditBalanceAdjustments && (
            <BalanceAdjustmentEditDialog
              transaction={editAdjustmentTx}
              userId={userId}
              open={editDialogOpen}
              onOpenChange={(next) => {
                setEditDialogOpen(next);
                if (!next) setEditAdjustmentTx(null);
              }}
            />
          )}
          {txData.totalPages > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 py-4">
              <p className="text-sm text-muted-foreground">
                {txData.total} transaction{txData.total !== 1 ? "s" : ""}
              </p>
              <div className="flex flex-wrap items-center gap-3 sm:gap-4">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">Rows</span>
                  <Select
                    value={String(currentPerPage)}
                    onValueChange={(v) => v && load(1, Number(v))}
                  >
                    <SelectTrigger className="h-8 w-[70px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[10, 25, 50, 100].map((n) => (
                        <SelectItem key={n} value={String(n)}>
                          {n}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <span className="text-sm text-muted-foreground">
                  Page {txData.page} of {txData.totalPages}
                </span>
                <div className="flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="icon"
                    className="size-8"
                    onClick={() => load(1)}
                    disabled={txData.page <= 1 || isPending}
                  >
                    <ChevronsLeft className="size-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    className="size-8"
                    onClick={() => load(txData.page - 1)}
                    disabled={txData.page <= 1 || isPending}
                  >
                    <ChevronLeft className="size-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    className="size-8"
                    onClick={() => load(txData.page + 1)}
                    disabled={txData.page >= txData.totalPages || isPending}
                  >
                    <ChevronRight className="size-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    className="size-8"
                    onClick={() => load(txData.totalPages)}
                    disabled={txData.page >= txData.totalPages || isPending}
                  >
                    <ChevronsRight className="size-4" />
                  </Button>
                </div>
              </div>
            </div>
          )}

        </CardContent>
      </Card>
    );
  },
);

/**
 * Watch-live button on the Gaming-tab battle rows. Has two modes:
 *
 *   • Public battle (or non-admin viewer) → plain anchor that opens
 *     packy.gg/games/battles/<id> in a new tab. Same shape and styling as the
 *     historical button so the table layout is unchanged.
 *
 *   • Private battle + admin viewer (hasPassword=true) → click reveals
 *     the password via the existing revealBattlePassword server action
 *     (admin-only, audit-logged on every call), copies the live battle
 *     URL with `?password=<pw>` to the clipboard, then opens the URL in
 *     a new tab. One click = paste-ready URL + open tab — admins don't
 *     have to navigate to /battles/[id] just to grab the password.
 *
 * The plaintext password is fetched on demand and never embedded in the
 * SSR payload (only the `hasPassword` boolean travels with each row).
 */
function WatchButton({
  battleId,
  hasPassword,
}: {
  battleId: string;
  hasPassword: boolean;
}) {
  const [isPending, startTransition] = useTransition();

  const baseUrl = battleUrl(battleId);

  // Public battle (or non-admin viewer) — original Watch behavior:
  // plain external link, identical styling.
  if (!hasPassword) {
    return (
      <a
        href={baseUrl}
        target="_blank"
        rel="noopener noreferrer"
        title="Open the live battle on packy.gg"
        className="inline-flex h-5 items-center gap-1 rounded-md border border-blue-500/30 bg-blue-500/10 px-2 py-0.5 text-[11px] font-medium text-blue-600 transition-colors hover:bg-blue-500/20 dark:text-blue-400"
      >
        <ExternalLink className="size-3 shrink-0" />
        Watch
      </a>
    );
  }

  // Private + admin path. Click → server action reveals password →
  // build URL with ?password= → write to clipboard → open in new tab.
  // We can't pre-open the window (pop-up blocker fires on the async
  // continuation) reliably, so we open AFTER the password resolves; the
  // initial click is the user gesture, which most browsers honour for
  // window.open inside a transition started by the same gesture.
  function handleClick() {
    if (isPending) return;
    startTransition(async () => {
      try {
        const password = await revealBattlePassword(battleId);
        const url = `${baseUrl}?password=${encodeURIComponent(password)}`;
        // Best-effort clipboard write — surface the password on failure
        // so the admin can paste it manually rather than losing it.
        let clipboardOk = true;
        try {
          await navigator.clipboard.writeText(url);
        } catch {
          clipboardOk = false;
        }
        const opened = window.open(url, "_blank", "noopener,noreferrer");
        if (opened) {
          toast.success(
            clipboardOk
              ? "Watch URL with password copied + opened in new tab"
              : "Opened in new tab (clipboard blocked — URL in toast)",
          );
        } else {
          // Pop-up blocked — still let the admin recover via clipboard.
          toast.success(
            clipboardOk
              ? "Watch URL with password copied (pop-up blocked — paste it)"
              : "Password revealed but clipboard + pop-up blocked — open /battles/" +
                  battleId,
          );
        }
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Failed to reveal password",
        );
      }
    });
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={isPending}
      title="Reveal password, copy Watch URL with ?password=…, and open the live battle"
      className="inline-flex h-5 items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-600 transition-colors hover:bg-amber-500/20 disabled:opacity-60 dark:text-amber-400"
    >
      {isPending ? (
        <Loader2 className="size-3 shrink-0 animate-spin" />
      ) : (
        <KeyRound className="size-3 shrink-0" />
      )}
      Watch
    </button>
  );
}

/**
 * Inline metadata chips rendered under the Description cell. The chip set
 * is type-aware so each row surfaces ONLY the identifiers that actually
 * apply to that ledger event:
 *
 *   • deposit / deposit_bonus            → chain + source/destination address
 *                                          + blockchain tx hash
 *   • balance_withdrawal / card_withdrawal → destination address + chain
 *                                          + blockchain tx hash + fireblocks id
 *   • vault_lock / vault_unlock          → lock-duration label + unlock_at
 *                                          countdown
 *
 * Each piece is read from the Transaction shape's top-level fields first
 * (the query already projects cryptoAsset / blockchainTxHash / source /
 * destination address / fireblocksTxId), then falls back to plausible
 * metadata keys. We never invent values — if the field isn't on the row,
 * nothing renders.
 */
function RowMetadataChips({ tx }: { tx: Transaction }) {
  const chips: React.ReactNode[] = [];

  // Fiat-only evidence, keyed server-side through the exact completed ledger
  // id and Whop deposit-intent id. Never substitute the account email.
  if (tx.type === "deposit" && tx.whopCheckoutEmail !== undefined) {
    if (tx.whopCheckoutEmail) {
      chips.push(
        <AddressChip
          key="whop-email"
          label="Whop email"
          value={tx.whopCheckoutEmail}
        />,
      );
    } else {
      chips.push(
        <span
          key="whop-email-unavailable"
          className="inline-flex items-center gap-1 rounded border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground"
          title="Whop did not provide a checkout email for this fiat deposit"
        >
          <span className="text-[9px] font-semibold uppercase tracking-wider opacity-70">
            Whop email
          </span>
          Unavailable
        </span>,
      );
    }
  }

  // Crypto chain (e.g. ETH, BTC, SOL) — neutral identifier, not a money
  // value. Use a plain badge with no House-POV coloring.
  if (tx.cryptoAsset) {
    chips.push(
      <span
        key="asset"
        className="inline-flex items-center rounded border border-blue-500/30 bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-blue-600 dark:text-blue-400"
        title={`Crypto asset: ${tx.cryptoAsset}`}
      >
        {tx.cryptoAsset}
      </span>,
    );
  }

  // Source address (deposits — where the money came FROM).
  if (tx.sourceAddress) {
    chips.push(
      <AddressChip
        key="src"
        label="From"
        value={shortenAddress(tx.sourceAddress)}
        full={tx.sourceAddress}
      />,
    );
  }

  // Destination address (withdrawals — where the money is being sent TO).
  if (tx.destinationAddress) {
    chips.push(
      <AddressChip
        key="dst"
        label="To"
        value={shortenAddress(tx.destinationAddress)}
        full={tx.destinationAddress}
      />,
    );
  }

  // Blockchain transaction hash — on-chain receipt.
  if (tx.blockchainTxHash) {
    chips.push(
      <AddressChip
        key="hash"
        label="Tx"
        value={shortenAddress(tx.blockchainTxHash)}
        full={tx.blockchainTxHash}
      />,
    );
  }

  // Fireblocks internal id — useful for support tickets that bridge to
  // ops. Distinct namespace from the on-chain hash.
  if (tx.fireblocksTxId) {
    chips.push(
      <AddressChip
        key="fb"
        label="FB"
        value={shortenAddress(tx.fireblocksTxId)}
        full={tx.fireblocksTxId}
      />,
    );
  }

  // Vault movements — surface the cooldown picked at lock time and the
  // unlock countdown. Metadata key names vary across backend versions, so
  // we probe a small set defensively (never invent the data — skip the
  // chip when the row's metadata doesn't carry it).
  if (tx.type === "vault_lock" || tx.type === "vault_unlock") {
    const hours = metaNumber(tx.metadata, [
      "hours",
      "lock_hours",
      "unlock_hours",
      "duration_hours",
    ]);
    const unlockAt = metaString(tx.metadata, [
      "unlock_at",
      "unlockAt",
      "unlocks_at",
    ]);

    if (hours != null) {
      const label =
        hours >= 24 && hours % 24 === 0
          ? `${hours / 24}d`
          : hours >= 1
            ? `${hours}h`
            : `${Math.round(hours * 60)}m`;
      chips.push(
        <span
          key="vault-hours"
          className="inline-flex items-center rounded border border-blue-500/30 bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-blue-600 dark:text-blue-400"
          title={`Vault lock window: ${hours}h`}
        >
          Lock {label}
        </span>,
      );
    } else if (tx.type === "vault_lock") {
      // moveBalanceToVault (admin action) writes `unlock_at: null` — surface
      // that distinctly so operators see "instant unlock" vs "no cooldown set".
      chips.push(
        <span
          key="vault-instant"
          className="inline-flex items-center rounded border border-blue-500/30 bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-blue-600 dark:text-blue-400"
          title="No cooldown — admin parked the balance with `unlock_at: null`"
        >
          No cooldown
        </span>,
      );
    }

    if (unlockAt) {
      const remaining = formatUnlockIn(unlockAt);
      const absolute = formatDateTime(unlockAt);
      chips.push(
        <span
          key="vault-unlock-at"
          className="inline-flex items-center rounded border border-blue-500/30 bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-blue-600 dark:text-blue-400"
          title={`Unlocks at ${absolute}`}
        >
          {remaining ? `Unlocks ${remaining}` : `Unlocks ${absolute}`}
        </span>,
      );
    }
  }

  if (chips.length === 0) return null;

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">{chips}</div>
  );
}
