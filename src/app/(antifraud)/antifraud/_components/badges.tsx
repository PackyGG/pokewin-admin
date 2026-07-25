import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  REVIEW_SEVERITY_COLORS,
  REVIEW_SEVERITY_LABELS,
  REVIEW_STATUS_COLORS,
  REVIEW_STATUS_LABELS,
  isReviewSeverity,
  isReviewStatus,
  // Isomorphic vocabulary module — NOT `@/lib/antifraud/reviews`, which is
  // server-only. These badges render inside Server Components today, but
  // importing the server module here would make them unusable from a client
  // island later without a confusing build failure.
} from "@/lib/antifraud/constants";
import { levelInfo } from "@/lib/antifraud/levels";
import { TILE_COLORS } from "@/components/modern-panels";

/**
 * Small shared badges for the Antifraud surfaces. Pure presentational (no
 * "use client" — they render inside Server Components), and every colour comes
 * from the constant maps in `@/lib/antifraud/*` or the shared `TILE_COLORS`, so
 * nothing here invents a palette.
 *
 * NOTE on colour semantics: these are RISK badges, not money badges — the
 * House-POV rule (user wins = red) governs amounts, and none of these carry
 * one. "Cleared" is emerald because a clean account is the good outcome for the
 * house; "flagged" is rose because it isn't.
 */

export function ReviewStatusBadge({ status }: { status: string }) {
  const known = isReviewStatus(status);
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-5 px-1.5 text-[10px] font-bold uppercase tracking-wide",
        known ? REVIEW_STATUS_COLORS[status] : "",
      )}
    >
      {known ? REVIEW_STATUS_LABELS[status] : status}
    </Badge>
  );
}

export function ReviewSeverityBadge({ severity }: { severity: string }) {
  const known = isReviewSeverity(severity);
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-5 px-1.5 text-[10px] font-bold uppercase tracking-wide",
        known ? REVIEW_SEVERITY_COLORS[severity] : "",
      )}
    >
      {known ? REVIEW_SEVERITY_LABELS[severity] : severity}
    </Badge>
  );
}

/** Level chip — "L4 · Analyst", accented by the level's own colour token. */
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

/** Draft / published / archived chip for the quiz surfaces. */
export function QuizStatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    draft: "bg-slate-500/15 text-slate-600 dark:text-slate-400 border-slate-500/30",
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
        map[status] ?? "",
      )}
    >
      {status}
    </Badge>
  );
}
