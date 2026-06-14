"use client";

/**
 * Shard Winnings section for the user-detail Gaming tab.
 *
 * Surfaces the user's SHARD/COIN winnings (the secondary, wager-earned
 * currency) broken down + tagged by the source game that paid them out
 * (Packs / Battles / Upgrader / Rain), plus a recent-winnings list with a
 * source badge per row.
 *
 * House-POV note (CLAUDE.md): shards are a SECONDARY currency with no direct
 * USD P&L on this surface, so amounts are presented NEUTRALLY in cyan and are
 * never summed into a USD total. Each amount is explicitly labelled "shards"
 * so it's unmistakable it is not dollars.
 *
 * Streamed-band contract: receives `Promise<SafeQueryResult<…>> | null`.
 *   • null            → query not kicked for the active tab → skeleton.
 *   • r.error         → visible amber band error (load failure ≠ empty).
 *   • available:false → the connected DB has no coin_transactions table →
 *                       the section self-hides (renders nothing).
 *   • no winnings     → renders nothing (Gaming tab stays focused on USD).
 */

import { use } from "react";
import {
  Coins,
  Package,
  Swords,
  ArrowUpCircle,
  CloudRain,
  Gem,
} from "lucide-react";
import { SectionHeading, StatPanel } from "@/components/modern-panels";
import { Badge } from "@/components/ui/badge";
import { InlineError } from "@/components/entity-surface/inline-error";
import { SkeletonCard } from "@/components/ux";
import { RelativeTime } from "@/components/relative-time";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/lib/utils/format";
import type { SafeQueryResult } from "@/lib/errors/safe-query";
import type {
  ShardWinningsResult,
  ShardWinSource,
  ShardPackOpensResult,
} from "@/lib/queries/users-shard-winnings";

/** Round + format a shard amount; guards NaN/Infinity to "—". */
function formatShards(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return formatNumber(Math.round(n));
}

// Per-source icon + badge styling. All neutral-leaning tints (the value is
// always cyan) so no source reads as a house gain/loss — shards have no USD
// P&L on this surface.
const SOURCE_META: Record<
  ShardWinSource,
  { icon: React.ElementType; badge: string }
