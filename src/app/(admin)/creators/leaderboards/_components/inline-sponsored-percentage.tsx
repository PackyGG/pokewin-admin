"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
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
 * Inline editor for a leaderboard's admin-side "Sponsored %" — the
 * cost-accounting weight the /creators "Leaderboard Cost" KPI applies
 * to this leaderboard's prize pool.
 *
 * `current` is null when the leaderboard has no annotation yet; it
 * then renders the muted default "100%" (a leaderboard with no row
 * counts at full cost).
 */
export function InlineSponsoredPercentage({
  leaderboardId,
  current,
}: {
  leaderboardId: string;
  current: number | null;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(String(current ?? 100));
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const isDefault = current == null;
  const displayPct = current ?? 100;

  function handleSave() {
    const pct = Number(value);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      toast.error("Enter a percentage between 0 and 100");
      return;
    }
    startTransition(async () => {
      const r = await setLeaderboardSponsorship(leaderboardId, pct);
      if (!r.success) {
        toast.error(r.error);
        return;
      }
      toast.success("Sponsored % updated");
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            title="Sponsored % — counted in the /creators Leaderboard Cost"
            className="tabular-nums text-sm font-medium hover:underline"
          />
        }
      >
        <span className={isDefault ? "text-muted-foreground" : undefined}>
          {displayPct}%
        </span>
      </PopoverTrigger>
      <PopoverContent className="w-[230px] space-y-3 p-4" align="end">
        <div>
          <p className="text-sm font-medium">Sponsored %</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Share of this leaderboard counted in the /creators
            Leaderboard Cost KPI. Default is 100%.
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
