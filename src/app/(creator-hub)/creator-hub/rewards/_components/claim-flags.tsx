"use client";

import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * One tone per meaning, defined once.
 *
 * These were eight hand-written Badge blocks with their colour classes copied
 * into each, which is how a palette drifts. Nothing new is introduced here —
 * every tone is one the rest of the app already uses.
 */
const FLAG_TONE = {
  amber: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  purple: "bg-purple-500/15 text-purple-600 dark:text-purple-400",
  rose: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
  blue: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  zinc: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400",
} as const;

export type FlagTone = keyof typeof FLAG_TONE;

export function Flag({
  tone,
  title,
  children,
}: {
  tone: FlagTone;
  title?: string;
  children: ReactNode;
}) {
  return (
    <Badge
      variant="outline"
      className={cn("text-[10px]", FLAG_TONE[tone])}
      title={title}
    >
      {children}
    </Badge>
  );
}
