"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { AFFILIATE_LEVEL_COLORS, AFFILIATE_LEVEL_LABELS } from "@/lib/constants";
import { updateAffiliateLevel } from "./actions";

const LEVELS = [1, 2, 3, 4, 5, 6, 7, 8];

/**
 * Inline affiliate-level select. Updates OPTIMISTICALLY in place with NO
 * `router.refresh()`, so the /creators table never re-renders / loses scroll
 * position. Local `level` state drives the trigger; the server stays source of
 * truth via the `revalidatePath` the action fires (re-syncing the prop on the
 * next render). A failed update rolls the selection back and toasts the error.
 */
export function InlineLevelSelect({
  userId,
  currentLevel,
}: {
  userId: string;
  currentLevel: number;
}) {
  const [isPending, startTransition] = useTransition();
  // Optimistic level. Seeded from the prop; re-synced when a real revalidation
  // streams a fresh prop in (unless an update is mid-flight).
  const [level, setLevel] = useState(currentLevel);

  useEffect(() => {
    if (isPending) return;
    setLevel(currentLevel);
  }, [currentLevel, isPending]);

  function handleChange(value: string | null) {
    if (!value) return;
    const next = parseInt(value, 10);
    if (next === level) return;
    const prev = level;
    // Optimistic flip — instant, no reload.
    setLevel(next);
    startTransition(async () => {
      try {
        await updateAffiliateLevel(userId, next);
        toast.success("Level updated");
      } catch (e) {
        setLevel(prev);
        toast.error(e instanceof Error ? e.message : "Failed to update level");
      }
    });
  }

  return (
    <Select value={String(level)} onValueChange={handleChange} disabled={isPending}>
      <SelectTrigger className={`!h-5 !py-0 !pl-2 !pr-1.5 !gap-0.5 rounded-4xl text-xs font-medium [&_svg]:!size-3 ${AFFILIATE_LEVEL_COLORS[level] ?? ""}`}>
        <span>{AFFILIATE_LEVEL_LABELS[level] ?? `Level ${level}`}</span>
      </SelectTrigger>
      <SelectContent>
        {LEVELS.map((l) => (
          <SelectItem key={l} value={String(l)}>
            {AFFILIATE_LEVEL_LABELS[l]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
