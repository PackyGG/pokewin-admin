import { formatNumber } from "@/lib/utils/format";

const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/**
 * 7-day × 24-hour heatmap grid (UTC).
 *
 * Server component — no chart library dependency. Each cell's
 * background intensity is a linear function of the cell's count
 * relative to the matrix maximum (rose tint, alpha 5-85%).
 *
 * Cell labels are hidden by default; a 11px count chip surfaces only
 * for cells > 0 so the grid stays readable.
 */
export function HeatmapGrid({
  cells,
}: {
  cells: Array<{ dow: number; hour: number; count: number; volume: number }>;
}) {
  // Pre-fill matrix so missing (dow, hour) pairs still render as
  // empty cells. Re-uses any pre-zero-filled cells from the helper.
  const matrix: Array<Array<{ count: number; volume: number }>> = Array.from(
    { length: 7 },
    () => Array.from({ length: 24 }, () => ({ count: 0, volume: 0 })),
  );
  for (const c of cells) {
    if (c.dow >= 0 && c.dow < 7 && c.hour >= 0 && c.hour < 24) {
      matrix[c.dow][c.hour].count += c.count;
      matrix[c.dow][c.hour].volume += c.volume;
    }
  }
  const max = cells.reduce((acc, c) => Math.max(acc, c.count), 0);

  return (
    <div className="overflow-x-auto">
      <div className="inline-block min-w-full">
        {/* Hour header */}
        <div className="grid grid-cols-[40px_repeat(24,minmax(18px,1fr))] gap-0.5 text-[10px] text-muted-foreground">
          <span />
          {Array.from({ length: 24 }, (_, h) => (
            <span key={h} className="text-center tabular-nums">
              {h % 3 === 0 ? h.toString().padStart(2, "0") : ""}
            </span>
          ))}
        </div>
        {/* Rows */}
        {matrix.map((row, dow) => (
          <div
            key={dow}
            className="mt-0.5 grid grid-cols-[40px_repeat(24,minmax(18px,1fr))] gap-0.5"
          >
            <span className="flex items-center text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {DOW_LABELS[dow]}
            </span>
            {row.map((cell, hour) => {
              const intensity = max > 0 ? cell.count / max : 0;
              const alpha = Math.round(5 + intensity * 80); // 5–85%
              const bg = cell.count === 0
                ? "rgba(120,120,140,0.06)"
                : `rgba(244, 63, 94, ${alpha / 100})`;
              return (
                <div
                  key={hour}
                  title={`${DOW_LABELS[dow]} · ${hour.toString().padStart(2, "0")}:00 UTC · ${formatNumber(cell.count)} claims`}
                  className="aspect-square min-h-[18px] rounded-sm border border-border/30"
                  style={{ background: bg }}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
