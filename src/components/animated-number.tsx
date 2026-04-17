"use client";

import * as React from "react";
import { formatCurrency, formatNumber } from "@/lib/utils/format";

export type AnimatedNumberFormat = "currency" | "number" | "percent";

function formatByKind(kind: AnimatedNumberFormat, n: number): string {
  switch (kind) {
    case "currency":
      return formatCurrency(n);
    case "percent":
      return `${n.toFixed(2)}%`;
    case "number":
    default:
      return formatNumber(Math.round(n));
  }
}

/**
 * Smoothly animates a numeric value from 0 (on mount) or from the previous
 * value (on update) to the current `value`. Intentionally small and dep-free
 * — uses requestAnimationFrame + an ease-out curve.
 *
 * - Respects `prefers-reduced-motion`: when reduce-motion is set, the target
 *   value is rendered immediately with no animation.
 * - The output string is produced by `format(current)` so callers keep their
 *   existing formatters (`formatCurrency`, `formatNumber`, etc.) without
 *   duplication.
 * - Uses `tabular-nums` on the rendered span so digits don't jitter width
 *   during the ramp.
 */
export function AnimatedNumber({
  value,
  format,
  duration = 400,
  className,
}: {
  value: number;
  /** Serializable format kind — so this component is safe to use from
   *  Server Components. Function formatters would break RSC serialization. */
  format: AnimatedNumberFormat;
  duration?: number;
  className?: string;
}) {
  // Always initialize to the real value so SSR output and the initial
  // client render match — prevents React #418 hydration mismatch. The
  // mount animation is intentionally skipped; we animate only when
  // `value` changes after the component has mounted (e.g. period swaps
  // on the dashboard stat cards).
  const [display, setDisplay] = React.useState<number>(value);
  const previousRef = React.useRef<number>(value);

  React.useEffect(() => {
    if (previousRef.current === value) return;
    if (typeof window === "undefined") return;
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (mql.matches) {
      setDisplay(value);
      previousRef.current = value;
      return;
    }

    const start = previousRef.current;
    const delta = value - start;
    if (delta === 0) {
      setDisplay(value);
      return;
    }
    const startTime = performance.now();
    let raf = 0;

    const tick = (now: number) => {
      const t = Math.min(1, (now - startTime) / duration);
      // easeOutCubic — punchy on entry, calm landing
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(start + delta * eased);
      if (t < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        previousRef.current = value;
      }
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);

  return (
    <span className={className} style={{ fontVariantNumeric: "tabular-nums" }}>
      {formatByKind(format, display)}
    </span>
  );
}
