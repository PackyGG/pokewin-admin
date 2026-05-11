"use client";

import { ColumnDef } from "@tanstack/react-table";
import { ShieldAlert, Link2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "@/components/ui/tooltip";
import { UsersSortHeader } from "./sort-header";
import { ROLE_COLORS, USER_STATUS_COLORS } from "@/lib/constants";
import { formatCurrency } from "@/lib/utils/format";
import { useFormatDateTime } from "@/components/timezone-provider";
import { cn } from "@/lib/utils";
import { RISK_TIER_COLORS, tierLabel, type RiskTier } from "@/lib/fraud/score-types";

export type UserRow = {
  id: string;
  username: string | null;
  email: string | null;
  image: string | null;
  role: string;
  status: string;
  country: string | null;
  countryCode: string | null;
  availableBalance: number;
  inventoryValue: number;
  /** Cash + locked vault + open inventory — total on-site position. */
  netHoldings: number;
  totalDeposited: number;
  totalWithdrawn: number;
  totalWagered: number;
  depositCount: number;
  pnl: number;
  createdAt: string;
  riskScore: number;
  riskTier: RiskTier;
  sharedIpCount: number;
  sharedFingerprintCount: number;
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
 */
function RegisteredCell({ value }: { value: string }) {
  const fmt = useFormatDateTime();
  return (
    <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
      {fmt(value)}
    </span>
  );
}

/**
 * Risk tier badge with a tooltip exposing the raw score. Hovers over
 * the badge to read the numeric 0-100 value + tier name. Rendered
 * alongside a small "shared IP" chip when the user has 2+ links —
 * double-signal in one cell without crowding the table.
 */
function RiskCell({ row }: { row: UserRow }) {
  // @base-ui/react Tooltip uses a `render` prop (not `asChild`) to
  // let a custom element take the role of the trigger surface. The
  // Badge is rendered via `render`, then children become the visible
  // content inside the badge.
  return (
    <TooltipProvider>
      <div className="flex items-center gap-1.5">
        <Tooltip>
          <TooltipTrigger
            render={
              <Badge
                variant="outline"
                className={cn(
                  "text-[10px] tabular-nums gap-1 h-5 px-1.5 cursor-help",
                  RISK_TIER_COLORS[row.riskTier],
                )}
              />
            }
          >
            <ShieldAlert className="size-2.5" />
            {row.riskScore}
          </TooltipTrigger>
          <TooltipContent side="top">
            {tierLabel(row.riskTier)} risk — score {row.riskScore} / 100
          </TooltipContent>
        </Tooltip>
        {row.sharedIpCount >= 2 && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Badge
                  variant="outline"
                  className={cn(
                    "text-[10px] tabular-nums gap-1 h-5 px-1.5 cursor-help",
                    row.sharedIpCount >= 5
                      ? "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30"
                      : "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
                  )}
                />
              }
            >
              <Link2 className="size-2.5" />
              {row.sharedIpCount}
            </TooltipTrigger>
            <TooltipContent side="top">
              Shares IP with {row.sharedIpCount} other account
              {row.sharedIpCount === 1 ? "" : "s"}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </TooltipProvider>
  );
}

export const columns: ColumnDef<UserRow>[] = [
  {
    accessorKey: "username",
    header: () => <UsersSortHeader title="User" sortKey="username" />,
    cell: ({ row }) => (
      <div className="flex items-center gap-3">
        <Avatar className="size-8 shrink-0">
          {row.original.image && <AvatarImage src={row.original.image} alt="" />}
          <AvatarFallback className="text-xs">
            {initialsFor(row.original.username, row.original.email)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <div className="truncate font-medium">
            {row.original.username ?? row.original.email ?? "—"}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {row.original.email}
          </div>
        </div>
      </div>
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
    accessorKey: "role",
    header: "Role",
    cell: ({ row }) => (
      <Badge variant="outline" className={ROLE_COLORS[row.original.role]}>
        {row.original.role}
      </Badge>
    ),
  },
  {
    accessorKey: "status",
    header: "Status",
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
    accessorKey: "riskScore",
    header: () => <UsersSortHeader title="Risk" sortKey="riskScore" />,
    cell: ({ row }) => <RiskCell row={row.original} />,
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
    accessorKey: "inventoryValue",
    header: () => <UsersSortHeader title="Inventory" sortKey="inventoryValue" />,
    cell: ({ row }) => (
      <span className="tabular-nums text-muted-foreground">
        {formatCurrency(row.original.inventoryValue)}
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
    header: "# Deposits",
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
