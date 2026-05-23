"use client";

import React, { useState, useTransition } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Loader2,
  Receipt,
  X,
} from "lucide-react";
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
import {
  amountColorFor,
  amountSignFor,
  ledgerDirection,
} from "@/lib/utils/ledger-direction";
import { BorrowBadge } from "@/components/borrow-badge";
import { EmptyState } from "@/components/empty-state";
import { fetchUserTransactions } from "./actions";
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
  }: {
    title: string;
    userId: string;
    types: readonly string[];
    initialTx: PaginatedTransactions;
    showCardsValue?: boolean;
    cardWithdrawals?: UserDetail["cardWithdrawals"];
  }) {
    const [txData, setTxData] = useState(initialTx);
    const [typeFilter, setTypeFilter] = useState("all");
    const [statusFilter, setStatusFilter] = useState("all");
    const [dateFrom, setDateFrom] = useState("");
    const [dateTo, setDateTo] = useState("");
    const [selectedTx, setSelectedTx] = useState<Transaction | null>(null);
    const [isPending, startTransition] = useTransition();
    const [currentPerPage, setCurrentPerPage] = useState(initialTx.perPage);

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
                <TableHead>Type</TableHead>
                <TableHead>Amount</TableHead>
                {showCardsValue && <TableHead>Won Value</TableHead>}
                {showCardsValue && <TableHead>House Profit</TableHead>}
                <TableHead>Before</TableHead>
                <TableHead>After</TableHead>
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
                    </div>
                  </TableCell>
                  {(() => {
                    // HOUSE-POV amount. The signed balance delta alone is
                    // a user-perspective signal (wager and withdrawal
                    // both make the balance go down), so we classify by
                    // ledger type instead — matches Recent Activity and
                    // every other transaction surface.
                    const dir = ledgerDirection(t.type);
                    return (
                      <TableCell className={amountColorFor(dir)}>
                        {amountSignFor(dir)}
                        {formatCurrency(t.amount)}
                      </TableCell>
                    );
                  })()}
                  {showCardsValue &&
                    (() => {
                      const isBattle =
                        t.type === "battle_bet" ||
                        t.type === "battle_sponsorship";
                      // For battles, only trust the result once the session
                      // has a win/lose outcome. Until then, provably_fair_results
                      // are still being inserted one-round-at-a-time and any
                      // cardsValue we compute is a moving target. Show
                      // "Pending" so admins don't see a fake P&L.
                      const isBattlePending = isBattle && t.gameResult === null;
                      if (isBattlePending) {
                        return (
                          <TableCell
                            colSpan={2}
                            className="text-xs italic text-muted-foreground"
                          >
                            Pending — battle still resolving
                          </TableCell>
                        );
                      }
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
                  <TableCell className="text-muted-foreground">
                    {formatCurrency(t.balanceBefore)}
                  </TableCell>
                  <TableCell>{formatCurrency(t.balanceAfter)}</TableCell>
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
                    colSpan={showCardsValue ? 11 : 9}
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
