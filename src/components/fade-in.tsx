import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Subtle mount fade-in for large content blocks that appear after data loads
 * (tab panels, chart grids, section wrappers). Uses the `tw-animate-css`
 * keyframes that are already imported in `globals.css` — no new deps.
 *
 * `motion-safe:` ensures users with `prefers-reduced-motion: reduce` get
 * the final state immediately without any animation.
 *
 * Durations are rebased onto the centralized motion `DURATION` tokens
 * (`src/components/ux/motion.ts`) so this primitive stays in lockstep with
 * the rest of `ux/*` instead of carrying its own ad-hoc 300ms:
 *   - "fast"    → `fast` token   (150ms)
 *   - "default" → `base` token   (~220ms → Tailwind `duration-200`)  ← default
 *   - "slow"    → `slow` token   (320ms → Tailwind `duration-300`)
 * All on the signature ease-out curve. Keep it subtle — this is a polish
 * primitive, not a stage effect.
 *
 * Class strings are authored in full (not interpolated) so Tailwind's JIT
 * emits them, mirroring `DURATION_CLASS` in the motion module.
 */
export function FadeIn({
  children,
  className,
  speed = "default",
  delay,
}: {
  children: React.ReactNode;
  className?: string;
  speed?: "fast" | "default" | "slow";
  /** Optional CSS delay in ms — use sparingly to stagger a couple of blocks. */
  delay?: number;
}) {
  const durationClass =
    speed === "fast"
      ? "motion-safe:duration-150"
      : speed === "slow"
        ? "motion-safe:duration-300"
        : "motion-safe:duration-200";

  return (
    <div
      className={cn(
        "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:ease-out",
        durationClass,
        className,
      )}
      style={delay ? { animationDelay: `${delay}ms` } : undefined}
    >
      {children}
    </div>
  );
}
