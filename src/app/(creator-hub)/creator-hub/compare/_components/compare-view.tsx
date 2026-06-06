"use client";

import Link from "next/link";
import {
  BadgeDollarSign,
  Coins,
  HandCoins,
  Scale,
  TrendingUp,
  UserPlus,
  Wallet,
} from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  StatPanel,
  PanelRow,
  SectionHeading,
} from "@/components/modern-panels";
import { cn } from "@/lib/utils";
import {
  formatCompactUsd,
  formatCurrency,
  formatNumber,
} from "@/lib/utils/format";

import { COMPARE_MIN } from "../_lib/compare-params";
import type { CompareCreatorRow } from "../_queries/compare-creators";

/**
 * Side-by-side creator comparison — acquisition, cost, ROI, and deal
 * sections rendered as parallel columns (2–3 creators).
 */
export function CompareView({
  creators,
  windowLabel,
  missingIds,
}: {
  creators: CompareCreatorRow[];
  windowLabel: string;
  missingIds: string[];
}) {
  if (creators.length < COMPARE_MIN) {
    return (
      <div className="flex min-h-[280px] flex-col items-center justify-center gap-3 rounded-2xl border border-dashed py-14 text-center">
        <Scale className="size-8 text-muted-foreground/60" />
        <div>
          <p className="text-sm font-semibold">Select creators to compare</p>
          <p className="mt-1 max-w-sm text-xs text-muted-foreground">
            Search and add {COMPARE_MIN}–3 creators above, or open this page
            from the roster with{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">
              ?compare=id1,id2
            </code>
            .
          </p>
        </div>
      </div>
    );
  }

  const colClass =
    creators.length === 2
      ? "grid-cols-1 md:grid-cols-2"
      : "grid-cols-1 md:grid-cols-2 xl:grid-cols-3";

  return (
    <div className="space-y-6">
      {missingIds.length > 0 && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
          {missingIds.length} ID{missingIds.length === 1 ? "" : "s"} not found
          on the roster — removed from comparison.
        </div>
      )}

      <p className="text-[11px] text-muted-foreground">
        Wager + GGR scoped to {windowLabel}. Sign-ups, FTDs, PnL, and deal
        value are lifetime. ROI uses windowed wager × 7.5% vs full deal spend
        (Profitable Algo).
      </p>

      <div className={cn("grid gap-4", colClass)}>
        {creators.map((c) => (
          <CreatorHeader key={c.id} creator={c} />
        ))}
      </div>

      <CompareSection
        title="Acquisition"
        icon={UserPlus}
        accent="blue"
        colClass={colClass}
        creators={creators}
        render={(c) => (
          <>
            <PanelRow label="Sign-ups" value={formatNumber(c.signups)} />
            <PanelRow label="FTDs" value={formatNumber(c.ftds)} />
            <PanelRow
              label="Wager"
              value={formatCompactUsd(c.windowedWagerUsd)}
              valueClassName="text-emerald-600 dark:text-emerald-400"
            />
            <PanelRow
              label="GGR"
              value={
                c.windowedGgrUsd != null
                  ? formatCompactUsd(c.windowedGgrUsd)
                  : "—"
              }
              valueClassName={signedHouseClass(c.windowedGgrUsd)}
            />
          </>
        )}
      />

      <CompareSection
        title="Cost"
        icon={HandCoins}
        accent="rose"
        colClass={colClass}
        creators={creators}
        render={(c) => (
          <>
            <PanelRow
              label="Lifetime PnL"
              value={
                c.lifetimePnlUsd != null
                  ? formatCompactUsd(c.lifetimePnlUsd)
                  : "—"
              }
              valueClassName={signedHouseClass(c.lifetimePnlUsd)}
            />
            <PanelRow
              label="Deal cap"
              value={
                c.dealValue ? formatCompactUsd(c.dealValue.capUsd) : "—"
              }
              valueClassName="text-rose-600 dark:text-rose-400"
            />
            <PanelRow
              label="Leaderboard"
              value={
                c.dealValue
                  ? formatCompactUsd(c.dealValue.leaderboardUsd)
                  : "—"
              }
              valueClassName="text-rose-600 dark:text-rose-400"
            />
            <PanelRow
              label="Tip + sponsor"
              value={
                c.dealValue
                  ? formatCompactUsd(c.dealValue.tipSponsorUsd)
                  : "—"
              }
              valueClassName="text-rose-600 dark:text-rose-400"
            />
            <PanelRow
              label="Total deal spend"
              value={
                c.dealValue
                  ? formatCompactUsd(c.dealValue.dealValueUsd)
                  : "—"
              }
              valueClassName="font-semibold text-rose-600 dark:text-rose-400"
            />
          </>
        )}
      />

      <CompareSection
        title="ROI"
        icon={TrendingUp}
        accent="emerald"
        colClass={colClass}
        creators={creators}
        render={(c) => (
          <>
            <PanelRow
              label="Generated value"
              value={formatCurrency(c.generatedValueUsd)}
              valueClassName="text-emerald-600 dark:text-emerald-400"
            />
            <PanelRow
              label="Deal spend"
              value={
                c.dealSpendUsd > 0 ? formatCurrency(c.dealSpendUsd) : "—"
              }
              valueClassName="text-rose-600 dark:text-rose-400"
            />
            <PanelRow
              label="Rate of return"
              value={formatRoR(c.rateOfReturn)}
              valueClassName={rorClass(c.rateOfReturn)}
            />
            <PanelRow
              label="PnL vs deal"
              value={formatPnlVsDeal(c.lifetimePnlUsd, c.dealSpendUsd)}
              valueClassName={signedHouseClass(
                pnlVsDealRatio(c.lifetimePnlUsd, c.dealSpendUsd),
              )}
            />
          </>
        )}
      />

      <CompareSection
        title="Deal"
        icon={Coins}
        accent="purple"
        colClass={colClass}
        creators={creators}
        render={(c) => (
          <>
            <PanelRow
              label="Status"
              value={
                c.dealStatus ? (
                  <Badge
                    variant="outline"
                    className={cn("capitalize", dealStatusClass(c.dealStatus))}
                  >
                    {c.dealStatus}
                  </Badge>
                ) : (
                  "—"
                )
              }
            />
            <PanelRow
              label="Full deal value"
              value={
                c.dealValue
                  ? formatCompactUsd(c.dealValue.dealValueUsd)
                  : "—"
              }
              valueClassName="font-semibold text-rose-600 dark:text-rose-400"
            />
            <PanelRow
              label="Affiliate code"
              value={
                c.code ? (
                  <span className="font-mono text-xs">{c.code}</span>
                ) : (
                  "—"
                )
              }
            />
            <PanelRow
              label="Live now"
              value={c.isLive ? "Yes" : "No"}
              valueClassName={
                c.isLive
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-muted-foreground"
              }
            />
          </>
        )}
      />

      <CompareHighlights creators={creators} />
    </div>
  );
}

