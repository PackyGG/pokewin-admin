"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/lib/utils/format";
import type {
  BattleModeStats,
  PackPopularityStats,
} from "@/lib/queries/analytics";

const CHART_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

const tooltipStyle = {
  background: "var(--popover)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  fontSize: "12px",
  padding: "6px 10px",
  boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
};
const tooltipItemStyle = { color: "var(--foreground)" };
const tooltipLabelStyle = { color: "var(--muted-foreground)", marginBottom: 2 };

/**
 * Trigger + content live inside ONE continuous bordered/rounded box — the
 * header fills the top, a `border-t` divider marks the seam, the content
 * fills the rest — so an open section visibly reads as "this content
 * belongs to this header" instead of two disconnected floating blocks.
 */
function CollapsibleSection({
  title,
  defaultOpen = true,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn(
        "overflow-hidden rounded-lg border transition-colors",
        open ? "border-primary/25" : "border-border/60 hover:border-border",
      )}
    >
      <CollapsibleTrigger
        className={cn(
          "flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-sm font-medium transition-colors",
          open
            ? "bg-primary/10 text-foreground hover:bg-primary/15"
            : "bg-muted/30 text-muted-foreground hover:bg-muted/50 hover:text-foreground",
        )}
      >
        <ChevronDown
          className={cn(
            "size-4 shrink-0 motion-safe:transition-transform motion-safe:duration-200",
            open ? "rotate-0 text-primary" : "-rotate-90",
          )}
        />
        {title}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t border-primary/15 px-3 py-3">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function StatRow({
  label,
  count,
  total,
  color,
}: {
  label: string;
  count: number;
  total: number;
  color?: string;
}) {
  const pct = total > 0 ? (count / total) * 100 : 0;
  return (
    <div className="flex items-center gap-3 py-1 text-sm">
      {color && (
        <span
          className="size-2 shrink-0 rounded-full"
          style={{ background: color }}
        />
      )}
      <span className="flex-1 truncate capitalize">
        {label.replace(/_/g, " ")}
      </span>
      <span className="w-12 text-right text-xs text-muted-foreground tabular-nums">
        {pct.toFixed(1)}%
      </span>
      <span className="w-12 text-right font-medium tabular-nums">
        {formatNumber(count)}
      </span>
    </div>
  );
}

