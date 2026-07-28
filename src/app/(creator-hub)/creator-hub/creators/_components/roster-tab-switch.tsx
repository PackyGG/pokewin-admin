"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Coins, UserX, Zap } from "lucide-react";

import { cn } from "@/lib/utils";
import { useHostHref } from "@/lib/use-app-host";

const TABS = [
  { value: "fill", label: "Fill Creators", Icon: Coins },
  { value: "multiplier", label: "Multiplier Creators", Icon: Zap },
  { value: "past", label: "Past Creators", Icon: UserX },
] as const;

/**
 * URL-driven Fill / Multiplier / Past tab switcher for `/creator-hub/creators`.
 * Mirrors `/creators` on the admin dashboard. `fill` is the default and carries
 * no `?tab` param.
 *
 * Switching tabs preserves `sortBy`, `period`, and grid/list `view` (rebuilt
 * with `URLSearchParams`, not string concat) and drops only `q` (the instant
 * filter doesn't carry across pools).
 */
const PRESERVED_PARAMS = ["sortBy", "period", "view"] as const;

export function RosterTabSwitch() {
  // Host-aware: `/creator-hub/creators` on the apex, `/creators` on
  // marketing.packydash.com — keeps tab switches a clean soft navigation
  // instead of bouncing through the middleware's canonicalizing redirect.
  const rosterHref = useHostHref("/creator-hub/creators");
  const searchParams = useSearchParams();
  const raw = searchParams.get("tab");
  const current =
    raw === "multiplier" ? "multiplier" : raw === "past" ? "past" : "fill";

  function hrefFor(value: (typeof TABS)[number]["value"]): string {
    const params = new URLSearchParams();
    if (value !== "fill") params.set("tab", value);
    for (const key of PRESERVED_PARAMS) {
      const v = searchParams.get(key);
      if (v) params.set(key, v);
    }
    const qs = params.toString();
    return qs ? `${rosterHref}?${qs}` : rosterHref;
  }

  return (
    <div
      role="tablist"
      aria-label="Creator roster"
      className="inline-flex flex-wrap gap-0.5 rounded-lg border border-border/60 bg-muted/30 p-0.5"
    >
      {TABS.map(({ value, label, Icon }) => {
        const active = current === value;
        const href = hrefFor(value);
        return (
          <Link
            key={value}
            href={href}
            role="tab"
            aria-selected={active}
            replace
            scroll={false}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors sm:px-3",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-3.5 shrink-0" />
            <span className="hidden sm:inline">{label}</span>
            <span className="sm:hidden">
              {value === "fill" ? "Fill" : value === "multiplier" ? "Mult." : "Past"}
            </span>
          </Link>
        );
      })}
    </div>
  );
}
