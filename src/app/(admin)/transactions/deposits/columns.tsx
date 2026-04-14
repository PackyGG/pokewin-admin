"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { columns as sharedColumns } from "../columns";
import type { TransactionListItem } from "@/lib/queries/transactions";

/**
 * Column set for the Deposits & Withdrawals transactions view.
 *
 * Deposits/withdrawals are pure money movements — payout and house edge
 * are game-session metrics and meaningless here. We drop those two columns
 * from the shared set and add a "Coin" column that surfaces the on-chain
 * crypto asset + amount stored on ledger_transactions.
 */

// Keys to hide on the deposits view because they only make sense for
// game-session rows (packs / battles / rewards).
const HIDDEN_KEYS = new Set(["payout", "houseEdge"]);

function getColumnKey(
  col: ColumnDef<TransactionListItem>
): string | undefined {
  if ("accessorKey" in col && typeof col.accessorKey === "string") {
    return col.accessorKey;
  }
  return col.id;
}

// Trim trailing zeros on the crypto amount while keeping up to 8 decimals
// of precision (the schema stores Decimal(20,8)). Falls back to the raw
// number on formatter edge cases.
function formatCryptoAmount(amount: number): string {
  if (!Number.isFinite(amount)) return String(amount);
  const fixed = amount.toFixed(8);
  const trimmed = parseFloat(fixed);
  return Number.isFinite(trimmed) ? trimmed.toString() : fixed;
}

const coinColumn: ColumnDef<TransactionListItem> = {
  accessorKey: "cryptoAsset",
  header: "Coin",
  cell: ({ row }) => {
    const asset = row.original.cryptoAsset;
    const amount = row.original.cryptoAmount;
    if (!asset) {
      return <span className="text-muted-foreground">—</span>;
    }
    return (
      <span className="font-mono text-xs">
        {amount != null ? `${formatCryptoAmount(amount)} ${asset}` : asset}
      </span>
    );
  },
};

const baseColumns = sharedColumns.filter((col) => {
  const key = getColumnKey(col);
  return key ? !HIDDEN_KEYS.has(key) : true;
});

// Place the Coin column directly before Status so it sits with the other
// transaction metadata. If for some reason Status isn't found (shared
// columns changed), fall back to appending at the end.
const statusIdx = baseColumns.findIndex(
  (c) => getColumnKey(c) === "status"
);

export const columns: ColumnDef<TransactionListItem>[] =
  statusIdx >= 0
    ? [
        ...baseColumns.slice(0, statusIdx),
        coinColumn,
        ...baseColumns.slice(statusIdx),
      ]
    : [...baseColumns, coinColumn];