function CompareSection({
  title,
  icon,
  accent,
  colClass,
  creators,
  render,
}: {
  title: string;
  icon: React.ElementType;
  accent: "blue" | "rose" | "emerald" | "purple";
  colClass: string;
  creators: CompareCreatorRow[];
  render: (c: CompareCreatorRow) => React.ReactNode;
}) {
  return (
    <div className="space-y-3">
      <SectionHeading icon={icon} title={title} />
      <div className={cn("grid gap-4", colClass)}>
        {creators.map((c) => (
          <StatPanel
            key={c.id}
            title={c.username ?? "Unknown"}
            icon={Wallet}
            accent={accent}
          >
            {render(c)}
          </StatPanel>
        ))}
      </div>
    </div>
  );
}

function CreatorHeader({ creator: c }: { creator: CompareCreatorRow }) {
  return (
    <Link
      href={`/creator-hub/creators/${c.id}`}
      className="group flex items-center gap-3 rounded-2xl border bg-card p-4 transition-colors hover:border-border/80 hover:bg-accent/30"
    >
      <Avatar className="size-12 shrink-0">
        {c.image && <AvatarImage src={c.image} alt="" />}
        <AvatarFallback className="bg-pink-500/15 text-sm font-semibold text-pink-700 dark:text-pink-300">
          {initials(c.username)}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-base font-semibold group-hover:underline">
            {c.username ?? "Unknown"}
          </span>
          {c.isLive && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
              LIVE
            </span>
          )}
        </div>
        {c.code ? (
          <span className="mt-0.5 inline-flex rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
            {c.code}
          </span>
        ) : (
          <span className="mt-0.5 block text-[11px] text-muted-foreground">
            No code yet
          </span>
        )}
      </div>
      {c.dealStatus && (
        <Badge
          variant="outline"
          className={cn("shrink-0 capitalize", dealStatusClass(c.dealStatus))}
        >
          {c.dealStatus}
        </Badge>
      )}
    </Link>
  );
}

