"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AFFILIATE_LEVEL_LABELS } from "@/lib/constants";
import { updateAffiliateLevel } from "../actions";

const LEVELS = [1, 2, 3, 4, 5, 6, 7, 8];

export function LevelSelect({
  userId,
  currentLevel,
}: {
  userId: string;
  currentLevel: number;
}) {
  const [isPending, startTransition] = useTransition();

  function handleChange(value: string | null) {
    if (!value) return;
    const newLevel = parseInt(value, 10);
    if (newLevel === currentLevel) return;
    startTransition(async () => {
      try {
        await updateAffiliateLevel(userId, newLevel);
        toast.success("Level updated");
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to update level");
      }
    });
  }

  return (
    <Select value={String(currentLevel)} onValueChange={handleChange} disabled={isPending}>
      <SelectTrigger
        size="sm"
        className="!h-6 !px-1.5 !py-0 !gap-1 !w-fit !rounded-md border-transparent bg-transparent text-xs text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:!size-3 dark:bg-transparent dark:hover:bg-accent"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {LEVELS.map((l) => (
          <SelectItem key={l} value={String(l)}>
            {AFFILIATE_LEVEL_LABELS[l] ?? `Level ${l}`}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
