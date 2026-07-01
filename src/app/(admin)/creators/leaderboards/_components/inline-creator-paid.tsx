"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { useToggleAction } from "@/hooks/use-toggle-action";
import type { ServerActionResult } from "@/lib/errors/server-action-result";

import { setLeaderboardCreatorPaid } from "../actions";

/**
 * Inline toggle for a leaderboard's admin-side "creator paid his part"
 * flag — a purely internal tracking checkbox ("so we know if he paid or
 * not"). Ticked = paid. It does NOT affect any money math (PnL / GGR /
 * Leaderboard Cost); it only flips the admin-DB flag.
 *
 * `initialPaid` seeds the checked state (false when the leaderboard has
 * no row yet). Driven by `useToggleAction`: the checkbox flips
 * OPTIMISTICALLY on click with NO `router.refresh()`, so the page never
 * re-renders / re-fades / loses scroll position. The server stays source
 * of truth via the narrow `revalidateTag("creator-leaderboards")` +
 * `revalidatePath` the action fires; a failed action rolls the checkbox
 * back and toasts the error.
 */
export function InlineCreatorPaid({
  leaderboardId,
  initialPaid,
}: {
  leaderboardId: string;
  initialPaid: boolean;
}) {
  const { value, pending, toggle } = useToggleAction({
    serverValue: initialPaid,
    // The leaderboards actions return a local `ActionResult` (optional `data`);
    // normalize it to the house `ServerActionResult` shape the hook expects.
    // The hook only reads `success` / `error`, both present at runtime.
    action: async (next): Promise<ServerActionResult> => {
      const r = await setLeaderboardCreatorPaid(leaderboardId, next);
      return r.success
        ? { success: true, data: undefined }
        : { success: false, error: r.error };
    },
    successMessage: (next) =>
      next ? "Marked creator as paid" : "Marked creator as not paid",
    errorMessage: "Failed to update paid flag",
  });

  return (
    <label
      title="Creator paid his part — internal tracking flag only (no effect on costs/PnL)"
      className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground cursor-pointer select-none"
    >
      <Checkbox
        checked={value}
        onCheckedChange={() => toggle()}
        disabled={pending}
        aria-label="Creator paid his part"
      />
      <span className="hidden sm:inline">Creator paid</span>
    </label>
  );
}
