"use client";

import { useMemo, useState, useRef } from "react";
import { feature } from "topojson-client";
import { geoMercator, geoPath, geoCentroid } from "d3-geo";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import type { Topology, GeometryCollection } from "topojson-specification";
import countriesTopo from "world-atlas/countries-110m.json";
import countries from "i18n-iso-countries";
import type { CountryUserCount } from "@/lib/queries/map";
import { formatCurrency } from "@/lib/utils/format";
import {
  METRIC_META,
  metricValue,
  type MapMetric,
} from "./utils";

// world-atlas ships countries-110m.json as a TopoJSON Topology.
// Convert it to a GeoJSON FeatureCollection once at module load.
const typedTopo = countriesTopo as unknown as Topology<{
  countries: GeometryCollection<{ name: string }>;
}>;
const worldFeatures = feature(
  typedTopo,
  typedTopo.objects.countries,
) as unknown as FeatureCollection<Geometry, { name: string }>;

type WorldFeature = Feature<Geometry, { name: string }>;

// Viewbox size — SVG scales responsively to fill parent width.
const VIEW_W = 960;
const VIEW_H = 520;

// How many countries get a pulsing ripple (the spots that stand out most
// for the selected metric). Kept small so the map stays calm.
const RIPPLE_COUNT = 6;

type CountryMatch = {
  count: number;
  dbName: string | null;
  totalDeposits: number;
  depositCount: number;
  totalWager: number;
  alpha2: string;
  /** Pre-computed metric value for the currently active metric. */
  metricValue: number;
};

type HoverState = {
  name: string;
  count: number;
  totalDeposits: number;
  depositCount: number;
  totalWager: number;
  clientX: number;
  clientY: number;
};

/**
 * Choropleth color stop for the selected metric — we keep four OKLCH
 * ramps that match the `TILE_COLORS` accents used elsewhere on the
 * page. The gradient endpoints render both at low (25%) and high (100%)
 * density, interpolated per-country.
 */
const METRIC_COLOR: Record<MapMetric, { base: string; glow: string }> = {
  users:       { base: "oklch(0.68 0.16 237)", glow: "oklch(0.72 0.19 237)" },
  deposits:    { base: "oklch(0.65 0.16 155)", glow: "oklch(0.72 0.19 155)" },
  wagers:      { base: "oklch(0.68 0.14 200)", glow: "oklch(0.74 0.17 200)" },
  multiplier:  { base: "oklch(0.72 0.15 75)",  glow: "oklch(0.78 0.18 75)"  },
};

