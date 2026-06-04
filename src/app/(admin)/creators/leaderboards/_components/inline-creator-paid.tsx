"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Checkbox } from "@/components/ui/checkbox";

import { setLeaderboardCreatorPaid } from "../actions";

/**
 * Inline toggle for a leaderboard's admin-side "creator paid his part"
 * flag — a purely internal tracking checkbox ("so we know if he paid or
 * not"). Ticked = paid. It does NOT affect any money math (PnL / GGR /
 * Leaderboard Cost); it only flips the admin-DB flag.
 *
 * `initialPaid` seeds the checked state (false when the leaderboard has
 * no row yet). Optimistically flips, calls the server action, and on
 * failure reverts via `router.refresh()` (the server stays the source of
 * truth) after surfacing the error toast.
 */
export function InlineCreatorPaid({
  leaderboardId,
  initialPaid,
}: {
  leaderboardId: string;
  initialPaid: boolean;
}) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function handleChange(next: boolean) {
    startTransition(async () => {
      const r = await setLeaderboardCreatorPaid(leaderboardId, next);
      if (!r.success) {
        toast.error(r.error);
        // Re-sync from the server so the checkbox snaps back to the
        // unchanged stored value.
        router.refresh();
        return;
      }
      toast.success(next ? "Marked creator as paid" : "Marked creator as not paid");
      router.refresh();
    });
  }

  return (
    <label
      title="Creator paid his part — internal tracking flag only (no effect on costs/PnL)"
      className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground cursor-pointer select-none"
    >
      <Checkbox
        checked={initialPaid}
        onCheckedChange={(checked) => handleChange(checked === true)}
        disabled={isPending}
        aria-label="Creator paid his part"
      />
      <span className="hidden sm:inline">Creator paid</span>
    </label>
  );
}
