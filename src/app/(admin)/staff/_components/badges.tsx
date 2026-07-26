import { Badge } from "@/components/ui/badge";
import { TILE_COLORS } from "@/components/modern-panels";
import { cn } from "@/lib/utils";
import { levelInfo } from "@/lib/staff/levels";

export function StaffLevelBadge({
  level,
  className,
}: {
  level: number;
  className?: string;
}) {
  const info = levelInfo(level);
  const tile = TILE_COLORS[info.accent];
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-5 gap-1 px-1.5 text-[10px] font-bold uppercase tracking-wide",
        tile.bg,
        tile.text,
        className,
      )}
    >
      <span>L{info.level}</span>
      <span className="font-semibold opacity-80">{info.title}</span>
    </Badge>
  );
}

export function QuizStatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    draft:
      "bg-slate-500/15 text-slate-600 dark:text-slate-400 border-slate-500/30",
    published:
      "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
    archived:
      "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
  };
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-5 px-1.5 text-[10px] font-bold uppercase tracking-wide",
        styles[status] ?? "",
      )}
    >
      {status}
    </Badge>
  );
}
