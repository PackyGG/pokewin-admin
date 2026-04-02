"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AFFILIATE_LEVEL_COLORS, AFFILIATE_LEVEL_LABELS } from "@/lib/constants";
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
  const router = useRouter();

  function handleChange(value: string | null) {
    if (!value) return;
    const newLevel = parseInt(value, 10);
    if (newLevel === currentLevel) return;
    startTransition(async () => {
      try {
        await updateAffiliateLevel(userId, newLevel);
        toast.success("Level updated");
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to update level");
      }
    });
  }

  return (
    <Select value={String(currentLevel)} onValueChange={handleChange} disabled={isPending}>
      <SelectTrigger className={`!h-5 !py-0 !pl-2 !pr-1.5 !gap-0.5 rounded-4xl text-xs font-medium [&_svg]:!size-3 ${AFFILIATE_LEVEL_COLORS[currentLevel] ?? ""}`}>
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
