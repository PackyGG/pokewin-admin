"use client";

import * as React from "react";
import { formatCurrency } from "@/lib/utils/format";

/**
 * Renders a signed P&L amount already expressed in HOUSE perspective.
 * Callers must pre-flip the sign if they're holding a user-perspective
 * number (see user-tabs-cards PnlCard where costs are passed as -cost).
 *
 * Positive → house gain → emerald. Negative → house loss → rose.
 */
export function PnlValue({ value }: { value: number }) {
  const color =
    value > 0
      ? "text-emerald-600 dark:text-emerald-400"
      : value < 0
        ? "text-rose-600 dark:text-rose-400"
        : "text-muted-foreground";
  return (
    <span className={`${color} font-medium tabular-nums`}>
      {value > 0 ? "+" : value < 0 ? "-" : ""}
      {formatCurrency(Math.abs(value))}
    </span>
  );
}

export function InfoRow({
  label,
  value,
  mono,
  truncate: shouldTruncate,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  truncate?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 min-w-0">
      <span className="text-sm text-muted-foreground shrink-0">{label}</span>
      <span
        className={`text-sm min-w-0 tabular-nums ${mono ? "font-mono text-xs" : ""} ${shouldTruncate ? "truncate" : ""}`}
        title={shouldTruncate && typeof value === "string" ? value : undefined}
      >
        {value}
      </span>
    </div>
  );
}
