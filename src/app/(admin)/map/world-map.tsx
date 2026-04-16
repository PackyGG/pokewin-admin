"use client";

import { useMemo, useState, useRef } from "react";
import { feature } from "topojson-client";
import { geoMercator, geoPath } from "d3-geo";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import type { Topology, GeometryCollection } from "topojson-specification";
import countriesTopo from "world-atlas/countries-110m.json";
import countries from "i18n-iso-countries";
import type { CountryUserCount } from "@/lib/queries/map";
import { formatCurrency } from "@/lib/utils/format";

// world-atlas ships countries-110m.json as a TopoJSON Topology.
// Convert it to a GeoJSON FeatureCollection once at module load.
const typedTopo = countriesTopo as unknown as Topology<{
  countries: GeometryCollection<{ name: string }>;
}>;
const worldFeatures = feature(
  typedTopo,
  typedTopo.objects.countries
) as unknown as FeatureCollection<Geometry, { name: string }>;

type WorldFeature = Feature<Geometry, { name: string }>;

// Viewbox size — SVG scales responsively to fill parent width.
const VIEW_W = 960;
const VIEW_H = 520;

type HoverState = {
  name: string;
  count: number;
  totalDeposits: number;
  depositCount: number;
  totalWager: number;
  clientX: number;
  clientY: number;
};

export function WorldMap({ data }: { data: CountryUserCount[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<HoverState | null>(null);

  // Map: numeric ISO (string, matching world-atlas feature.id) -> country data
  const byNumericId = useMemo(() => {
    const m = new Map<
      string,
      {
        count: number;
        dbName: string | null;
        totalDeposits: number;
        depositCount: number;
        totalWager: number;
      }
    >();
    for (const entry of data) {
      const numeric = countries.alpha2ToNumeric(entry.country_code);
      if (!numeric) continue;
      m.set(numeric, {
        count: entry.user_count,
        dbName: entry.country,
        totalDeposits: entry.total_deposits,
        depositCount: entry.deposit_count,
        totalWager: entry.total_wager,
      });
    }
    return m;
  }, [data]);

  const maxCount = useMemo(
    () => data.reduce((acc, d) => (d.user_count > acc ? d.user_count : acc), 0),
    [data]
  );

  // Build a d3 projection that fits the viewbox using geoMercator's auto-fit,
  // then derive the path generator from it.
  const pathGen = useMemo(() => {
    const proj = geoMercator().fitExtent(
      [
        [10, 10],
        [VIEW_W - 10, VIEW_H - 10],
      ],
      worldFeatures
    );
    return geoPath(proj);
  }, []);

  // Log-scaled intensity so one huge country doesn't flatten everything else.
  function intensityFor(count: number): number {
    if (count <= 0 || maxCount <= 0) return 0;
    return Math.log(count + 1) / Math.log(maxCount + 1);
  }

  return (
    <div
      ref={containerRef}
      className="relative rounded-lg border bg-card p-4"
      onMouseLeave={() => setHover(null)}
    >
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className="h-auto w-full"
        role="img"
        aria-label="World map of users by country"
      >
        {/* Ocean / background */}
        <rect
          width={VIEW_W}
          height={VIEW_H}
          className="fill-muted/30"
        />

        {worldFeatures.features.map((feat: WorldFeature) => {
          const numericId = feat.id != null ? String(feat.id) : "";
          const match = byNumericId.get(numericId);
          const count = match?.count ?? 0;
          const displayName = match?.dbName ?? feat.properties.name;
          const d = pathGen(feat) ?? "";
          const intensity = intensityFor(count);
          const hasUsers = count > 0;

          return (
            <path
              key={numericId || feat.properties.name}
              d={d}
              className={
                hasUsers
                  ? "stroke-border transition-opacity hover:opacity-80"
                  : "fill-muted/60 stroke-border transition-opacity hover:opacity-80"
              }
              style={
                hasUsers
                  ? {
                      fill: "var(--chart-1)",
                      fillOpacity: 0.25 + intensity * 0.75,
                    }
                  : undefined
              }
              strokeWidth={0.5}
              onMouseMove={(e) => {
                setHover({
                  name: displayName,
                  count,
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
      </svg>

      {hover && containerRef.current && (
        <TooltipOverlay hover={hover} container={containerRef.current} />
      )}

      {/* Legend */}
      <div className="mt-4 flex items-center justify-end gap-2 text-xs text-muted-foreground">
        <span>Fewer users</span>
        <div
          className="h-2 w-32 rounded"
          style={{
            background:
              "linear-gradient(to right, color-mix(in oklch, var(--chart-1) 25%, transparent), var(--chart-1))",
          }}
        />
        <span>More users</span>
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
