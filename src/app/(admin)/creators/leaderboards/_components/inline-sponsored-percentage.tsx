"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

import { setLeaderboardSponsorship } from "../actions";

/**
 * Inline editor for a leaderboard's admin-side "House share %" — the
 * portion of this prize pool the house pays on-site (the rest is the
 * creator's off-site contribution). It's the cost-accounting weight the
 * /creators "Leaderboard Cost" KPI applies to this leaderboard's pool.
 *
 * `current` is null when the leaderboard has no annotation yet; it
 * then renders the muted default "100%" (a leaderboard with no row
 * counts at full cost).
 *
 * Scroll-fix: on Save the displayed % updates OPTIMISTICALLY from local
 * state with NO `router.refresh()` — the page never re-renders / loses
 * scroll position. The server stays source of truth via the narrow
 * `revalidateTag("creator-leaderboards")` + `revalidatePath` the action
 * fires; a failed save rolls the value back and toasts the error.
 */
export function InlineSponsoredPercentage({
  leaderboardId,
  current,
}: {
  leaderboardId: string;
  current: number | null;
}) {
  const [open, setOpen] = useState(false);
  // Optimistic server-truth value. Seeded from the prop; re-synced when a
  // real revalidation streams a fresh prop in (unless a save is mid-flight,
  // so the in-flight optimistic value is never clobbered).
  const [saved, setSaved] = useState<number | null>(current);
  const [value, setValue] = useState(String(current ?? 100));
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (isPending) return;
    setSaved(current);
  }, [current, isPending]);

  const isDefault = saved == null;
  const displayPct = saved ?? 100;

  function handleSave() {
    const pct = Number(value);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      toast.error("Enter a percentage between 0 and 100");
      return;
    }
    const prev = saved;
    // Optimistic flip — instant, no reload. Close the popover right away.
    setSaved(pct);
    setOpen(false);
    startTransition(async () => {
      const r = await setLeaderboardSponsorship(leaderboardId, pct);
      if (!r.success) {
        // Roll back to the previous server-truth value.
        setSaved(prev);
        setValue(String(prev ?? 100));
        toast.error(r.error);
        return;
      }
      toast.success("House share % updated");
    });
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        // Seed the input from the current server-truth value each time the
        // popover opens, so re-editing after an optimistic save starts from
        // the right number.
        if (next) setValue(String(saved ?? 100));
        setOpen(next);
      }}
    >
      <PopoverTrigger
        render={
          <button
            type="button"
            title="House share % — the portion of this prize pool the house pays on-site"
            className="tabular-nums text-sm font-medium hover:underline"
          />
        }
      >
        <span className={isDefault ? "text-muted-foreground" : undefined}>
          {displayPct}%
        </span>
      </PopoverTrigger>
      <PopoverContent className="w-[250px] space-y-3 p-4" align="end">
        <div>
          <p className="text-sm font-medium">House share %</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            The portion of this prize pool the house pays on-site. The
            rest is the creator&apos;s off-site contribution. Default
            100%.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={0}
            max={100}
            step="1"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="h-8 text-sm"
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSave();
            }}
            autoFocus
          />
          <span className="text-sm text-muted-foreground">%</span>
        </div>
        <div className="flex justify-end gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() => setOpen(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            className="h-7 text-xs"
            onClick={handleSave}
            disabled={isPending}
          >
            {isPending ? "..." : "Save"}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