function CompareHighlights({ creators }: { creators: CompareCreatorRow[] }) {
  const bestRoR = pickExtreme(creators, (c) => c.rateOfReturn, "max");
  const bestPnl = pickExtreme(creators, (c) => c.lifetimePnlUsd, "max");
  const mostFtds = pickExtreme(creators, (c) => c.ftds, "max");

  if (!bestRoR && !bestPnl && !mostFtds) return null;

  return (
    <div className="space-y-3">
      <SectionHeading icon={BadgeDollarSign} title="Quick read" />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {bestRoR && (
          <HighlightTile
            label="Best rate of return"
            name={bestRoR.username}
            value={formatRoR(bestRoR.rateOfReturn)}
            accent="emerald"
          />
        )}
        {bestPnl && (
          <HighlightTile
            label="Best lifetime PnL"
            name={bestPnl.username}
            value={
              bestPnl.lifetimePnlUsd != null
                ? formatCompactUsd(bestPnl.lifetimePnlUsd)
                : "—"
            }
            accent="emerald"
          />
        )}
        {mostFtds && (
          <HighlightTile
            label="Most FTDs"
            name={mostFtds.username}
            value={formatNumber(mostFtds.ftds)}
            accent="blue"
          />
        )}
      </div>
    </div>
  );
}

function HighlightTile({
  label,
  name,
  value,
  accent,
}: {
  label: string;
  name: string | null;
  value: string;
  accent: "emerald" | "blue";
}) {
  const color =
    accent === "emerald"
      ? "text-emerald-600 dark:text-emerald-400"
      : "text-blue-600 dark:text-blue-400";
  return (
    <div className="rounded-xl border bg-card p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className={cn("mt-1 text-lg font-bold tabular-nums", color)}>{value}</p>
      <p className="mt-0.5 truncate text-xs text-muted-foreground">
        {name ?? "Unknown"}
      </p>
    </div>
  );
}

function pickExtreme(
  creators: CompareCreatorRow[],
  get: (c: CompareCreatorRow) => number | null,
  mode: "max" | "min",
): CompareCreatorRow | null {
  let best: CompareCreatorRow | null = null;
  let bestVal = mode === "max" ? -Infinity : Infinity;
  for (const c of creators) {
    const v = get(c);
    if (v == null || !Number.isFinite(v)) continue;
    if (mode === "max" ? v > bestVal : v < bestVal) {
      bestVal = v;
      best = c;
    }
  }
  return best;
}

function signedHouseClass(value: number | null): string {
  if (value == null || value === 0) return "text-muted-foreground";
  return value > 0
    ? "text-emerald-600 dark:text-emerald-400"
    : "text-rose-600 dark:text-rose-400";
}

function formatRoR(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v.toFixed(2)}×`;
}

function rorClass(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "text-muted-foreground";
  return v >= 1
    ? "font-semibold text-emerald-600 dark:text-emerald-400"
    : "font-semibold text-rose-600 dark:text-rose-400";
}

function pnlVsDealRatio(
  pnl: number | null,
  dealSpend: number,
): number | null {
  if (pnl == null || dealSpend <= 0) return null;
  return pnl / dealSpend;
}

function formatPnlVsDeal(pnl: number | null, dealSpend: number): string {
  const ratio = pnlVsDealRatio(pnl, dealSpend);
  if (ratio == null || !Number.isFinite(ratio)) return "—";
  return `${ratio.toFixed(2)}×`;
}

function dealStatusClass(status: string): string {
  const map: Record<string, string> = {
    active:
      "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    scheduled:
      "border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400",
    completed: "border-muted bg-muted/50 text-muted-foreground",
    terminated:
      "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400",
  };
  return map[status] ?? "";
}

function initials(name: string | null): string {
  const clean = (name ?? "").trim();
  if (!clean) return "?";
  return clean.slice(0, 2).toUpperCase();
}
