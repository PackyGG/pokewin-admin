"use client";

import { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { Fingerprint, Network } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { UsersSortHeader } from "./sort-header";
import {
  IP_CLUSTER_SUSPICIOUS_MAX,
  USER_STATUS_COLORS,
} from "@/lib/constants";
import { formatCurrency } from "@/lib/utils/format";
import {
  formatSignupProvider,
  signupProviderBadgeClass,
} from "@/lib/utils/signup-provider";
import { useFormatDateTime } from "@/components/timezone-provider";
import { cn } from "@/lib/utils";
import type { UserRow } from "./_lib/user-row";

export type { UserRow } from "./_lib/user-row";

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
          <div className="flex items-center gap-1.5">
            <span className="truncate font-medium hover:underline">
              {row.original.username ?? row.original.email ?? "—"}
            </span>
            {/* Device-fingerprint state — shown on EVERY row, not just
                flagged ones. Muted for a normal capture so it reads as
                texture rather than an alert; amber when nothing was ever
                captured (a coverage gap that used to look identical to a
                clean account); rose only for a real alt flag. */}
            <span
              title={
                row.original.suspectedAlt
                  ? "Suspected alt — device fingerprinting flagged this account at signup/login"
                  : row.original.hasDeviceId
                    ? "Device fingerprint captured at signup"
                    : "No device fingerprint captured — alt-detection cannot evaluate this account"
              }
              className="shrink-0"
            >
              <Fingerprint
                className={cn(
                  "size-3",
                  row.original.suspectedAlt
                    ? "text-rose-500"
                    : row.original.hasDeviceId
                      ? "text-muted-foreground/40"
                      : "text-amber-500/70",
                )}
              />
            </span>
            {/* Shared signup IP. Amber only for a SMALL cluster — that's the
                band where sharing is actually suspicious. Anything bigger is
                CGNAT / VPN / campus NAT (nine IPs on prod carry ~1,490 users
                between them), so it renders muted and informational rather
                than as an accusation. Never rose: rose is reserved for the
                device fingerprint, which is the high-confidence signal, and
                two competing reds would flatten that distinction. */}
            {row.original.signupIpSharedCount > 0 && (
              <span
                title={
                  row.original.signupIpSharedCount <= IP_CLUSTER_SUSPICIOUS_MAX
                    ? `Signup IP shared with ${row.original.signupIpSharedCount} other account${row.original.signupIpSharedCount === 1 ? "" : "s"} — small enough to be worth a look`
                    : `Signup IP shared with ${row.original.signupIpSharedCount} other accounts — a cluster this large is almost always CGNAT, a VPN exit or office NAT, not alts`
                }
                className="shrink-0"
              >
                <Network
                  className={cn(
                    "size-3",
                    row.original.signupIpSharedCount <=
                      IP_CLUSTER_SUSPICIOUS_MAX
                      ? "text-amber-500/80"
                      : "text-muted-foreground/40",
                  )}
                />
              </span>
            )}
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
    // Device fingerprint (FingerprintJS visitor_id). Not sortable — there's
    // no backend sort key for it, and it's an identifier rather than a
    // measure. Mirrors the affiliate-code cell's badge + "—" convention.
    // Rose when the alt heuristic fired, muted otherwise; an amber "none"
    // marks a user we never identified, which is a coverage gap rather than
    // a clean bill of health.
    id: "deviceVisitorId",
    header: () => (
      <span className="text-xs font-medium text-muted-foreground">
        Device ID
      </span>
    ),
    cell: ({ row }) => {
      const id = row.original.deviceVisitorId;
      if (!id) {
        return (
          <Badge
            variant="outline"
            className="border-amber-500/30 bg-amber-500/15 font-mono text-xs text-amber-600 dark:text-amber-400"
            title="No device fingerprint captured — alt-detection cannot evaluate this account"
          >
            none
          </Badge>
        );
      }
      return (
        <Badge
          variant="outline"
          className={cn(
            "font-mono text-xs",
            row.original.suspectedAlt
              ? "border-rose-500/30 bg-rose-500/15 text-rose-600 dark:text-rose-400"
              : "border-border/60 bg-muted/50 text-muted-foreground",
          )}
          title={
            row.original.suspectedAlt
              ? `Suspected alt. Device ID (visitor_id): ${id}`
              : `Device ID (visitor_id): ${id}`
          }
        >
          {id.slice(0, 12)}
        </Badge>
      );
    },
  },
  {
    // HOW the user signed up — Discord / Google / Steam OAuth, or email +
    // password (`credential`). Reads the raw BetterAuth providerId of the
    // user's earliest linked account (see users-list.ts hydration) and prints
    // it through the same shared display mapping the user-detail Account card
    // uses. Not sortable — there's no backend sort key for it, same as the
    // Device ID column above.
    id: "signupProvider",
    header: () => (
      <span className="text-xs font-medium text-muted-foreground">Signup</span>
    ),
    cell: ({ row }) => {
      const provider = row.original.signupProvider;
      if (!provider) {
        return <span className="text-sm text-muted-foreground">—</span>;
      }
      return (
        <Badge
          variant="outline"
          className={cn("text-xs", signupProviderBadgeClass(provider))}
          title={`Signed up with ${formatSignupProvider(provider)} (providerId: ${provider})`}
        >
          {formatSignupProvider(provider)}
        </Badge>
      );
    },
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
    // Combined cash + locked vault + inventory + unclaimed vouchers —
    // the user's whole on-site position, which is what the standalone
    // "Balance" column was a partial view of (removed 2026-07-22 on the
    // owner's request: Net already contains it). Colored amber because
    // every dollar here is a direct house liability (we owe the user
    // that much in cash + cards).
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
