import Link from "next/link";
import { Coins, Package, Swords, Trophy } from "lucide-react";

import {
  getCodeReferrals,
  getRecentWagersOnCode,
} from "@/lib/queries/creators";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  formatCurrency,
  formatDateTime,
  formatRelative,
} from "@/lib/utils/format";

import { CodeActivityTabs } from "./_components/code-activity-tabs";

// Per-code activity panel for the creator detail page. Surfaces two
// related views over the same population of users (everyone with at
// least one row in affiliate_code_usages for this creator's primary
// code), grouped under a single tab switch:
//
//   1) Users on code — aggregated per user (deposits, wagers,
//      commission, last activity).
//   2) Last wagers — chronological feed of completed wager events
//      (pack_opening, battle_bet, battle_sponsorship) from those users.
//
// Both queries are slim by design: getCodeReferrals returns only the
// 4 columns the table renders (no per-row correlated subqueries), and
// getRecentWagersOnCode is a single CTE+limit query. The fuller
// breakdown lives at /creators/codes/[code] (linked from the tab
// header).
//
// Both fail soft: if either query throws, the panel renders an empty
// state — same philosophy as LeaderboardsCard sitting below it.

const WAGER_TYPE_META: Record<
  "pack_opening" | "battle_bet" | "battle_sponsorship",
  { label: string; icon: React.ElementType; className: string }
> = {
  pack_opening: {
    label: "Pack",
    icon: Package,
    className:
      "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  },
  battle_bet: {
    label: "Battle bet",
    icon: Swords,
    className:
      "bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30",
  },
  battle_sponsorship: {
    label: "Battle sponsor",
    icon: Trophy,
    className:
      "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
  },
};

export async function CodeActivityCard({ code }: { code: string }) {
  const [referrals, recentWagers] = await Promise.all([
    getCodeReferrals(code, 25),
    getRecentWagersOnCode(code, 25),
  ]);

  // Render both tab panels server-side so the client tabs component
  // can swap them in/out without re-fetching. Each panel wraps its
  // table in a bordered rounded surface (no Card chrome) so the tab
  // bar above reads as the section's identity, with the table sitting
  // as the active "page" content beneath.
  const usersPanel = (
    <div className="overflow-hidden rounded-2xl border bg-card/60">
      <Table>
      <TableHeader>
        <TableRow>
          <TableHead>User</TableHead>
          {/* Wager volume — money INTO house treasury per CLAUDE.md
              house-POV → emerald in the body. */}
          <TableHead className="text-right">Wagered</TableHead>
          {/* Commission paid TO creator → house outflow → rose. */}
          <TableHead className="text-right">Commission</TableHead>
          <TableHead>Last activity</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {referrals.map((r) => (
          <TableRow key={r.referredUserId}>
            <TableCell>
              <Link
                href={`/users/${r.referredUserId}`}
                className="hover:underline font-medium"
              >
                {r.referredUsername ??
                  r.referredEmail ??
                  r.referredUserId.slice(0, 8)}
              </Link>
            </TableCell>
            <TableCell className="text-right tabular-nums text-emerald-600 dark:text-emerald-400">
              {formatCurrency(r.totalWagersUsd)}
            </TableCell>
            <TableCell className="text-right tabular-nums text-rose-600 dark:text-rose-400">
              {formatCurrency(r.totalCommissionUsd)}
            </TableCell>
            <TableCell className="text-sm text-muted-foreground">
              {formatRelative(r.lastActivityAt)}
            </TableCell>
          </TableRow>
        ))}
        {referrals.length === 0 && (
          <TableRow>
            <TableCell
              colSpan={4}
              className="h-24 text-center text-muted-foreground"
            >
              No users on this code yet.
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
    </div>
  );

  const wagersPanel = (
    <div className="overflow-hidden rounded-2xl border bg-card/60">
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>User</TableHead>
          <TableHead>Type</TableHead>
          <TableHead className="text-right">Amount</TableHead>
          <TableHead>When</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {recentWagers.map((w) => {
          const meta = WAGER_TYPE_META[w.type];
          const Icon = meta?.icon ?? Coins;
          return (
            <TableRow key={w.id}>
              <TableCell>
                <Link
                  href={`/users/${w.userId}`}
                  className="hover:underline font-medium"
                >
                  {w.username ?? w.email ?? w.userId.slice(0, 8)}
                </Link>
              </TableCell>
              <TableCell>
                <Badge
                  variant="outline"
                  className={meta?.className ?? "text-xs"}
                >
                  <Icon className="mr-1 size-3" />
                  {meta?.label ?? w.type}
                </Badge>
              </TableCell>
              {/* Wager amount — money INTO the house treasury.
                  emerald per CLAUDE.md house-POV (user wagers =
                  good for us). Display as positive (the raw ledger
                  amount is negative because it's a debit on the
                  user's side). */}
              <TableCell className="text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                {formatCurrency(w.amountUsd)}
              </TableCell>
              <TableCell
                className="text-sm text-muted-foreground"
                title={formatDateTime(w.createdAt)}
              >
                {formatRelative(w.createdAt)}
              </TableCell>
            </TableRow>
          );
        })}
        {recentWagers.length === 0 && (
          <TableRow>
            <TableCell
              colSpan={4}
              className="h-24 text-center text-muted-foreground"
            >
              No wager activity yet.
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
    </div>
  );

  return (
    <CodeActivityTabs
      code={code}
      counts={{ users: referrals.length, wagers: recentWagers.length }}
      usersPanel={usersPanel}
      wagersPanel={wagersPanel}
    />
  );
}
