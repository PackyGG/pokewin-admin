import { cn } from "@/lib/utils";
import { TILE_COLORS } from "@/components/modern-panels";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { PROGRAM_META, MONEY_OUT } from "./program-meta";
import type { RewardProgramRow } from "@/lib/queries/insights-rewards/program-spend";

/**
 * Inline SVG sparkline. Server-rendered — 7 of these on the overview would
 * be 7 recharts instances and a chunk of client JS for a decoration; a
 * polyline costs nothing and looks identical at this size.
 *
 * Flat-baseline series (a single point, or all-equal values) render as a
 * centred straight line rather than dividing by zero.
 */
function Sparkline({
  points,
  color,
  className,
}: {
  points: Array<{ date: string; total: number }>;
  color: string;
  className?: string;
}) {
  if (points.length === 0) return null;
  const W = 100;
  const H = 24;
  const values = points.map((p) => p.total);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min;
  const step = points.length > 1 ? W / (points.length - 1) : 0;
  const y = (v: number) =>
    span === 0 ? H / 2 : H - 2 - ((v - min) / span) * (H - 4);
  const path = points
    .map((p, i) => `${(i * step).toFixed(2)},${y(p.total).toFixed(2)}`)
    .join(" ");

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      className={cn("h-6 w-full", className)}
    >
      {points.length === 1 ? (
        <line
          x1={0}
          y1={H / 2}
          x2={W}
          y2={H / 2}
          stroke={color}
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
        />
      ) : (
        <polyline
          points={path}
          fill="none"
          stroke={color}
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}

/**
 * One reward program at a glance.
 *
 * Flat tile per the house standard: a single `bg-card` surface, hairline
 * border, no gradient fill or glow. The program's hue survives only on the
 * icon; the money figure is rose because House-POV makes every payout here a
 * cost, whatever program it came from.
 *
 * The residual ("Other house credits") renders `muted`: same layout, dimmed
 * surface and a lighter label, so it reads as context under the seven real
 * programs rather than an eighth one.
 */
export function ProgramCard({
  row,
  muted = false,
}: {
  row: RewardProgramRow;
  muted?: boolean;
}) {
  const meta = PROGRAM_META[row.key];
  const Icon = meta.icon;

  return (
    <div
      className={cn(
        "flex h-full flex-col rounded-lg border bg-card p-3.5",
        muted && "border-dashed bg-muted/30",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Icon
            className={cn(
              "size-4 shrink-0",
              muted ? "text-muted-foreground" : TILE_COLORS[meta.accent].icon,
            )}
          />
          <p className="truncate text-sm font-semibold">{row.label}</p>
        </div>
        <span className="shrink-0 text-[11px] font-medium tabular-nums text-muted-foreground">
          {row.share.toFixed(1)}%
        </span>
      </div>

      <p
        className={cn(
          "mt-2 text-2xl font-bold tabular-nums",
          muted ? "text-muted-foreground" : MONEY_OUT,
        )}
      >
        {formatCurrency(row.total)}
      </p>

      <p className="mt-0.5 text-[11px] text-muted-foreground">
        {formatNumber(row.count)} payout{row.count === 1 ? "" : "s"} ·{" "}
        {formatNumber(row.claimants)} player{row.claimants === 1 ? "" : "s"}
      </p>

      {/* Share bar — the same 0–100% scale across every card, so the visual
          weights compare directly without reading the numbers. */}
      <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full",
            muted ? "bg-muted-foreground/40" : "bg-rose-500/70",
          )}
          style={{ width: `${Math.min(100, row.share)}%` }}
        />
      </div>

      <div className="mt-auto pt-2.5">
        <Sparkline
          points={row.dailySeries}
          color={muted ? "#94a3b8" : meta.chartColor}
        />
        <div className="mt-1.5 flex items-center justify-between gap-2 border-t pt-1.5 text-[11px] text-muted-foreground">
          <span className="tabular-nums">
            {formatCurrency(row.avgPerClaimant)} / player
          </span>
          <span className="tabular-nums">
            {formatCurrency(row.avgPerPayout)} / payout
          </span>
        </div>
      </div>
    </div>
  );
}
