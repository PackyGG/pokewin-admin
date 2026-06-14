"use client";

/**
 * XP Purchases section for the user-detail Finances tab.
 *
 * Surfaces the XP a user bought by spending their own (withdrawable) USD
 * balance — totals (balance spent + XP granted + count) plus a recent list.
 *
 * House-POV (CLAUDE.md): buying XP gives up a dollar we owed the user → a
 * house GAIN → the spend reads EMERALD (matched by the shared
 * `ledgerDirection('xp_purchase')`). XP granted is a non-USD unit → neutral
 * purple, never summed into a USD total.
 *
 * Streamed-band contract: receives `Promise<SafeQueryResult<…>> | null`.
 *   • null         → query not kicked for the active tab → skeleton.
 *   • r.error      → visible compact band error (load failure ≠ empty).
 *   • count === 0  → renders nothing (Finances tab stays focused).
 */

import { use } from "react";
import { Sparkles, CircleDollarSign } from "lucide-react";
import { SectionHeading, StatPanel } from "@/components/modern-panels";
import { InlineError } from "@/components/entity-surface/inline-error";
import { SkeletonCard } from "@/components/ux";
import { RelativeTime } from "@/components/relative-time";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import type { SafeQueryResult } from "@/lib/errors/safe-query";
import type { UserXpPurchasesResult } from "@/lib/queries/users-xp-purchases";

export function XpPurchasesSection({
  xpPurchasesPromise,
}: {
  xpPurchasesPromise: Promise<SafeQueryResult<UserXpPurchasesResult>> | null;
}) {
  if (!xpPurchasesPromise) {
    return (
      <div className="space-y-3">
        <SectionHeading icon={Sparkles} title="XP Purchases" />
        <SkeletonCard lines={4} />
      </div>
    );
  }
  return <XpPurchasesStreamed xpPurchasesPromise={xpPurchasesPromise} />;
}

function XpPurchasesStreamed({
  xpPurchasesPromise,
}: {
  xpPurchasesPromise: Promise<SafeQueryResult<UserXpPurchasesResult>>;
}) {
  const r = use(xpPurchasesPromise);

  if (r.error) {
    return (
      <div className="space-y-3">
        <SectionHeading icon={Sparkles} title="XP Purchases" />
        <InlineError
          compact
          title="Couldn't load XP purchases"
          hint="This is a load failure, not an empty history — retry to re-run the query."
        />
      </div>
    );
  }

  const result = r.data;

  // Self-hide when the user never bought XP (or the connected enum lacks the
  // member) — the Finances tab stays focused on deposits/withdrawals.
  if (result.count === 0) return null;

  return (
    <div className="space-y-3">
      <SectionHeading icon={Sparkles} title="XP Purchases" />
      <p className="-mt-1 text-[11px] text-muted-foreground">
        XP this user bought by spending their own (withdrawable) balance — from
        the house perspective every dollar spent is a dollar we owed, now given
        up (a{" "}
        <span className="text-emerald-600 dark:text-emerald-400">
          house gain
        </span>
        ). XP granted is a non-USD unit and isn&apos;t part of any dollar total.
      </p>

      <div className="grid gap-3 lg:grid-cols-2">
        {/* Totals — balance spent (USD, house gain) + XP granted + count. */}
        <StatPanel title="Totals" icon={CircleDollarSign} accent="emerald">
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Balance spent on XP
            </span>
            <span className="text-2xl font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
              {formatCurrency(result.totalSpent)}
            </span>
          </div>
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2 py-1 text-sm">
              <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
                XP granted
              </span>
              <span className="shrink-0 font-bold tabular-nums text-purple-600 dark:text-purple-400">
                {formatNumber(result.totalXp)}
                <span className="ml-1 text-[10px] font-medium text-muted-foreground">
                  XP
                </span>
              </span>
            </div>
            <div className="flex items-center justify-between gap-2 py-1 text-sm">
              <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
                Purchases
              </span>
              <span className="shrink-0 font-bold tabular-nums">
                {formatNumber(result.count)}
              </span>
            </div>
          </div>
        </StatPanel>

        {/* Recent purchases — newest first, spend + XP granted per row. */}
        <StatPanel title="Recent purchases" icon={Sparkles} accent="emerald">
          {result.recent.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No recent XP purchases.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {result.recent.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center justify-between gap-2 text-xs"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="text-muted-foreground">
                      <RelativeTime date={p.createdAt} />
                    </span>
                    {p.xpAwarded != null && (
                      <span className="shrink-0 text-[11px] font-medium text-purple-600 dark:text-purple-400">
                        {formatNumber(p.xpAwarded)} XP
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                    +{formatCurrency(p.amount)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </StatPanel>
      </div>
    </div>
  );
}