export function WorldMap({
  data,
  metric,
}: {
  data: CountryUserCount[];
  metric: MapMetric;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<HoverState | null>(null);

  // Map: numeric ISO (string, matching world-atlas feature.id) -> country data
  // Pre-computes the selected metric value so the render loop stays hot.
  const byNumericId = useMemo(() => {
    const m = new Map<string, CountryMatch>();
    for (const entry of data) {
      const numeric = countries.alpha2ToNumeric(entry.country_code);
      if (!numeric) continue;
      m.set(numeric, {
        count: entry.user_count,
        dbName: entry.country,
        totalDeposits: entry.total_deposits,
        depositCount: entry.deposit_count,
        totalWager: entry.total_wager,
        alpha2: entry.country_code,
        metricValue: metricValue(entry, metric),
      });
    }
    return m;
  }, [data, metric]);

  // Max for the currently-selected metric — drives both fill intensity
  // and which countries deserve a ripple. Recomputes on metric change.
  const maxForMetric = useMemo(() => {
    let max = 0;
    for (const entry of data) {
      const v = metricValue(entry, metric);
      if (v > max) max = v;
    }
    return max;
  }, [data, metric]);

  // Build a d3 projection that fits the viewbox using geoMercator's auto-fit,
  // then derive the path generator from it.
  const { pathGen, projection } = useMemo(() => {
    const proj = geoMercator().fitExtent(
      [
        [10, 10],
        [VIEW_W - 10, VIEW_H - 10],
      ],
      worldFeatures,
    );
    return { pathGen: geoPath(proj), projection: proj };
  }, []);

  // Top-N countries by the current metric, resolved to pixel coords for
  // the ripple overlay. We rebuild per metric swap so the ripples always
  // highlight the "hottest" spots for what's being shown.
  const ripples = useMemo(() => {
    const sorted = [...data]
      .filter((d) => metricValue(d, metric) > 0)
      .sort((a, b) => metricValue(b, metric) - metricValue(a, metric))
      .slice(0, RIPPLE_COUNT);

    return sorted
      .map((entry) => {
        const numeric = countries.alpha2ToNumeric(entry.country_code);
        if (!numeric) return null;
        const feat = worldFeatures.features.find(
          (f) => (f.id != null ? String(f.id) : "") === numeric,
        );
        if (!feat) return null;
        const centroid = geoCentroid(feat);
        const px = projection(centroid as [number, number]);
        if (!px) return null;
        const value = metricValue(entry, metric);
        const intensity = maxForMetric > 0 ? value / maxForMetric : 0;
        return {
          id: entry.country_code,
          name: entry.country ?? feat.properties.name,
          cx: px[0],
          cy: px[1],
          intensity,
          value,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
  }, [data, metric, projection, maxForMetric]);

  // Log-scaled intensity so one huge country doesn't flatten everything
  // else. For multiplier we use linear — values there are already on a
  // naturally bounded scale (typically 0–30×).
  function intensityFor(value: number): number {
    if (value <= 0 || maxForMetric <= 0) return 0;
    if (metric === "multiplier") return value / maxForMetric;
    return Math.log(value + 1) / Math.log(maxForMetric + 1);
  }

  const metricColor = METRIC_COLOR[metric];

  return (
    <div
      ref={containerRef}
      className="relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-card/60 p-4"
      onMouseLeave={() => setHover(null)}
    >
      {/* Ambient corner glows — match the PageHero chrome */}
      <div
        aria-hidden
        className="pointer-events-none absolute -right-24 -top-24 size-72 rounded-full bg-blue-500/[0.05] blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -left-24 -bottom-24 size-72 rounded-full bg-purple-500/[0.05] blur-3xl"
      />

      <div className="relative">
        <svg
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          className="h-auto w-full"
          role="img"
          aria-label={`World map — ${METRIC_META[metric].label.toLowerCase()} by country`}
        >
          <defs>
            {/* Gentle radial gradient used for the ripple dot itself. */}
            <radialGradient id="pulse-gradient">
              <stop offset="0%" stopColor={metricColor.glow} stopOpacity={1} />
              <stop offset="70%" stopColor={metricColor.glow} stopOpacity={0.4} />
              <stop offset="100%" stopColor={metricColor.glow} stopOpacity={0} />
            </radialGradient>
          </defs>

          {/* Ocean / background */}
          <rect width={VIEW_W} height={VIEW_H} className="fill-muted/30" />

          {/* Choropleth layer */}
          {worldFeatures.features.map((feat: WorldFeature) => {
            const numericId = feat.id != null ? String(feat.id) : "";
            const match = byNumericId.get(numericId);
            const value = match?.metricValue ?? 0;
            const displayName = match?.dbName ?? feat.properties.name;
            const d = pathGen(feat) ?? "";
            const intensity = intensityFor(value);
            const hasValue = value > 0;

            return (
              <path
                key={numericId || feat.properties.name}
                d={d}
                className={
                  hasValue
                    ? "stroke-border transition-[fill-opacity] duration-300 hover:opacity-80"
                    : "fill-muted/60 stroke-border transition-opacity hover:opacity-80"
                }
                style={
                  hasValue
                    ? {
                        fill: metricColor.base,
                        fillOpacity: 0.18 + intensity * 0.82,
                      }
                    : undefined
                }
                strokeWidth={0.5}
                onMouseMove={(e) => {
                  setHover({
                    name: displayName,
                    count: match?.count ?? 0,
                    totalDeposits: match?.totalDeposits ?? 0,
                    depositCount: match?.depositCount ?? 0,
                    totalWager: match?.totalWager ?? 0,
                    clientX: e.clientX,
                    clientY: e.clientY,
                  });
                }}
              />
            );
          })}

          {/* Ripple layer — rendered after paths so it sits above the
              choropleth. Each ripple is one persistent dot + two
              staggered expanding rings that fade out. Ring animation is
              SMIL (works everywhere Next.js targets) and respects
              prefers-reduced-motion via the parent wrapper class.
              pointer-events-none so ripples never block country hover. */}
          <g className="motion-reduce:hidden pointer-events-none">
            {ripples.map((r, i) => {
              // 3 + intensity-scaled 0..6 px dot — bigger = "hotter"
              const dotR = 2.5 + r.intensity * 4;
              // Rings expand from dotR to ~14 px, staggered per index
              const begin = `${(i * 0.35).toFixed(2)}s`;
              return (
                <g key={r.id}>
                  <circle
                    cx={r.cx}
                    cy={r.cy}
                    r={dotR + 8}
                    fill="url(#pulse-gradient)"
                    opacity={0.25}
                  />
                  <circle
                    cx={r.cx}
                    cy={r.cy}
                    r={dotR}
                    fill={metricColor.glow}
                    stroke={metricColor.glow}
                    strokeWidth={0.5}
                  />
                  {/* Expanding ring */}
                  <circle
                    cx={r.cx}
                    cy={r.cy}
                    r={dotR}
                    fill="none"
                    stroke={metricColor.glow}
                    strokeWidth={1.2}
                  >
                    <animate
                      attributeName="r"
                      from={dotR}
                      to={dotR + 14}
                      dur="2.4s"
                      begin={begin}
                      repeatCount="indefinite"
                    />
                    <animate
                      attributeName="opacity"
                      from="0.7"
                      to="0"
                      dur="2.4s"
                      begin={begin}
                      repeatCount="indefinite"
                    />
                  </circle>
                </g>
              );
            })}
          </g>

          {/* Static dots for reduce-motion users */}
          <g className="hidden motion-reduce:block pointer-events-none">
            {ripples.map((r) => (
              <circle
                key={`static-${r.id}`}
                cx={r.cx}
                cy={r.cy}
                r={2.5 + r.intensity * 4}
                fill={metricColor.glow}
              />
            ))}
          </g>
        </svg>

        {hover && containerRef.current && (
          <TooltipOverlay hover={hover} container={containerRef.current} />
        )}

        {/* Legend — reflects the active metric's ramp. */}
        <div className="mt-4 flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <span
              className="inline-block size-2 rounded-full"
              style={{
                background: metricColor.glow,
                boxShadow: `0 0 8px ${metricColor.glow}`,
              }}
            />
            <span className="text-foreground/80 font-medium">
              {METRIC_META[metric].label}
            </span>
            <span className="text-muted-foreground">
              · pulsing dots = top {RIPPLE_COUNT} markets
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span>Low</span>
            <div
              className="h-2 w-32 rounded"
              style={{
                background: `linear-gradient(to right, color-mix(in oklch, ${metricColor.base} 18%, transparent), ${metricColor.base})`,
              }}
            />
            <span>High</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function TooltipOverlay({
  hover,
  container,
}: {
  hover: HoverState;
  container: HTMLDivElement;
}) {
  const rect = container.getBoundingClientRect();
  const x = hover.clientX - rect.left;
  const y = hover.clientY - rect.top;

  const avgDeposit =
    hover.depositCount > 0 ? hover.totalDeposits / hover.depositCount : 0;
  // Wager multiplier = how many $ wagered per $ deposited. Shows how
  // "sticky" a country's users are — high multiplier means deposits
  // get churned many times before the user leaves.
  const multiplier =
    hover.totalDeposits > 0 ? hover.totalWager / hover.totalDeposits : 0;

  return (
    <div
      className="pointer-events-none absolute z-50 rounded-md bg-foreground px-3 py-2 text-xs text-background shadow-md min-w-[180px]"
      style={{
        left: x,
        top: y - 12,
        transform: "translate(-50%, -100%)",
      }}
    >
      <div className="font-semibold text-sm">{hover.name}</div>
      <div className="opacity-80 mt-0.5">
        {hover.count > 0
          ? `${hover.count.toLocaleString()} users`
          : "No users"}
      </div>
      {hover.totalDeposits > 0 || hover.totalWager > 0 ? (
        <div className="mt-1.5 pt-1.5 border-t border-background/20 space-y-0.5">
          <div className="flex justify-between gap-3">
            <span className="opacity-70">Deposits</span>
            <span className="tabular-nums font-medium">
              {formatCurrency(hover.totalDeposits)}
            </span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="opacity-70">Avg deposit</span>
            <span className="tabular-nums font-medium">
              {formatCurrency(avgDeposit)}
            </span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="opacity-70">Total wager</span>
            <span className="tabular-nums font-medium">
              {formatCurrency(hover.totalWager)}
            </span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="opacity-70">Wager / deposit</span>
            <span className="tabular-nums font-medium">
              {multiplier > 0 ? `${multiplier.toFixed(2)}×` : "—"}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
