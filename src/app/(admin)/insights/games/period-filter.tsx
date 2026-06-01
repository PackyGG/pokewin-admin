"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { PERIOD_OPTIONS } from "./types";

/**
 * Period chip row — preserves every other URL param when switching
 * periods so the active tab + scroll position survive a chip click.
 *
 * Six chips at ~52px each ≈ 312px — fits a 360px viewport with the
 * `flex-wrap` safety net for longer labels (Lifetime is the widest).
 */
export function GamesPeriodFilter() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const current = searchParams.get("period") ?? "7d";

  function hrefFor(value: string): string {
    const p = new URLSearchParams(searchParams.toString());
    p.set("period", value);
    return `${pathname}?${p.toString()}`;
  }

  return (
    <div className="flex flex-wrap gap-1 rounded-lg border bg-muted/50 p-1">
      {PERIOD_OPTIONS.map(({ label, value }) => (
        <Link
          key={value}
          href={hrefFor(value)}
          replace
          prefetch={false}
          className={cn(
            "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
            current === value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {label}
        </Link>
      ))}
    </div>
  );
}
