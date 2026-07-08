"use client";

import { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { UsersSortHeader } from "./sort-header";
import { ROLE_COLORS, USER_STATUS_COLORS } from "@/lib/constants";
import { formatCurrency } from "@/lib/utils/format";
import { useFormatDateTime } from "@/components/timezone-provider";
import { cn } from "@/lib/utils";

export type UserRow = {
  id: string;
  username: string | null;
  email: string | null;
  image: string | null;
  role: string;
  status: string;
  country: string | null;
  countryCode: string | null;
  /**
   * `user.affiliate_code` — the affiliate/referral code this user signed
   * up under, if any (null = organic signup). See users-list.ts
   * USER_LIST_SELECT comment for why this reads the plain column rather
   * than the fuller historical resolution users-detail.ts does.
   */
  affiliateCode: string | null;
  availableBalance: number;
  /** Cash + locked vault + open inventory — total on-site position. */
  netHoldings: number;
  totalDeposited: number;
  totalWithdrawn: number;
  totalWagered: number;
  depositCount: number;
  pnl: number;
  createdAt: string;
};

function PnlCell({ value }: { value: number }) {
  // User-perspective P&L:
  //   positive = user is winning  -> bad for us  -> RED
  //   negative = user is losing   -> good for us -> GREEN
  const isUserProfit = value > 0;
  const isUserLoss = value < 0;
  return (
    <span
      className={cn(
        "font-medium tabular-nums",
        isUserProfit && "text-rose-400",
        isUserLoss && "text-emerald-400",
      )}
    >
      {value >= 0 ? "+" : ""}
      {formatCurrency(value)}
    </span>
  );
}

function initialsFor(name: string | null, email: string | null): string {
  const src = name ?? email ?? "?";
  return src.slice(0, 2).toUpperCase();
}

/**
 * Timestamp cell — wrapped as a component so we can call the
 * `useFormatDateTime` hook and get the admin's preferred zone/format.
 * TanStack column definitions themselves can't use hooks directly.
 *
 * suppressHydrationWarning: on a FIRST-EVER visit (no `admin_tz` cookie
 * yet) SSR formats in UTC while the client's TimezoneProvider mount
 * effect adopts the detected browser zone — by the time the streamed
 * table leg hydrates, the client text differs from the server HTML and
 * React throws hydration error #418 (verified in a real browser,
 * 2026-06-11; the cookie-present steady state matches exactly). This is
 * React's documented timestamp case for the flag: keep the server text,
 * let the post-mount re-render correct it. One element, one text node —
 * no other mismatch is masked.
 */
function RegisteredCell({ value }: { value: string }) {
  const fmt = useFormatDateTime();
  return (
    <span
      suppressHydrationWarning
      className="whitespace-nowrap text-xs tabular-nums text-muted-foreground"
    >
      {fmt(value)}
    </span>
  );
}

export const columns: ColumnDef<UserRow>[] = [
  {
    accessorKey: "username",
    header: () => <UsersSortHeader title="User" sortKey="username" />,
    cell: ({ row }) => (
      // Real <Link> so middle-click / Ctrl-click / right-click → "Open
      // in new tab" works natively. stopPropagation prevents the row's
      // onClick from double-firing the navigation on left-click.
      <Link
        href={`/users/${row.original.id}`}
        onClick={(e) => e.stopPropagation()}
        className="flex items-center gap-3 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:rounded-md"
      >
        <Avatar className="size-8 shrink-0">
          {row.original.image && <AvatarImage src={row.original.image} alt="" />}
          <AvatarFallback className="text-xs">
            {initialsFor(row.original.username, row.original.email)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <div className="truncate font-medium hover:underline">
            {row.original.username ?? row.original.email ?? "—"}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {row.original.email}
          </div>
        </div>
      </Link>
    ),
  },
  {
    accessorKey: "country",
    header: () => <UsersSortHeader title="Country" sortKey="country" />,
    cell: ({ row }) => (
      <span className="text-sm text-muted-foreground">
        {row.original.country ??
          (row.original.countryCode ? row.original.countryCode : "—")}
      </span>
    ),
  },
  {
    // Affiliate/referral code this user signed up under (`user.affiliate_code`).
    // Blue badge mirrors the referrer-code chip on /users/[id] (ReferrerCard);
    // "—" mirrors the Country cell's organic/no-data fallback above.
    accessorKey: "affiliateCode",
    header: () => (
      <UsersSortHeader title="Code / Affiliate" sortKey="affiliate_code" />
    ),
    cell: ({ row }) => {
      const code = row.original.affiliateCode;
      if (!code) {
        return <span className="text-sm text-muted-foreground">—</span>;
      }
      return (
        <Badge
          variant="outline"
          className="bg-blue-500/15 font-mono text-xs text-blue-600 border-blue-500/30 dark:text-blue-400"
        >
          {code}
        </Badge>
      );
    },
  },
  {
    accessorKey: "role",
    header: () => <UsersSortHeader title="Role" sortKey="role" />,
    cell: ({ row }) => (
      <Badge variant="outline" className={ROLE_COLORS[row.original.role]}>
        {row.original.role}
      </Badge>
    ),
  },
  {
    accessorKey: "status",
    header: () => <UsersSortHeader title="Status" sortKey="status" />,
    cell: ({ row }) => (
      <Badge
        variant="outline"
        className={USER_STATUS_COLORS[row.original.status]}
      >
        {row.original.status}
      </Badge>
    ),
  },
  {
    accessorKey: "availableBalance",
    header: () => <UsersSortHeader title="Balance" sortKey="balance" />,
    cell: ({ row }) => (
      <span className="font-medium tabular-nums">
        {formatCurrency(row.original.availableBalance)}
      </span>
    ),
  },
  {
    // Combined Balance + Inventory column — answers "who's holding the
    // most on-platform right now" in one sort click. Colored amber
    // because every dollar here is a direct house liability (we owe
    // the user that much in cash + cards). Tooltip-free for now;
    // admins can hover Balance / Inventory individually if they need
    // the breakdown.
    accessorKey: "netHoldings",
    header: () => <UsersSortHeader title="Net" sortKey="netHoldings" />,
    cell: ({ row }) => (
      <span className="font-medium tabular-nums text-orange-600 dark:text-orange-400">
        {formatCurrency(row.original.netHoldings)}
      </span>
    ),
  },
  {
    accessorKey: "totalWagered",
    header: () => <UsersSortHeader title="Wagered" sortKey="totalWagered" />,
    cell: ({ row }) => (
      <span className="tabular-nums text-muted-foreground">
        {formatCurrency(row.original.totalWagered)}
      </span>
    ),
  },
  {
    accessorKey: "totalDeposited",
    header: () => (
      <UsersSortHeader title="Deposited" sortKey="totalDeposited" />
    ),
    cell: ({ row }) => (
      <span className="tabular-nums">
        {formatCurrency(row.original.totalDeposited)}
      </span>
    ),
  },
  {
    accessorKey: "depositCount",
    header: () => (
      <UsersSortHeader title="# Deposits" sortKey="depositCount" />
    ),
    cell: ({ row }) => (
      <span className="tabular-nums text-muted-foreground">
        {row.original.depositCount}
      </span>
    ),
  },
  {
    accessorKey: "totalWithdrawn",
    header: () => (
      <UsersSortHeader title="Withdrawn" sortKey="totalWithdrawn" />
    ),
    cell: ({ row }) => (
      <span className="tabular-nums">
        {formatCurrency(row.original.totalWithdrawn)}
      </span>
    ),
  },
  {
    accessorKey: "pnl",
    header: () => <UsersSortHeader title="P&L" sortKey="pnl" />,
    cell: ({ row }) => <PnlCell value={row.original.pnl} />,
  },
  {
    accessorKey: "createdAt",
    header: () => (
      <UsersSortHeader title="Registered" sortKey="created_at" />
    ),
    cell: ({ row }) => <RegisteredCell value={row.original.createdAt} />,
  },
];
