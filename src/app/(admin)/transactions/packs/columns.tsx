"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { columns as sharedColumns } from "../columns";
import { formatCurrency } from "@/lib/utils/format";
import type { TransactionListItem } from "@/lib/queries/transactions";

/**
 * Compact multiplier formatter — matches the badge style used on the
 * /battles "Biggest Hit" cell:
 *   • < 10×   → one decimal (e.g. 2.5×, 8.3×)
 *   • < 1000× → integer (e.g. 12×, 100×)
 *   • ≥ 1000× → k-suffixed (e.g. 1.2k×) so a $0.10 → $5k pull doesn't
 *     overflow the column.
 */
function formatMultiplier(m: number): string {
  if (m < 10) return `${m.toFixed(1)}×`;
  if (m < 1000) return `${Math.round(m)}×`;
  return `${(m / 1000).toFixed(1)}k×`;
}

function getColumnKey(
  col: ColumnDef<TransactionListItem>,
): string | undefined {
  if ("accessorKey" in col && typeof col.accessorKey === "string") {
    return col.accessorKey;
  }
  return col.id;
}

// Packs-specific Items Won cell: dollar amount on top, multiplier
// badge underneath. `payout` is the full value won (cards + voucher
// excess); the multiplier (= payout / bet) is what the "Highest
// Multiplier" sort ranks by, so surfacing it inline lets admins see
// WHY a row is at the top without doing the math. House loss → rose,
// like the shared Items Won cell.
const payoutColumn: ColumnDef<TransactionListItem> = {
  accessorKey: "payout",
  header: "Items Won",
  cell: ({ row }) => {
    const p = row.original.payout;
    const m = row.original.multiplier;
    if (p == null) return <span className="text-muted-foreground">—</span>;
    return (
      <div className="flex flex-col items-start gap-0.5">
        <span className="text-rose-600 dark:text-rose-400">
          {formatCurrency(p)}
        </span>
        {m != null && m > 0 && (
          <span className="text-[10px] tabular-nums text-muted-foreground">
            {formatMultiplier(m)}
          </span>
        )}
      </div>
    );
  },
};

// Start from shared columns, replace the Items Won cell. Everything
// else (ID, User, Type, Amount, Before, After, House P&L, Status,
// Date) stays exactly as on the global /transactions page.
export const columns: ColumnDef<TransactionListItem>[] = sharedColumns.map(
  (col) => {
    if (getColumnKey(col) === "payout") return payoutColumn;
    return col;
  },
);
