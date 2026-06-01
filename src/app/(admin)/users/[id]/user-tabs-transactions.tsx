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
import {
  formatCurrency,
  formatRelative,
} from "@/lib/utils/format";
import { formatUpgraderChance } from "@/lib/utils/upgrader-metadata";
import {
  amountColorFor,
  amountSignFor,
  ledgerDirection,
} from "@/lib/utils/ledger-direction";
import { BorrowBadge } from "@/components/borrow-badge";
import { EmptyState } from "@/components/empty-state";
import { battleUrl } from "@/lib/utils/main-site";
import { fetchUserTransactions } from "./actions";
import type {
  Transaction,
  PaginatedTransactions,
  UserDetail,
} from "./user-tabs-types";

/**
 * Compact multiplier formatter used on the upgrader_bet "Won Value"
 * cell. Mirrors the badge style on /transactions/upgrader's data
 * table (formatMultiplier there) so the same realized multiplier
 * reads identically across both surfaces:
 *   • < 10×   → one decimal (e.g. 2.5×, 8.3×)
 *   • < 1000× → integer    (e.g. 12×, 100×)
 *   • ≥ 1000× → k-suffixed (e.g. 1.2k×)
 */
function formatUpgraderMultiplier(m: number): string {
  if (m < 10) return `${m.toFixed(1)}×`;
  if (m < 1000) return `${Math.round(m)}×`;
  return `${(m / 1000).toFixed(1)}k×`;
}

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

const TX_STATUSES = ["all", "pending", "completed", "failed"] as const;

const CW_STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400",
  processing: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  shipped: "bg-purple-500/15 text-purple-600 dark:text-purple-400",
  completed: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  failed: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
  cancelled: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400",
};

