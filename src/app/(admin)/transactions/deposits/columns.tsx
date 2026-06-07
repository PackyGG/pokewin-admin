"use client";

import type { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { Crown, Phone, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { columns as sharedColumns } from "../columns";
import { formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import type { TransactionListItem } from "@/lib/queries/transactions";
import type { UserTagValue } from "@/lib/queries/user-tags";

/**
 * Column set for the Deposits & Withdrawals transactions view.
 *
 * Differences from the shared column set:
 *   1. Drop payout + houseEdge (game-session metrics, meaningless here).
 *   2. Override the User column to show the user's profile picture to the
 *      left of the username (shared column is text-only).
 *   3. Override the Type column to surface any merged deposit_bonus inline,
 *      e.g. "deposit (+$0.62 bonus)". The bonus row itself is filtered out
 *      of the result set by getDepositTransactions.
 *   4. Add a "Coin" column showing the on-chain crypto asset + amount.
 *
 * Amount / Before / After columns come from the shared set and already
 * reflect the merged deposit+bonus values because getDepositTransactions
 * folds the bonus's balance_after into the deposit row.
 */

// Hidden because they are game-session metrics only.
const HIDDEN_KEYS = new Set(["payout", "housePnl"]);

// House-POV tones: deposit itself is cash IN (house gain, emerald).
// Bonus credits are house-paid perks (house loss, rose). Shipping fee is
// money the user pays US to cover shipping → house gain (emerald).
const TYPE_COLORS: Record<string, string> = {
  deposit:
    "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  deposit_bonus:
    "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30",
  withdrawal_shipping_fee:
    "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
};

function getColumnKey(
  col: ColumnDef<TransactionListItem>
): string | undefined {
  if ("accessorKey" in col && typeof col.accessorKey === "string") {
    return col.accessorKey;
  }
  return col.id;
}

// Trim trailing zeros on the crypto amount while keeping up to 8 decimals
// of precision (the schema stores Decimal(20,8)).
function formatCryptoAmount(amount: number): string {
  if (!Number.isFinite(amount)) return String(amount);
  const fixed = amount.toFixed(8);
  const trimmed = parseFloat(fixed);
  return Number.isFinite(trimmed) ? trimmed.toString() : fixed;
}

// Initials fallback for users without a profile picture — mirrors the
// pattern used in src/app/(admin)/users/columns.tsx.
function initialsFor(username: string | null, userId: string): string {
  const src = username ?? userId;
  return src.slice(0, 2).toUpperCase();
}

// Compact tag badge — mirrors the colors / icons from the user-detail
// tag panel so the same VIP signal looks the same site-wide. Tooltip-
// free here (less hover noise on a busy table); the user-detail page
// still shows the full set-by + when info.
const TAG_META: Record<
  UserTagValue,
  { label: string; icon: typeof Phone; color: string }
> = {
  contacted_vip: {
    label: "Contacted",
    icon: Phone,
    color:
      "border-amber-500/30 bg-amber-500/15 text-amber-700 dark:text-amber-300",
  },
  confirmed_vip: {
    label: "VIP",
    icon: Crown,
    color:
      "border-purple-500/30 bg-purple-500/15 text-purple-700 dark:text-purple-300",
  },
  wager_abuser: {
    label: "Wager",
    icon: ShieldAlert,
    color:
      "border-red-500/30 bg-red-500/15 text-red-700 dark:text-red-300",
  },
  fraud_abuser: {
    label: "Fraud",
    icon: ShieldAlert,
    color:
      "border-rose-600/30 bg-rose-600/15 text-rose-800 dark:text-rose-300",
  },
};

function UserTagBadge({ tag }: { tag: UserTagValue }) {
  const meta = TAG_META[tag];
  const Icon = meta.icon;
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-4 gap-0.5 px-1 text-[9px] font-medium uppercase tracking-wide",
        meta.color,
      )}
    >
      <Icon className="size-2.5" />
      {meta.label}
    </Badge>
  );
}

