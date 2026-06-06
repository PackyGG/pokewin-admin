"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Coins, UserX, Zap } from "lucide-react";

import { cn } from "@/lib/utils";

import type { RosterTab } from "../_lib/roster-params";

const TABS: {
  value: RosterTab;
  label: string;
  Icon: typeof Coins;
}[] = [
  { value: "active", label: "Active", Icon: Coins },
  {
    value: "multiplier",
    label: "Multiplier",
    Icon: Zap,
  },
  { value: "past", label: "Past Creators", Icon: UserX },
];

function resolveTab(raw: string | null): RosterTab {
  if (raw === "multiplier") return "multiplier";
  if (raw === "past") return "past";
  return "active";
}

/**
 * URL-driven Active / Multiplier / Past tab switcher for
 * `/creator-hub/creators`. `active` (fill-deal creators) is the default and
 * carries no `?tab` param.
 *
 * Switching tabs drops `q`, `sortBy`, and `period` (different pools +
 * defaults) but preserves grid/list `view`.
 */
export function RosterTabSwitch() {
  const searchParams = useSearchParams();
  const current = resolveTab(searchParams.get("tab"));

  const viewParam = searchParams.get("view");
  const viewSuffix = viewParam === "list" ? "view=list" : "";

  return (
    <div
      role="tablist"
      aria-label="Creator roster"
      className="inline-flex rounded-lg border border-border/60 bg-muted/30 p-0.5"
    >
      {TABS.map(({ value, label, Icon }) => {
        const active = current === value;
        const baseHref =
          value === "active"
            ? "/creator-hub/creators"
            : `/creator-hub/creators?tab=${value}`;
        const href = viewSuffix
          ? value === "active"
            ? `/creator-hub/creators?${viewSuffix}`
            : `${baseHref}&${viewSuffix}`
          : baseHref;
        return (
          <Link
            key={value}
            href={href}
            role="tab"
            aria-selected={active}
            replace
            scroll={false}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-3.5" />
            {label}
          </Link>
        );
      })}
    </div>
  );
}
