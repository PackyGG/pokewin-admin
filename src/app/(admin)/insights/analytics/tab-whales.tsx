import Link from "next/link";
import { Crown } from "lucide-react";
import { FadeIn } from "@/components/fade-in";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils/format";
import {
  getInsightsWhales,
  parseWhalesLens,
  type WhalesLens,
} from "@/lib/queries/insights-analytics/whales";
import { EmptyState } from "@/components/empty-state";
import type { InsightsPeriod } from "./types";
import { safeQuery } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";

/**
 * Whales tab — multi-lens top-25 user lists. Each lens is its own
 * sub-tab inside this tab (URL `?whalesBy=…`) so only the active
 * lens hits the DB.
 *
 * The hero period filter doesn't apply here — whales are inherently
 * lifetime, with 7d/30d covered by their own lens.
 */
export async function WhalesInsightsTab({
  period: _period,
  subTab,
}: {
  period: InsightsPeriod;
  subTab: string | undefined;
}) {
  void _period;
  const lens = parseWhalesLens(subTab);
  const { data: rows, error } = await safeQuery(
    () => getInsightsWhales(lens),
    [] as Awaited<ReturnType<typeof getInsightsWhales>>,
    "insights-analytics.whales",
  );
  if (error) {
    return (
      <TileErrorFallback
        label="Analytics — Whales"
        hint="The whales query failed. Server logs hold the digest."
        size="panel"
      />
    );
  }
  const meta = LENS_META[lens];

  return (
    <FadeIn>
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-xl border bg-muted/20 p-4">
          <div className="rounded-md bg-primary/10 p-1.5">
            <Crown className="size-4 text-primary" />
          </div>
          <div className="text-sm">
            <h3 className="font-semibold">Whales — top 25 lists</h3>
            <p className="text-muted-foreground">
              Pick a lens below. House-POV coloring: house P&amp;L lens =
              emerald (we&apos;re up on these users), biggest single win =
              rose (they took money off us).
            </p>
          </div>
        </div>

        <LensTabs current={lens} />

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">{meta.title}</CardTitle>
            <p className="text-xs text-muted-foreground">{meta.subtitle}</p>
          </CardHeader>
          <CardContent>
            {rows.length === 0 ? (
              <EmptyState
                icon={Crown}
                title="No users yet"
                description="No users qualify for this lens. Try a different one."
                compact
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[60px]">Rank</TableHead>
                    <TableHead>User</TableHead>
                    <TableHead className="text-right">{meta.amountLabel}</TableHead>
                    <TableHead>Detail</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r, i) => (
                    <TableRow key={`${r.userId}-${i}`}>
                      <TableCell className="tabular-nums text-muted-foreground">
                        #{i + 1}
                      </TableCell>
                      <TableCell className="font-medium">
                        <Link href={`/users/${r.userId}`} className="hover:underline">
                          {r.username ?? r.userId.slice(0, 8)}
                        </Link>
                      </TableCell>
                      <TableCell
                        className={cn(
                          "text-right tabular-nums",
                          toneFor(lens),
                        )}
                      >
                        {formatCurrency(r.amount)}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {r.detail}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </FadeIn>
  );
}

const LENS_META: Record<
  WhalesLens,
  { label: string; title: string; subtitle: string; amountLabel: string }
> = {
  "lifetime-pnl": {
    label: "Lifetime P&L",
    title: "Top by lifetime house P&L",
    subtitle:
      "Users we've made the most money from (wagers − payouts, lifetime). Excludes creator on-stream play.",
    amountLabel: "House P&L",
  },
  "lifetime-wager": {
    label: "Lifetime wager",
    title: "Top by lifetime wager",
    subtitle: "Users that have wagered the most across their account lifetime.",
    amountLabel: "Wager",
  },
  "wager-7d": {
    label: "7d wager",
    title: "Top by wager — last 7 days",
    subtitle: "Highest wager volume in a rolling 7-day window.",
    amountLabel: "Wager (7d)",
  },
  "wager-30d": {
    label: "30d wager",
    title: "Top by wager — last 30 days",
    subtitle: "Highest wager volume in a rolling 30-day window.",
    amountLabel: "Wager (30d)",
  },
  "biggest-deposit": {
    label: "Biggest deposit",
    title: "Biggest single deposits",
    subtitle: "Single completed deposits sorted by amount.",
    amountLabel: "Deposit",
  },
  "biggest-withdrawal": {
    label: "Biggest withdrawal",
    title: "Biggest single withdrawals",
    subtitle: "Single completed/shipped card withdrawals sorted by amount.",
    amountLabel: "Withdrawal",
  },
  "biggest-single-loss": {
    label: "Single best (house)",
    title: "Biggest single user losses",
    subtitle: "Single wager rows by amount — single biggest hits we took off users.",
    amountLabel: "Wager",
  },
  "biggest-single-win": {
    label: "Single worst (house)",
    title: "Biggest single user wins",
    subtitle: "Single payout rows by amount — single biggest hits users took off us.",
    amountLabel: "Payout",
  },
};

function toneFor(lens: WhalesLens): string {
  // Lifetime P&L + biggest user-loss = house gain → emerald
  // Biggest withdrawal + biggest user-win = house loss → rose
  // Others (wager, deposit) are neutral.
  switch (lens) {
    case "lifetime-pnl":
    case "biggest-single-loss":
      return "text-emerald-600 dark:text-emerald-400";
    case "biggest-withdrawal":
    case "biggest-single-win":
      return "text-rose-600 dark:text-rose-400";
    default:
      return "text-foreground";
  }
}

function LensTabs({ current }: { current: WhalesLens }) {
  const lenses: WhalesLens[] = [
    "lifetime-pnl",
    "lifetime-wager",
    "wager-7d",
    "wager-30d",
    "biggest-deposit",
    "biggest-withdrawal",
    "biggest-single-loss",
    "biggest-single-win",
  ];
  return (
    <div className="flex flex-wrap gap-1 rounded-lg border bg-muted/40 p-1">
      {lenses.map((lens) => (
        <Link
          key={lens}
          href={`?tab=whales&whalesBy=${lens}`}
          replace
          prefetch={false}
          className={cn(
            "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
            current === lens
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {LENS_META[lens].label}
        </Link>
      ))}
    </div>
  );
}