// Deposit-specific User cell: profile picture on the left, username on the
// right, linking to the user detail page. Underneath the username, any VIP
// tags (Contacted VIP / Confirmed VIP) render as small inline badges so a
// reviewer scanning the deposits list can spot known whales without
// clicking into each profile.
const userColumn: ColumnDef<TransactionListItem> = {
  accessorKey: "username",
  header: "User",
  cell: ({ row }) => {
    const { userId, username, image, userTags } = row.original;
    const label = username ?? userId.slice(0, 8);
    return (
      <div className="flex items-center gap-2 min-w-0">
        <Link
          href={`/users/${userId}`}
          className="flex items-center gap-2 hover:underline min-w-0"
        >
          <Avatar size="sm" className="shrink-0">
            {image && <AvatarImage src={image} alt="" />}
            <AvatarFallback className="text-[10px]">
              {initialsFor(username, userId)}
            </AvatarFallback>
          </Avatar>
          <span className="truncate">{label}</span>
        </Link>
        {userTags.length > 0 && (
          <div className="flex flex-wrap items-center gap-1 shrink-0">
            {userTags.map((t) => (
              <UserTagBadge key={t} tag={t} />
            ))}
          </div>
        )}
      </div>
    );
  },
};

// Deposit-specific Type cell: shows the type badge + an inline "(+$X bonus)"
// annotation when a deposit_bonus was merged into the row.
const typeColumn: ColumnDef<TransactionListItem> = {
  accessorKey: "type",
  header: "Type",
  cell: ({ row }) => {
    const type = row.original.type;
    const bonus = row.original.bonusAmount;
    return (
      <div className="flex items-center gap-2">
        <Badge
          variant="outline"
          className={
            TYPE_COLORS[type] ??
            "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30"
          }
        >
          {type.replace(/_/g, " ")}
        </Badge>
        {bonus != null && bonus > 0 && (
          <span className="text-xs text-muted-foreground">
            (+{formatCurrency(bonus)} bonus)
          </span>
        )}
      </div>
    );
  },
};

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

// Deposit-specific Amount cell: hero figure (the row's amount in
// house-POV emerald — deposit = cash in) with the user's rolling
// 24h / 3d deposit totals stacked underneath as a small badge.
// Lets admins judge at a glance whether a $300 deposit is a one-off
// or someone's 5th in 24 hours.
const amountColumn: ColumnDef<TransactionListItem> = {
  accessorKey: "amount",
  header: "Amount",
  cell: ({ row }) => {
    const amount = row.original.amount;
    const d24 = row.original.userDeposit24h;
    const d3d = row.original.userDeposit3d;
    return (
      <div className="flex flex-col items-start gap-0.5">
        <span className="font-medium tabular-nums text-emerald-600 dark:text-emerald-400">
          {formatCurrency(amount)}
        </span>
        {(d24 != null || d3d != null) && (
          <span className="text-[10px] tabular-nums text-muted-foreground">
            {/* 24h on the left, 3d on the right — both labels short
                so the badge stays on one line on phones. Reads
                "$300 / $1.2k" with the slash separator. */}
            24h: {formatCurrency(d24 ?? 0)} · 3d:{" "}
            {formatCurrency(d3d ?? 0)}
          </span>
        )}
      </div>
    );
  },
};

// Start from the shared columns, drop payout + housePnl, then replace the
// User, Type, and Amount columns with our deposit-specific ones (Amount
// gains the per-user 24h / 3d totals subtitle).
const baseColumns = sharedColumns
  .filter((col) => {
    const key = getColumnKey(col);
    return key ? !HIDDEN_KEYS.has(key) : true;
  })
  .map((col) => {
    const key = getColumnKey(col);
    if (key === "username") return userColumn;
    if (key === "type") return typeColumn;
    if (key === "amount") return amountColumn;
    return col;
  });

// Insert Coin directly before Status so it sits with the other metadata.
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
