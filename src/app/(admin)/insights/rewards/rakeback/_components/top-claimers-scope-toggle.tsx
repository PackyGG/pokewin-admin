"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * Scope toggle for the Top Claimers tab. Switches between "period" (top
 * in current selected window) and "lifetime" (all-time top). Preserves
 * `?period=`, `?tab=`, `?lookback=` so flipping scope doesn't reset
 * other state.
 */
const SCOPES = [
  { value: "period", label: "Period" },
  { value: "lifetime", label: "Lifetime" },
] as const;

export function RakebackTopScopeToggle() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const current = searchParams.get("scope") ?? "period";
  const period = searchParams.get("period");
  const tab = searchParams.get("tab") ?? "top";
  const lookback = searchParams.get("lookback");
  const carry = [
    period ? `period=${encodeURIComponent(period)}` : null,
    tab ? `tab=${encodeURIComponent(tab)}` : null,
    lookback ? `lookback=${encodeURIComponent(lookback)}` : null,
  ]
    .filter(Boolean)
    .join("&");

  return (
    <div className="flex flex-wrap gap-1 rounded-lg border bg-muted/50 p-1">
      {SCOPES.map((s) => {
        const active = current === s.value;
        const params = [`scope=${s.value}`, carry].filter(Boolean).join("&");
        return (
          <Link
            key={s.value}
            href={`${pathname}?${params}`}
            replace
            prefetch={false}
            className={cn(
              "rounded-md px-3 py-1 text-xs font-medium transition-colors",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {s.label}
          </Link>
        );
      })}
    </div>
  );
}
