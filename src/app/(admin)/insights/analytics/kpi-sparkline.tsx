"use client";

import { Line, LineChart, ResponsiveContainer, YAxis } from "recharts";

/**
 * Tiny line chart embedded inside a KPI tile. No axes, no grid, no
 * tooltip — just the trend shape. Colors come from the `accent` token
 * (matched against TILE_COLORS in modern-panels.tsx) so the spark inherits
 * the tile's hue.
 *
 * The points array is expected to be small (≤180 days) so we don't need
 * any virtualization or downsampling.
 */
export function KpiSparkline({
  points,
  accent,
}: {
  points: number[];
  accent: "blue" | "emerald" | "rose" | "cyan" | "amber" | "purple" | "orange" | "pink";
}) {
  // Map TILE_COLORS-style accents to literal stroke colors. Tailwind
  // utility classes can't reach into <Line stroke=…/> directly (recharts
  // takes the raw color), so this small map gives the same set of hues.
  const stroke = (() => {
    switch (accent) {
      case "blue":
        return "rgb(59 130 246)";
      case "emerald":
        return "rgb(16 185 129)";
      case "rose":
        return "rgb(244 63 94)";
      case "cyan":
        return "rgb(6 182 212)";
      case "amber":
        return "rgb(245 158 11)";
      case "purple":
        return "rgb(168 85 247)";
      case "orange":
        return "rgb(249 115 22)";
      case "pink":
        return "rgb(236 72 153)";
    }
  })();

  // recharts wants object data — wrap each scalar.
  const data = points.map((v, i) => ({ i, v }));

  if (data.length < 2) {
    return <div className="h-7 w-full" />;
  }

  return (
    <div className="h-7 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 2, right: 0, left: 0, bottom: 2 }}>
          {/* YAxis hidden but with `domain={["dataMin", "dataMax"]}` so
              flat-but-non-zero series still show movement. */}
          <YAxis hide domain={["dataMin", "dataMax"]} />
          <Line
            type="monotone"
            dataKey="v"
            stroke={stroke}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
