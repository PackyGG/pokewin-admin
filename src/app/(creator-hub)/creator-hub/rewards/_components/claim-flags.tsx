"use client";

import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ROLE_COLORS,
  STATUS_COLORS,
  USER_STATUS_COLORS,
} from "@/lib/constants";
import { cn } from "@/lib/utils";

/**
 * One tone per meaning, POINTING AT the shared palette instead of restating it.
 *
 * The previous map hand-wrote its own classes and had already drifted: it
 * dropped the 30%-opacity border every constant in `src/lib/constants.ts` has,
 * and its "amber" is a hue the palette does not hold — so a Pending flag here
 * and a pending Badge elsewhere on the same screen rendered two different ways.
 * Each tone now resolves to the constant that already means the same thing, so
 * the palette can only change in one place.
 *
 * `warn` is yellow, not amber: STATUS_COLORS.pending and
 * USER_STATUS_COLORS.locked are the palette's "needs a second look" hue, and
 * both of those states are literally what this tone marks here.
 */
const FLAG_TONE = {
  /** Waiting / locked / suspect — stop and look before acting. */
  warn: STATUS_COLORS.pending,
  /** VIP. Purple lives on the creator role in the shared palette. */
  vip: ROLE_COLORS.creator,
  /** House-POV money out, or a banned account. */
  rose: USER_STATUS_COLORS.banned,
  /** Informational, in flight. */
  blue: STATUS_COLORS.processing,
  /** Retired / inert / decided-against. */
  zinc: ROLE_COLORS.user,
} as const;

export type FlagTone = keyof typeof FLAG_TONE;

/**
 * Focusable tooltip wrapper.
 *
 * Everything on this page that used to explain itself through a `title`
 * attribute goes through here. `title` never fires on touch and is unreachable
 * by keyboard, which on a queue where the explanation IS the reason to slow
 * down (banned, locked, suspected alt) hid the safety signal from exactly the
 * operators who navigate by keyboard. `tabIndex={0}` makes the trigger a real
 * stop; the `sr-only` copy guarantees the text reaches a screen reader even if
 * the tooltip never opens.
 */
export function Hint({
  tip,
  children,
  className,
}: {
  tip: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              tabIndex={0}
              className={cn(
                "inline-flex max-w-full cursor-help items-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring",
                className,
              )}
            >
              {children}
              <span className="sr-only"> — {tip}</span>
            </span>
          }
        />
        <TooltipContent className="max-w-[18rem] text-xs leading-relaxed">
          {tip}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function Flag({
  tone,
  tip,
  children,
}: {
  tone: FlagTone;
  /** Why this flag is here. Rendered as a real tooltip, never as `title`. */
  tip?: string;
  children: ReactNode;
}) {
  const badge = (
    <Badge variant="outline" className={cn("text-[10px]", FLAG_TONE[tone])}>
      {children}
    </Badge>
  );

  return tip ? <Hint tip={tip}>{badge}</Hint> : badge;
}