> = {
  packs: {
    icon: Package,
    badge:
      "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  },
  battles: {
    icon: Swords,
    badge:
      "bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30",
  },
  upgrader: {
    icon: ArrowUpCircle,
    badge:
      "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
  },
  rain: {
    icon: CloudRain,
    badge:
      "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400 border-cyan-500/30",
  },
};

function SourceBadge({
  source,
  label,
}: {
  source: ShardWinSource;
  label: string;
}) {
  const meta = SOURCE_META[source];
  const Icon = meta.icon;
  return (
    <Badge
      variant="outline"
      className={cn("h-5 gap-1 py-0 text-[10px]", meta.badge)}
    >
      <Icon className="size-2.5" />
      {label}
    </Badge>
  );
}

export function ShardWinningsSection({
  shardWinningsPromise,
}: {
  shardWinningsPromise: Promise<SafeQueryResult<ShardWinningsResult>> | null;
}) {
  if (!shardWinningsPromise) {
    return (
      <div className="space-y-3">
        <SectionHeading icon={Coins} title="Shard Winnings" />
        <SkeletonCard lines={4} />
      </div>
    );
  }
  return <ShardWinningsStreamed shardWinningsPromise={shardWinningsPromise} />;
}

function ShardWinningsStreamed({
  shardWinningsPromise,
}: {
  shardWinningsPromise: Promise<SafeQueryResult<ShardWinningsResult>>;
}) {
  const r = use(shardWinningsPromise);

  // Load failure → a VISIBLE compact band error so "query failed" is never
  // mistaken for "no shard winnings".
  if (r.error) {
    return (
      <div className="space-y-3">
        <SectionHeading icon={Coins} title="Shard Winnings" />
        <InlineError
          compact
          title="Couldn't load shard winnings"
          hint="This is a load failure, not an empty history — retry to re-run the query."
        />
      </div>
    );
  }

  const result = r.data;

  // Self-hide when the connected DB has no coin_transactions table (e.g. the
  // live prod game DB) OR the user has no shard winnings — the Gaming tab
  // stays focused on USD activity rather than showing an empty shard panel.
  if (!result.available || result.totalWins === 0) return null;

  return (
    <div className="space-y-3">
      <SectionHeading icon={Coins} title="Shard Winnings" />
      <p className="-mt-1 text-[11px] text-muted-foreground">
        Shards/coins are a secondary, wager-earned currency — figures are in
        shards, not USD, and aren&apos;t part of any dollar total.
      </p>

      <div className="grid gap-3 lg:grid-cols-2">
        {/* Per-source breakdown — each row tagged by the game that paid it. */}
        <StatPanel title="By source game" icon={Coins} accent="cyan">
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Total won
            </span>
            <span className="text-2xl font-bold tabular-nums text-cyan-600 dark:text-cyan-400">
              {formatShards(result.totalShards)}
              <span className="ml-1 text-xs font-medium text-muted-foreground">
                shards
              </span>
            </span>
          </div>
          <div className="space-y-1">
            {result.sources.map((s) => (
              <div
                key={s.source}
                className="flex items-center justify-between gap-2 py-1 text-sm"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <SourceBadge source={s.source} label={s.label} />
                  <span className="truncate text-[11px] text-muted-foreground">
                    {formatNumber(s.count)} {s.count === 1 ? "win" : "wins"}
                  </span>
                </span>
                <span className="shrink-0 font-bold tabular-nums text-cyan-600 dark:text-cyan-400">
                  {formatShards(s.total)}
                </span>
              </div>
            ))}
          </div>
        </StatPanel>

        {/* Recent winnings — newest first, source badge per row. */}
        <StatPanel title="Recent winnings" icon={Coins} accent="cyan">
          {result.recent.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No recent shard winnings.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {result.recent.map((w) => (
                <li
                  key={w.id}
                  className="flex items-center justify-between gap-2 text-xs"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <SourceBadge source={w.source} label={w.sourceLabel} />
                    <span className="text-muted-foreground">
                      <RelativeTime date={w.createdAt} />
                    </span>
                  </span>
                  <span className="shrink-0 font-semibold tabular-nums text-cyan-600 dark:text-cyan-400">
                    +{formatShards(w.amount)}
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

// ════════════════════════════════════════════════════════════════════════
//  SHARD PACK OPENS — packs bought with SHARDS (not USD), tagged with a
//  diamond. Shows shards SPENT + value WON (also in shards) per open.
// ════════════════════════════════════════════════════════════════════════
//
// House-POV / UNIT (CLAUDE.md): shards are a SECONDARY, wager-earned currency
// — NOT dollars. Both the spend and the win here are SHARDS, presented
// neutrally (cyan), each explicitly labelled "shards" and never summed into
// any USD total. The diamond tag makes a shard-pack open unmistakable from a
// USD pack open in the Gaming Transactions table above it.

/** A diamond chip tagging a shard (coin-bought) pack open. */
function DiamondTag() {
  return (
    <Badge
      variant="outline"
      className="h-5 gap-1 py-0 text-[10px] bg-cyan-500/15 text-cyan-600 dark:text-cyan-400 border-cyan-500/30"
    >
      <Gem className="size-2.5" />
      Shard pack
    </Badge>
  );
}

export function ShardPackOpensSection({
  shardPackOpensPromise,
}: {
  shardPackOpensPromise: Promise<SafeQueryResult<ShardPackOpensResult>> | null;
}) {
  if (!shardPackOpensPromise) {
    return (
      <div className="space-y-3">
        <SectionHeading icon={Gem} title="Shard Pack Opens" />
        <SkeletonCard lines={4} />
      </div>
    );
  }
  return (
    <ShardPackOpensStreamed shardPackOpensPromise={shardPackOpensPromise} />
  );
}

function ShardPackOpensStreamed({
  shardPackOpensPromise,
}: {
  shardPackOpensPromise: Promise<SafeQueryResult<ShardPackOpensResult>>;
}) {
  const r = use(shardPackOpensPromise);

  if (r.error) {
    return (
      <div className="space-y-3">
        <SectionHeading icon={Gem} title="Shard Pack Opens" />
        <InlineError
          compact
          title="Couldn't load shard pack opens"
          hint="This is a load failure, not an empty history — retry to re-run the query."
        />
      </div>
    );
  }

  const result = r.data;

  // Self-hide when the connected DB has no coin_transactions table (e.g. the
  // live prod game DB) OR the user never opened a shard pack.
  if (!result.available || result.totalOpens === 0) return null;

  return (
    <div className="space-y-3">
      <SectionHeading icon={Gem} title="Shard Pack Opens" />
      <p className="-mt-1 text-[11px] text-muted-foreground">
        Packs bought with{" "}
        <span className="inline-flex items-center gap-0.5 font-medium text-cyan-600 dark:text-cyan-400">
          <Gem className="size-3" /> shards
        </span>{" "}
        (the secondary, wager-earned currency) — not USD. Spend and value won
        are both in shards and aren&apos;t part of any dollar total.
      </p>

      <div className="grid gap-3 lg:grid-cols-2">
        {/* Totals — opens, spent, won (all shards). */}
        <StatPanel title="Totals" icon={Gem} accent="cyan">
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Shard packs opened
            </span>
            <span className="text-2xl font-bold tabular-nums text-cyan-600 dark:text-cyan-400">
              {formatNumber(result.totalOpens)}
            </span>
          </div>
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2 py-1 text-sm">
              <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
                Shards spent
              </span>
              <span className="shrink-0 font-bold tabular-nums text-cyan-600 dark:text-cyan-400">
                {formatShards(result.totalSpent)}
                <span className="ml-1 text-[10px] font-medium text-muted-foreground">
                  shards
                </span>
              </span>
            </div>
            <div className="flex items-center justify-between gap-2 py-1 text-sm">
              <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
                Value won
              </span>
              <span className="shrink-0 font-bold tabular-nums text-cyan-600 dark:text-cyan-400">
                {formatShards(result.totalWon)}
                <span className="ml-1 text-[10px] font-medium text-muted-foreground">
                  shards
                </span>
              </span>
            </div>
          </div>
        </StatPanel>

        {/* Recent opens — newest first, diamond tag + spent/won per row. */}
        <StatPanel title="Recent opens" icon={Gem} accent="cyan">
          {result.recent.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No recent shard pack opens.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {result.recent.map((o) => (
                <li
                  key={o.id}
                  className="flex items-center justify-between gap-2 text-xs"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <DiamondTag />
                    <span className="truncate text-[11px] text-muted-foreground">
                      {o.packs > 0
                        ? `${formatNumber(o.packs)} ${o.packs === 1 ? "pack" : "packs"} · `
                        : ""}
                      <RelativeTime date={o.createdAt} />
                    </span>
                  </span>
                  <span className="flex shrink-0 items-baseline gap-2 tabular-nums">
                    <span className="text-muted-foreground">
                      −{formatShards(o.spent)}
                    </span>
                    <span className="font-semibold text-cyan-600 dark:text-cyan-400">
                      +{formatShards(o.won)}
                    </span>
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