export const CategoryTransactionsTable = React.memo(
  function CategoryTransactionsTable({
    title,
    userId,
    types,
    initialTx,
    showCardsValue = false,
    cardWithdrawals,
    isAdmin = false,
  }: {
    title: string;
    userId: string;
    types: readonly string[];
    initialTx: PaginatedTransactions;
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
  }) {
    const [txData, setTxData] = useState(initialTx);
    const [typeFilter, setTypeFilter] = useState("all");
    const [statusFilter, setStatusFilter] = useState("all");
    const [dateFrom, setDateFrom] = useState("");
    const [dateTo, setDateTo] = useState("");
    const [selectedTx, setSelectedTx] = useState<Transaction | null>(null);
    const [isPending, startTransition] = useTransition();
    const [currentPerPage, setCurrentPerPage] = useState(initialTx.perPage);

    // The parent /users/[id] page re-renders every 60s via AutoRefresh.
    // Each re-render produces a fresh `initialTx` from the server. If
    // the admin hasn't applied a filter and is on page 1, re-seed the
    // local table state so new gaming/financial events show up without
    // a manual reload. Filters/pagination keep their state — the
    // admin's view isn't yanked back to defaults mid-investigation.
    const filtersUnchanged =
      typeFilter === "all" &&
      statusFilter === "all" &&
      !dateFrom &&
      !dateTo &&
      txData.page === 1;
    useEffect(() => {
      if (filtersUnchanged) {
        setTxData(initialTx);
      }
      // We deliberately do NOT depend on filtersUnchanged itself —
      // we only want to re-seed when the server hands us a NEW
      // initialTx, not when the admin toggles a filter back to "all".
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [initialTx]);

    function buildFilters(overrides?: {
      type?: string;
      status?: string;
      from?: string;
      to?: string;
    }) {
      const tf = overrides?.type ?? typeFilter;
      const sf = overrides?.status ?? statusFilter;
      const df = overrides?.from ?? dateFrom;
      const dt = overrides?.to ?? dateTo;
      return {
        type: tf !== "all" ? tf : undefined,
        types: tf === "all" ? [...types] : undefined,
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
      },
    ) {
      const pp = newPerPage ?? currentPerPage;
      if (newPerPage) setCurrentPerPage(newPerPage);
      startTransition(async () => {
        const result = await fetchUserTransactions(
          userId,
          newPage,
          pp,
          buildFilters(filterOverrides),
        );
        setTxData(result);
      });
    }

    function handleTypeChange(value: string) {
      setTypeFilter(value);
      load(1, undefined, { type: value });
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
      typeFilter !== "all" || statusFilter !== "all" || dateFrom || dateTo;

    function clearFilters() {
      setTypeFilter("all");
      setStatusFilter("all");
      setDateFrom("");
      setDateTo("");
      load(1, undefined, { type: "all", status: "all", from: "", to: "" });
    }

    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">{title}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-start gap-3">
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
                  {types.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t.replace(/_/g, " ")}
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
                {showCardsValue && <TableHead>Won Value</TableHead>}
                {showCardsValue && <TableHead>House Profit</TableHead>}
                <TableHead>Worth Before</TableHead>
                <TableHead>Worth After</TableHead>
                <TableHead>Inventory</TableHead>
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
                      onClick={() => setSelectedTx(t)}
                      className="font-mono text-xs text-blue-400 hover:underline"
                    >
                      {t.id.slice(0, 8)}...
                    </button>
                  </TableCell>
                  {/* Dedicated "watch live" button — gaming tab, battle_bet
                      only. Opens packy.gg/battle/<id> in a new tab.
                      Empty cell on other gaming rows keeps the column aligned.
                      Private battles + admin viewer: WatchButton reveals
                      the password on click, copies the URL with
                      ?password=<pw>, and opens the live battle URL. */}
                  {showCardsValue && (
                    <TableCell>
                      {t.type === "battle_bet" && t.battleId ? (
                        <WatchButton
                          battleId={t.battleId}
                          hasPassword={t.hasPassword === true && isAdmin}
                        />
                      ) : null}
                    </TableCell>
                  )}
                  <TableCell>
                    <div className="flex flex-col items-start gap-0.5">
                      <Badge variant="outline" className="font-mono text-xs">
                        {t.type}
                      </Badge>
                      {/* Borrow signal lives directly under the type
                          chip so admins scrolling a long activity
                          tab can spot borrowed opens at a glance.
                          Renders nothing for non-borrowed events. */}
                      <BorrowBadge
                        percent={t.borrowPercentage}
                        amountUsd={t.borrowedAmountUsd}
                        size="sm"
                      />
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
                      // Finances / overview: Amount IS the signal, so
                      // color + sign it from the HOUSE POV (classified by
                      // ledger type, matching every other tx surface).
                      const dir = ledgerDirection(t.type);
                      return (
                        <TableCell className={amountColorFor(dir)}>
                          {amountSignFor(dir)}
                          {formatCurrency(t.amount)}
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
                        return (
                          <>
                            <TableCell className="tabular-nums text-muted-foreground">
                              —
                            </TableCell>
                            <TableCell className="tabular-nums">
                              <span className="text-emerald-600 dark:text-emerald-400">
                                +{formatCurrency(t.amount)}
                              </span>
                            </TableCell>
                          </>
                        );
                      }
                      if (t.type === "battle_bet") {
                        // Win/loss is the battle outcome (winner_team vs
                        // team_number), surfaced as gameResult. null = the
                        // battle hasn't resolved yet.
                        if (t.gameResult === null) {
                          return (
                            <TableCell
                              colSpan={2}
                              className="text-xs italic text-muted-foreground"
                            >
                              Pending — battle still resolving
                            </TableCell>
                          );
                        }
                        if (t.gameResult === "lose") {
                          // LOSS: player won nothing → house keeps the
                          // full bet. Won Value = $0, House Profit = +bet
                          // (house gain = emerald).
                          return (
                            <>
                              <TableCell className="tabular-nums text-muted-foreground">
                                {formatCurrency(0)}
                              </TableCell>
                              <TableCell className="tabular-nums">
                                <span className="text-emerald-600 dark:text-emerald-400">
                                  +{formatCurrency(t.amount)}
                                </span>
                              </TableCell>
                            </>
                          );
                        }
                        // WIN: winnings = the cards the player actually took
                        // from the battle (their battle-sourced inventory).
                        if (
                          t.battleWinnings == null ||
                          t.battleWinnings <= 0
                        ) {
                          // Won, but no traceable kept cards — show the
                          // truthful outcome rather than a misleading +bet.
                          return (
                            <>
                              <TableCell className="tabular-nums text-muted-foreground">
                                —
                              </TableCell>
                              <TableCell className="text-sm font-medium text-rose-600 dark:text-rose-400">
                                Player won
                              </TableCell>
                            </>
                          );
                        }
                        // House P&L on the battle = bet we took in minus the
                        // winnings we paid out. Negative = house lost (rose),
                        // positive = house won (emerald) — already house-POV.
                        const profit = t.amount - t.battleWinnings;
                        return (
                          <>
                            <TableCell className="tabular-nums text-rose-600 dark:text-rose-400">
                              {formatCurrency(t.battleWinnings)}
                            </TableCell>
                            <TableCell className="tabular-nums">
                              <span
                                className={
                                  profit > 0
                                    ? "text-emerald-600 dark:text-emerald-400"
                                    : profit < 0
                                      ? "text-rose-600 dark:text-rose-400"
                                      : "text-muted-foreground"
                                }
                              >
                                {profit > 0 ? "+" : ""}
                                {formatCurrency(profit)}
                              </span>
                            </TableCell>
                          </>
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
                        const targetChance = t.upgraderTargetChance;
                        const targetBadge =
                          targetMultiplier != null ? (
                            <span
                              className="ml-1.5 inline-flex items-center rounded border border-cyan-500/30 bg-cyan-500/15 px-1.5 py-0 text-[10px] font-medium text-cyan-600 dark:text-cyan-400"
                              title="Target multiplier the user picked before the spin"
                            >
                              ⇡ {formatUpgraderMultiplier(targetMultiplier)}
                            </span>
                          ) : null;
                        const chanceSubline =
                          targetChance != null ? (
                            <div className="text-[10px] text-muted-foreground leading-tight mt-0.5">
                              Win % {formatUpgraderChance(targetChance)}
                            </div>
                          ) : null;

                        if (t.upgraderResult === "lose") {
                          // LOSS: bet kept by the house. Won = $0,
                          // House Profit = +bet (emerald). "Lost" status
                          // chip + target multiplier badge so the row
                          // reads as "user aimed at X×, lost". Target
                          // chance % sits on a sub-line beneath the
                          // House Profit so it's tied to the
                          // configuration not the outcome.
                          return (
                            <>
                              <TableCell className="tabular-nums">
                                <span className="text-muted-foreground">
                                  {formatCurrency(0)}
                                </span>
                                <span className="ml-1.5 inline-flex items-center rounded border border-emerald-500/30 bg-emerald-500/15 px-1.5 py-0 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                                  Lost
                                </span>
                                {targetBadge}
                              </TableCell>
                              <TableCell className="tabular-nums">
                                <span className="text-emerald-600 dark:text-emerald-400">
                                  +{formatCurrency(t.amount)}
                                </span>
                                {chanceSubline}
                              </TableCell>
                            </>
                          );
                        }
                        if (t.upgraderResult === "win" && t.upgraderWinnings != null) {
                          const profit = t.amount - t.upgraderWinnings;
                          // Realized multiplier — how many times the
                          // bet the user actually took out. Skip the
                          // chip on a zero-stake row (defensive — bet
                          // amount should always be > 0 for upgrader
                          // games, but guard the division regardless).
                          const multiplier =
                            t.amount > 0 ? t.upgraderWinnings / t.amount : null;
                          return (
                            <>
                              <TableCell className="tabular-nums">
                                <span className="text-rose-600 dark:text-rose-400">
                                  {formatCurrency(t.upgraderWinnings)}
                                </span>
                                {multiplier != null && (
                                  <span
                                    className="ml-1.5 inline-flex items-center rounded border border-rose-500/30 bg-rose-500/15 px-1.5 py-0 text-[10px] font-medium text-rose-600 dark:text-rose-400"
                                    title="Realized multiplier (won ÷ bet)"
                                  >
                                    {formatUpgraderMultiplier(multiplier)}
                                  </span>
                                )}
                                {targetBadge}
                              </TableCell>
                              <TableCell className="tabular-nums">
                                <span
                                  className={
                                    profit > 0
                                      ? "text-emerald-600 dark:text-emerald-400"
                                      : profit < 0
                                        ? "text-rose-600 dark:text-rose-400"
                                        : "text-muted-foreground"
                                  }
                                >
                                  {profit > 0 ? "+" : ""}
                                  {formatCurrency(profit)}
                                </span>
                                {chanceSubline}
                              </TableCell>
                            </>
                          );
                        }
                        // upgraderResult === null → row hasn't been
                        // enriched (defensive — shouldn't happen).
                        return (
                          <>
                            <TableCell className="tabular-nums text-muted-foreground">
                              —
                            </TableCell>
                            <TableCell className="tabular-nums text-muted-foreground">
                              —
                            </TableCell>
                          </>
                        );
                      }
                      // Gaming is pack/battle only. Card sales /
                      // exchanges live in the Financial tab now, so the
                      // fallback below only has to handle pack_opening
                      // (cardsValue present) and the few remaining
                      // gaming types where cardsValue is absent
                      // (voucher_redeemed — kept here since it can
                      // unlock the borrow allowance in a battle).
                      const cv = t.cardsValue;
                      return (
                        <>
                          <TableCell className="tabular-nums">
                            {cv != null ? formatCurrency(cv) : "—"}
                          </TableCell>
                          <TableCell className="tabular-nums">
                            {cv != null
                              ? (() => {
                                  // House profit on the session: bet we
                                  // took in minus value of cards + vouchers
                                  // we handed back. Positive = house win
                                  // (emerald), negative = user pulled
                                  // above bet (rose) — already in
                                  // house-POV, no sign flip needed.
                                  const profit = t.amount - cv;
                                  return (
                                    <span
                                      className={
                                        profit > 0
                                          ? "text-emerald-600 dark:text-emerald-400"
                                          : profit < 0
                                            ? "text-rose-600 dark:text-rose-400"
                                            : "text-muted-foreground"
                                      }
                                    >
                                      {profit > 0 ? "+" : ""}
                                      {formatCurrency(profit)}
                                    </span>
                                  );
                                })()
                              : "—"}
                          </TableCell>
                        </>
                      );
                    })()}
                  {/* Before / After show TOTAL WORTH (cash balance + held
                      inventory worth), not cash alone — the raw cash is in
                      the tooltip, and the held inventory has its own column
                      to the right. Matches the detail modal's Worth rows. */}
                  <TableCell
                    className="text-muted-foreground tabular-nums"
                    title={`Cash ${formatCurrency(t.balanceBefore)} + inventory worth`}
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
                  <TableCell className="text-muted-foreground tabular-nums">
                    {formatCurrency(t.inventoryValue)}
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
                    colSpan={showCardsValue ? 12 : 9}
                    className="p-0"
                  >
                    <EmptyState
                      icon={Receipt}
                      title="No transactions"
                      description="Nothing matches the current filters."
                      compact
                    />
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
          />
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
 *     packy.gg/battle/<id> in a new tab. Same shape and styling as the
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
        className="inline-flex h-7 items-center gap-1 rounded-md border border-blue-500/30 bg-blue-500/10 px-2 text-xs font-medium text-blue-600 transition-colors hover:bg-blue-500/20 dark:text-blue-400"
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
      className="inline-flex h-7 items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 text-xs font-medium text-amber-600 transition-colors hover:bg-amber-500/20 disabled:opacity-60 dark:text-amber-400"
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
