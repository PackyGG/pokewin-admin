import { Suspense } from "react";
import { ClipboardList } from "lucide-react";

import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";

import { getCreatorChecklistProgress } from "../_queries/onboarding-checklist-data";

/**
 * Per-creator Onboarding Checklist — compact progress badge.
 *
 * The self-contained roster-surface companion to `<CreatorChecklist>`: a small
 * "5/8" pill the owner wants on the Hub main page (the creator's card/row).
 * Takes ONLY the creator's user id; fetches its own progress lazily.
 *
 * Behaviour:
 *   • LAZY — its read runs in its own Suspense boundary so a roster of cards
 *     doesn't block on N checklist scans; each badge resolves independently.
 *   • AUTO-HIDES — renders NOTHING once the creator is fully onboarded
 *     (`complete`), matching the full panel. A transient partial read still
 *     shows the (lower-bound) count rather than hiding.
 *
 * `compact` (default) renders just the pill for tight card corners; the fuller
 * form adds the "Onboarding" label for standalone placement.
 */
export function CreatorChecklistProgress({
  userId,
  compact = true,
  className,
}: {
  userId: string;
  compact?: boolean;
  className?: string;
}) {
  return (
    <Suspense
      fallback={<Skeleton className={cn("h-5 w-12 rounded-full", className)} />}
    >
      <CreatorChecklistProgressContent
        userId={userId}
        compact={compact}
        className={className}
      />
    </Suspense>
  );
}

async function CreatorChecklistProgressContent({
  userId,
  compact,
  className,
}: {
  userId: string;
  compact: boolean;
  className?: string;
}) {
  const progress = await getCreatorChecklistProgress(userId);

  // Auto-hide once fully onboarded or not a new creator.
  if (!progress || progress.complete) return null;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary",
        className,
      )}
      title={`Onboarding: ${progress.doneCount} of ${progress.totalCount} steps done`}
    >
      <ClipboardList className="size-3" />
      {!compact && <span className="font-medium">Onboarding</span>}
      <span className="tabular-nums">
        {progress.doneCount}/{progress.totalCount}
      </span>
    </span>
  );
}
