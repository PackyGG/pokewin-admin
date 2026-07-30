import { cn } from "@/lib/utils";

const MAX_RISK_SCORE = 100;

export function RiskScoreBar({
  score,
  max = MAX_RISK_SCORE,
  className,
}: {
  score: number;
  max?: number;
  className?: string;
}) {
  const safeMax = Math.max(1, max);
  const boundedScore = Math.max(0, Math.min(safeMax, score));
  const position = Math.min(100, Math.max(0, (boundedScore / safeMax) * 100));

  return (
    <div
      className={cn("min-w-28", className)}
      role="progressbar"
      aria-label={`Risk score ${boundedScore}`}
      aria-valuemin={0}
      aria-valuemax={safeMax}
      aria-valuenow={Math.min(safeMax, Math.max(0, score))}
    >
      <div className="relative h-2 rounded-full bg-gradient-to-r from-emerald-500 via-amber-400 to-rose-500">
        <span
          aria-hidden
          className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-foreground shadow-sm transition-[left] duration-300"
          style={{ left: `${position}%` }}
        />
      </div>
      <div className="mt-1 flex justify-between text-[9px] font-medium tabular-nums text-muted-foreground">
        <span>0</span>
        <span>{Math.round(safeMax / 3)}</span>
        <span>{Math.round((safeMax * 2) / 3)}</span>
        <span>{safeMax}</span>
      </div>
    </div>
  );
}