export function BattleModesSection({ stats }: { stats: BattleModeStats }) {
  const total = stats.totalBattles;

  const modeChartData = stats.byMode.map((m, i) => ({
    name: m.mode.replace(/_/g, " "),
    value: m.count,
    fill: CHART_COLORS[i % CHART_COLORS.length],
  }));

  const formatChartData = stats.byFormat.map((f, i) => ({
    name: f.format,
    value: f.count,
    fill: CHART_COLORS[i % CHART_COLORS.length],
  }));

  const topBattlePacksTotal = stats.topBattlePacks.reduce(
    (a, x) => a + x.count,
    0,
  );

  return (
    <CollapsibleSection title={`Battles (${formatNumber(total)} total)`}>
      <Card>
        <CardContent className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
          {/* By Mode — donut + list */}
          <div>
            <h4 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
              By Mode
            </h4>
            <div className="mb-2 h-[120px]">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={modeChartData}
                    innerRadius={36}
                    outerRadius={56}
                    paddingAngle={2}
                    dataKey="value"
                    stroke="none"
                    animationDuration={700}
                    animationEasing="ease-out"
                  >
                    {modeChartData.map((entry, i) => (
                      <Cell key={i} fill={entry.fill} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={tooltipStyle}
                    itemStyle={tooltipItemStyle}
                    labelStyle={tooltipLabelStyle}
                    formatter={(value) => [formatNumber(Number(value)), ""]}
                    separator=""
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div>
              {modeChartData.length === 0 && (
                <p className="text-xs text-muted-foreground">No data</p>
              )}
              {modeChartData.map((m) => (
                <StatRow
                  key={m.name}
                  label={m.name}
                  count={m.value}
                  total={total}
                  color={m.fill}
                />
              ))}
            </div>
          </div>

          {/* Format — donut + list */}
          <div>
            <h4 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
              Format
            </h4>
            <div className="mb-2 h-[120px]">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={formatChartData}
                    innerRadius={36}
                    outerRadius={56}
                    paddingAngle={2}
                    dataKey="value"
                    stroke="none"
                    animationDuration={700}
                    animationEasing="ease-out"
                  >
                    {formatChartData.map((entry, i) => (
                      <Cell key={i} fill={entry.fill} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={tooltipStyle}
                    itemStyle={tooltipItemStyle}
                    labelStyle={tooltipLabelStyle}
                    formatter={(value) => [formatNumber(Number(value)), ""]}
                    separator=""
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div>
              {formatChartData.length === 0 && (
                <p className="text-xs text-muted-foreground">No data</p>
              )}
              {formatChartData.map((f) => (
                <StatRow
                  key={f.name}
                  label={f.name}
                  count={f.value}
                  total={total}
                  color={f.fill}
                />
              ))}
            </div>
          </div>

          {/* Settings & flags */}
          <div>
            <h4 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
              Settings
            </h4>
            {stats.bySetting.length === 0 && (
              <p className="text-xs text-muted-foreground">No data</p>
            )}
            {stats.bySetting.map((s) => (
              <StatRow
                key={s.setting}
                label={s.setting}
                count={s.count}
                total={total}
              />
            ))}
            <div className="mt-3 border-t pt-2">
              <StatRow label="borrow" count={stats.borrowCount} total={total} />
              <StatRow
                label="sponsored"
                count={stats.sponsoredCount}
                total={total}
              />
              <StatRow label="private" count={stats.privateCount} total={total} />
            </div>
          </div>

          {/* Top battle packs */}
          <div>
            <h4 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
              Top Battle Packs
            </h4>
            {stats.topBattlePacks.length === 0 && (
              <p className="text-xs text-muted-foreground">No data</p>
            )}
            {stats.topBattlePacks.map((p) => (
              <StatRow
                key={p.id}
                label={p.name}
                count={p.count}
                total={topBattlePacksTotal}
              />
            ))}
          </div>
        </CardContent>
      </Card>
    </CollapsibleSection>
  );
}

function PackBar({
  name,
  cash,
  borrowed,
  maxValue,
}: {
  name: string;
  cash: number;
  borrowed: number;
  maxValue: number;
}) {
  const cashPct = maxValue > 0 ? (cash / maxValue) * 100 : 0;
  const borrowedPct = maxValue > 0 ? (borrowed / maxValue) * 100 : 0;
  // 140px label column was too generous at 360px viewports. Drop to
  // 100px on phones so the bars + counts get the rest of the row.
  return (
    <div className="grid grid-cols-[100px_1fr] items-center gap-3 py-1.5 sm:grid-cols-[140px_1fr]">
      <span className="truncate text-xs" title={name}>
        {name}
      </span>
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <div className="relative h-2 flex-1 overflow-hidden rounded-sm bg-muted">
            <div
              className="h-full rounded-sm bg-[var(--chart-1)] transition-all"
              style={{ width: `${cashPct}%` }}
            />
          </div>
          <span className="w-12 text-right text-[11px] tabular-nums text-muted-foreground sm:w-14">
            {formatNumber(cash)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative h-2 flex-1 overflow-hidden rounded-sm bg-muted">
            <div
              className="h-full rounded-sm bg-[var(--chart-4)] transition-all"
              style={{ width: `${borrowedPct}%` }}
            />
          </div>
          <span className="w-12 text-right text-[11px] tabular-nums text-muted-foreground sm:w-14">
            {formatNumber(borrowed)}
          </span>
        </div>
      </div>
    </div>
  );
}

export function PackPopularitySection({ stats }: { stats: PackPopularityStats }) {
  const totalOpens = stats.topPacks.reduce((a, p) => a + p.opensTotal, 0);
  const totalBorrowed = stats.topPacks.reduce(
    (a, p) => a + p.opensBorrowed,
    0,
  );
  const topPacks = stats.topPacks.slice(0, 8);
  const maxValue = Math.max(
    ...topPacks.flatMap((p) => [p.opensNormal, p.opensBorrowed]),
    1,
  );

  return (
    <CollapsibleSection
      title={`Packs — Solo Openings (${formatNumber(totalOpens)} total)`}
    >
      <Card>
        <CardContent className="space-y-6">
          {/* Top packs — two thin bars per pack (cash + borrowed) */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <h4 className="text-xs font-semibold uppercase text-muted-foreground">
                Top Packs
              </h4>
              <div className="flex items-center gap-4 text-[11px] text-muted-foreground">
                <div className="flex items-center gap-1.5">
                  <span className="size-2 rounded-sm bg-[var(--chart-1)]" />
                  Cash
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="size-2 rounded-sm bg-[var(--chart-4)]" />
                  Borrowed
                </div>
              </div>
            </div>
            {topPacks.length === 0 && (
              <p className="text-xs text-muted-foreground">No data</p>
            )}
            <div className="space-y-0.5">
              {topPacks.map((p) => (
                <PackBar
                  key={p.id}
                  name={p.name}
                  cash={p.opensNormal}
                  borrowed={p.opensBorrowed}
                  maxValue={maxValue}
                />
              ))}
            </div>
          </div>

          {/* Two lists side-by-side */}
          <div className="grid gap-6 md:grid-cols-2">
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
                Most Popular
              </h4>
              {stats.topPacks.length === 0 && (
                <p className="text-xs text-muted-foreground">No data</p>
              )}
              {stats.topPacks.map((p) => (
                <StatRow
                  key={p.id}
                  label={p.name}
                  count={p.opensTotal}
                  total={totalOpens}
                />
              ))}
            </div>
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
                Most Popular with Borrow
              </h4>
              {totalBorrowed === 0 && (
                <p className="text-xs text-muted-foreground">No borrowed opens</p>
              )}
              {stats.topPacks
                .filter((p) => p.opensBorrowed > 0)
                .sort((a, b) => b.opensBorrowed - a.opensBorrowed)
                .map((p) => (
                  <StatRow
                    key={p.id}
                    label={p.name}
                    count={p.opensBorrowed}
                    total={totalBorrowed}
                  />
                ))}
            </div>
          </div>
        </CardContent>
      </Card>
    </CollapsibleSection>
  );
}
