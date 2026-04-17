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
 * Durations map to Tailwind's built-ins: "fast" (200ms), "default" (300ms),
 * "slow" (500ms). Keep it subtle — this is a polish primitive, not a stage
 * effect.
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
      ? "motion-safe:duration-200"
      : speed === "slow"
        ? "motion-safe:duration-500"
        : "motion-safe:duration-300";

  return (
    <div
      className={cn(
        "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1",
        durationClass,
        className,
      )}
      style={delay ? { animationDelay: `${delay}ms` } : undefined}
    >
      {children}
    </div>
  );
}
