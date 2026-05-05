"use client";

import React, { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Loader2,
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { STATUS_COLORS } from "@/lib/constants";
import {
  formatCurrency,
  formatDateTime,
  formatRelative,
} from "@/lib/utils/format";
import {
  amountColorFor,
  amountSignFor,
  ledgerDirection,
} from "@/lib/utils/ledger-direction";
import { fetchUserTransactions, getGameSessionDetails } from "./actions";
import type {
  Transaction,
  PaginatedTransactions,
  UserDetail,
  GameSessionDetails,
} from "./user-tabs-types";

const TX_STATUSES = ["all", "pending", "completed", "failed"] as const;

const RARITY_COLORS: Record<string, string> = {
  common: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400",
  uncommon: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  rare: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  "ultra rare": "bg-purple-500/15 text-purple-600 dark:text-purple-400",
  "secret rare": "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400",
  legendary: "bg-orange-500/15 text-orange-600 dark:text-orange-400",
  holo: "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400",
};

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
                {showCardsValue && <TableHead>Cards Value</TableHead>}
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
                    <Badge variant="outline" className="font-mono text-xs">
                      {t.type}
                    </Badge>
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
                                  // took in minus value of cards we
                                  // handed back. Positive = house win
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
                <TableRow>
                  <TableCell
                    colSpan={showCardsValue ? 11 : 9}
                    className="text-center text-muted-foreground"
                  >
                    No transactions
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          </div>

          <TransactionDetailModal
            transaction={selectedTx}
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

function TransactionDetailModal({
  transaction,
  onClose,
}: {
  transaction: Transaction | null;
  onClose: () => void;
}) {
  const [gameSession, setGameSession] = useState<GameSessionDetails | null>(
    null,
  );
  const [loadingSession, setLoadingSession] = useState(false);

  useEffect(() => {
    if (!transaction?.gameSessionId) {
      setGameSession(null);
      return;
    }
    setLoadingSession(true);
    setGameSession(null);
    getGameSessionDetails(transaction.gameSessionId)
      .then((data) => setGameSession(data))
      .finally(() => setLoadingSession(false));
  }, [transaction?.id, transaction?.gameSessionId]);

  if (!transaction) return null;
  const t = transaction;

  const rows: { label: string; value: React.ReactNode }[] = [
    {
      label: "ID",
      value: <span className="font-mono text-xs break-all">{t.id}</span>,
    },
    {
      label: "Type",
      value: (
        <Badge variant="outline" className="font-mono text-xs">
          {t.type}
        </Badge>
      ),
    },
    {
      label: "Amount",
      value: (() => {
        // Same house-POV treatment as the list row above — classify by
        // ledger type, not balance delta.
        const dir = ledgerDirection(t.type);
        return (
          <span className={amountColorFor(dir)}>
            {amountSignFor(dir)}
            {formatCurrency(t.amount)}
          </span>
        );
      })(),
    },
    { label: "Balance Before", value: formatCurrency(t.balanceBefore) },
    { label: "Balance After", value: formatCurrency(t.balanceAfter) },
    { label: "Inventory Value", value: formatCurrency(t.inventoryValue) },
    {
      label: "Status",
      value: (
        <Badge variant="outline" className={STATUS_COLORS[t.status] ?? ""}>
          {t.status}
        </Badge>
      ),
    },
    { label: "Description", value: t.description },
    { label: "Created", value: formatDateTime(t.createdAt) },
    { label: "Updated", value: formatDateTime(t.updatedAt) },
  ];

  if (t.failureReason) {
    rows.push({
      label: "Failure Reason",
      value: <span className="text-rose-400">{t.failureReason}</span>,
    });
  }
  if (t.cryptoAsset) {
    rows.push({ label: "Crypto Asset", value: t.cryptoAsset });
  }
  if (t.cryptoAmount != null) {
    rows.push({ label: "Crypto Amount", value: String(t.cryptoAmount) });
  }
  if (t.exchangeRate != null) {
    rows.push({ label: "Exchange Rate", value: String(t.exchangeRate) });
  }
  if (t.blockchainTxHash) {
    rows.push({
      label: "Blockchain TX",
      value: (
        <span className="font-mono text-xs break-all">
          {t.blockchainTxHash}
        </span>
      ),
    });
  }
  if (t.sourceAddress) {
    rows.push({
      label: "Source Address",
      value: (
        <span className="font-mono text-xs break-all">{t.sourceAddress}</span>
      ),
    });
  }
  if (t.destinationAddress) {
    rows.push({
      label: "Destination Address",
      value: (
        <span className="font-mono text-xs break-all">
          {t.destinationAddress}
        </span>
      ),
    });
  }
  if (t.depositAddressId) {
    rows.push({
      label: "Deposit Address ID",
      value: (
        <span className="font-mono text-xs break-all">
          {t.depositAddressId}
        </span>
      ),
    });
  }
  if (t.gameSessionId) {
    rows.push({
      label: "Game Session ID",
      value: (
        <span className="font-mono text-xs break-all">{t.gameSessionId}</span>
      ),
    });
  }
  if (t.fireblocksTxId) {
    rows.push({
      label: "Fireblocks TX ID",
      value: (
        <span className="font-mono text-xs break-all">{t.fireblocksTxId}</span>
      ),
    });
  }
  if (t.externalTxId) {
    rows.push({
      label: "External TX ID",
      value: (
        <span className="font-mono text-xs break-all">{t.externalTxId}</span>
      ),
    });
  }
  if (t.soldCard) {
    rows.push({
      label: "Card Sold",
      value: (
        <div className="flex items-center gap-3 rounded-lg border p-2">
          {t.soldCard.imageUrl ? (
            <img
              src={t.soldCard.imageUrl}
              alt={t.soldCard.name}
              className="h-16 w-auto rounded object-contain"
            />
          ) : (
            <div className="h-16 w-10 rounded bg-muted flex items-center justify-center text-xs text-muted-foreground">
              ?
            </div>
          )}
          <div>
            <p className="text-sm font-medium">{t.soldCard.name}</p>
            {t.soldCard.rarity && (
              <Badge
                variant="outline"
                className={`text-[10px] ${RARITY_COLORS[t.soldCard.rarity.toLowerCase()] ?? ""}`}
              >
                {t.soldCard.rarity}
              </Badge>
            )}
          </div>
        </div>
      ),
    });
  }
  if (t.metadata && typeof t.metadata === "object") {
    const meta = t.metadata as Record<string, unknown>;
    const KNOWN_LABELS: Record<string, string> = {
      source_type: "Source Type",
      inventory_item_id: "Inventory Item",
      card_id: "Card",
      pack_id: "Pack",
      pack_name: "Pack Name",
      promo_code: "Promo Code",
      promo_code_id: "Promo Code",
      gift_card_code: "Gift Card Code",
      gift_card_id: "Gift Card",
      battle_id: "Battle",
      vault_id: "Vault",
      race_id: "Race",
      race_name: "Race Name",
      affiliate_code: "Affiliate Code",
      affiliate_id: "Affiliate",
      amount: "Amount",
      reason: "Reason",
      adjusted_by: "Adjusted By",
      action: "Action",
      bonus_percent: "Bonus %",
      deposit_tx_id: "Deposit TX",
      sender_id: "Sender",
      sender_username: "Sender",
      recipient_id: "Recipient",
      recipient_username: "Recipient",
      creator_id: "Creator",
      creator_username: "Creator",
      tip_amount: "Tip Amount",
      voucher_id: "Voucher",
      voucher_code: "Voucher Code",
      exchange_id: "Exchange",
      origin: "Origin",
      origin_id: "Origin ID",
      origin_type: "Origin Type",
      battle_name: "Battle Name",
      pack_count: "Pack Count",
      cards_count: "Cards Count",
      total_value: "Total Value",
      fee: "Fee",
      fee_percent: "Fee %",
      level: "Level",
      xp: "XP",
      reward_type: "Reward Type",
      reward_id: "Reward",
      reward_name: "Reward Name",
      claim_id: "Claim",
      period: "Period",
      tier: "Tier",
      percentage: "Percentage",
      shipping_fee: "Shipping Fee",
      withdrawal_id: "Withdrawal",
      rain_id: "Rain",
    };

    const knownEntries: { label: string; value: string }[] = [];
    const unknownEntries: Record<string, unknown> = {};

    for (const [key, val] of Object.entries(meta)) {
      if (t.soldCard && key === "inventory_item_id") continue; // already shown as card
      const label = KNOWN_LABELS[key];
      if (label && val != null) {
        knownEntries.push({ label, value: String(val) });
      } else if (val != null) {
        unknownEntries[key] = val;
      }
    }

    for (const entry of knownEntries) {
      rows.push({
        label: entry.label,
        value: (
          <span className="font-mono text-xs break-all">{entry.value}</span>
        ),
      });
    }

    if (Object.keys(unknownEntries).length > 0) {
      rows.push({
        label: "Metadata",
        value: (
          <pre className="font-mono text-xs bg-muted rounded p-2 max-h-[200px] overflow-auto whitespace-pre-wrap break-all">
            {JSON.stringify(unknownEntries, null, 2)}
          </pre>
        ),
      });
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-2xl flex flex-col max-h-[85vh]">
        <DialogHeader>
          <DialogTitle>Transaction Details</DialogTitle>
        </DialogHeader>
        <div className="overflow-y-auto flex-1 -mx-4 px-4 space-y-4">
          <div className="grid grid-cols-2 gap-x-6 gap-y-3">
            {rows.map((row) => (
              <div key={row.label} className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">
                  {row.label}
                </span>
                <div className="text-sm">{row.value}</div>
              </div>
            ))}
          </div>

          {t.gameSessionId && (
            <div className="border-t pt-4 space-y-3">
              {loadingSession ? (
                <p className="text-sm text-muted-foreground text-center py-4">
                  Loading game details...
                </p>
              ) : gameSession ? (
                <>
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium">
                      {gameSession.gameType === "pack"
                        ? "Pack Opening"
                        : "Battle"}{" "}
                      Details
                    </h3>
                    <Badge variant="outline" className="font-mono text-xs">
                      {gameSession.result}
                    </Badge>
                  </div>

                  {gameSession.pack && (
                    <Link
                      href={`/packs/${gameSession.pack.id}`}
                      className="flex items-center gap-4 py-2 group"
                    >
                      {gameSession.pack.imageUrl && (
                        <img
                          src={gameSession.pack.imageUrl}
                          alt={gameSession.pack.name}
                          className="h-20 w-auto rounded-lg object-contain drop-shadow-lg"
                        />
                      )}
                      <div>
                        <p className="text-sm font-semibold text-blue-400 group-hover:underline">
                          {gameSession.pack.name}
                        </p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Bet: {formatCurrency(gameSession.betAmount)}
                        </p>
                      </div>
                    </Link>
                  )}

                  {gameSession.items.length > 0 && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-3">
                        Cards Obtained ({gameSession.items.length})
                      </p>
                      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
                        {gameSession.items.map((item) => (
                          <div
                            key={item.id}
                            className="flex flex-col items-center gap-1.5"
                          >
                            {item.imageUrl ? (
                              <img
                                src={item.imageUrl}
                                alt={item.cardName}
                                className="h-28 w-auto rounded-lg object-contain drop-shadow-md"
                              />
                            ) : (
                              <div className="h-28 w-20 rounded-lg bg-muted/50 flex items-center justify-center text-xs text-muted-foreground">
                                ?
                              </div>
                            )}
                            <p className="text-xs font-medium text-center truncate w-full">
                              {item.cardName}
                            </p>
                            {item.rarity && (
                              <Badge
                                variant="outline"
                                className={`text-[10px] ${RARITY_COLORS[item.rarity.toLowerCase()] ?? ""}`}
                              >
                                {item.rarity}
                              </Badge>
                            )}
                            <p className="text-xs text-muted-foreground">
                              {formatCurrency(item.valueAtObtained)}
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {gameSession.pfResults.length > 0 && (
                    <div className="border-t pt-3 space-y-2">
                      <p className="text-xs text-muted-foreground">
                        Provably Fair
                      </p>
                      {gameSession.pfResults.map((pf, i) => (
                        <div
                          key={pf.id}
                          className="rounded-lg border bg-muted/30 p-3 space-y-1.5"
                        >
                          {gameSession.pfResults.length > 1 && (
                            <p className="text-[11px] font-medium text-muted-foreground">
                              Roll #{i + 1}
                            </p>
                          )}
                          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                            <div>
                              <p className="text-[10px] text-muted-foreground">
                                Client Seed
                              </p>
                              <p className="text-[11px] font-mono break-all">
                                {pf.clientSeed}
                              </p>
                            </div>
                            <div>
                              <p className="text-[10px] text-muted-foreground">
                                Server Seed Hash
                              </p>
                              <p className="text-[11px] font-mono break-all">
                                {pf.serverSeedHash}
                              </p>
                            </div>
                            {pf.serverSeed && (
                              <div className="col-span-2">
                                <p className="text-[10px] text-muted-foreground">
                                  Server Seed
                                </p>
                                <p className="text-[11px] font-mono break-all">
                                  {pf.serverSeed}
                                </p>
                              </div>
                            )}
                            <div>
                              <p className="text-[10px] text-muted-foreground">
                                Nonce
                              </p>
                              <p className="text-[11px] font-mono">
                                {pf.nonce}
                              </p>
                            </div>
                            <div>
                              <p className="text-[10px] text-muted-foreground">
                                Ticket
                              </p>
                              <p className="text-[11px] font-mono">
                                {pf.ticket}
                              </p>
                            </div>
                            <div className="col-span-2">
                              <p className="text-[10px] text-muted-foreground">
                                Result Hash
                              </p>
                              <p className="text-[11px] font-mono break-all">
                                {pf.resultHash}
                              </p>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <p className="text-sm text-muted-foreground text-center py-2">
                  Game session not found
                </p>
              )}
            </div>
          )}
        </div>
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  );
}
