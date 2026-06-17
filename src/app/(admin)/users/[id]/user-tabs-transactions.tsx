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
  ExternalLink,
  KeyRound,
  Loader2,
  Receipt,
  Target,
  X,
} from "lucide-react";
import { revealBattlePassword } from "@/app/(admin)/battles/actions";
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
  UserDetail,
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

const CW_STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400",
  processing: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  shipped: "bg-purple-500/15 text-purple-600 dark:text-purple-400",
  completed: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  failed: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
  cancelled: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400",
};

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
    cardWithdrawals,
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
    cardWithdrawals?: UserDetail["cardWithdrawals"];
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
              inside the card on phone instead of forcing the page to scroll. */}
          <div className="overflow-x-auto -mx-6 px-6 sm:mx-0 sm:px-0">
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
              {txData.data.map((t) => (
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
                        // Win/loss is the battle outcome (winner_team vs
                        // team_number), surfaced as gameResult. null = the
                        // battle hasn't resolved yet.
                        if (t.gameResult === null) {
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
                          return <MergedPnlCell profit={t.amount} won={0} />;
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
                  <TableCell className="max-w-[250px] text-xs text-muted-foreground">
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
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatRelative(t.createdAt)}
                  </TableCell>
                </TableRow>
              ))}
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
                      {[10, 20, 50, 100].map((n) => (
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

          {/* Card Withdrawals */}
          {cardWithdrawals && cardWithdrawals.length > 0 && (
            <CardWithdrawalsSubTable withdrawals={cardWithdrawals} />
          )}
        </CardContent>
      </Card>
    );
  },
);

function CardWithdrawalsSubTable({
  withdrawals,
}: {
  withdrawals: UserDetail["cardWithdrawals"];
}) {
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(10);

  const totalPages = Math.max(1, Math.ceil(withdrawals.length / perPage));
  const paginated = withdrawals.slice((page - 1) * perPage, page * perPage);

  function changePage(p: number) {
    setPage(Math.max(1, Math.min(p, totalPages)));
  }

  function changePerPage(pp: number) {
    setPerPage(pp);
    setPage(1);
  }

  return (
    <div className="border-t pt-4">
      <p className="text-xs font-medium text-muted-foreground mb-3">
        Card Withdrawals ({withdrawals.length})
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>ID</TableHead>
            <TableHead>Method</TableHead>
            <TableHead>Value</TableHead>
            <TableHead>Shipping</TableHead>
            <TableHead>Tracking</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Date</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {paginated.map((w) => (
            <TableRow
              key={w.id}
              className="cursor-pointer hover:bg-muted/50"
              onClick={() => window.open(`/withdrawals/${w.id}`, "_blank")}
            >
              <TableCell>
                <span className="font-mono text-xs text-blue-400">
                  {w.id.slice(0, 8)}…
                </span>
              </TableCell>
              <TableCell className="text-xs">
                {w.method.replace(/_/g, " ")}
              </TableCell>
              <TableCell className="text-xs">
                {formatCurrency(w.totalValueUsd)}
              </TableCell>
              <TableCell className="text-xs">
                {w.shippingFeeUsd != null
                  ? formatCurrency(w.shippingFeeUsd)
                  : "-"}
              </TableCell>
              <TableCell className="text-xs font-mono">
                {w.trackingNumber ?? "-"}
              </TableCell>
              <TableCell>
                <Badge
                  variant="outline"
                  className={CW_STATUS_COLORS[w.status] ?? ""}
                >
                  {w.status}
                </Badge>
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {formatRelative(w.requestedAt)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {totalPages > 0 && (
        <div className="flex items-center justify-between py-4">
          <p className="text-sm text-muted-foreground">
            {withdrawals.length} withdrawal{withdrawals.length !== 1 ? "s" : ""}
          </p>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Rows</span>
              <Select
                value={String(perPage)}
                onValueChange={(v) => v && changePerPage(Number(v))}
              >
                <SelectTrigger className="h-8 w-[70px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[10, 20, 50].map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <span className="text-sm text-muted-foreground">
              Page {page} of {totalPages}
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="icon"
                className="size-8"
                onClick={() => changePage(1)}
                disabled={page <= 1}
              >
                <ChevronsLeft className="size-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="size-8"
                onClick={() => changePage(page - 1)}
                disabled={page <= 1}
              >
                <ChevronLeft className="size-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="size-8"
                onClick={() => changePage(page + 1)}
                disabled={page >= totalPages}
              >
                <ChevronRight className="size-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="size-8"
                onClick={() => changePage(totalPages)}
                disabled={page >= totalPages}
              >
                <ChevronsRight className="size-4" />
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

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
