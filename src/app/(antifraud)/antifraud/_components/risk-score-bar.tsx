import { cn } from "@/lib/utils";

const CRITICAL_SCORE = 120;

export function RiskScoreBar({
  score,
  className,
}: {
  score: number;
  className?: string;
}) {
  const position = Math.min(100, Math.max(0, (score / CRITICAL_SCORE) * 100));

  return (
    <div
      className={cn("min-w-28", className)}
      role="progressbar"
      aria-label={`Risk score ${score}`}
      aria-valuemin={0}
      aria-valuemax={CRITICAL_SCORE}
      aria-valuenow={Math.min(CRITICAL_SCORE, Math.max(0, score))}
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
        <span>40</span>
        <span>80</span>
        <span>120+</span>
      </div>
    </div>
  );
}
