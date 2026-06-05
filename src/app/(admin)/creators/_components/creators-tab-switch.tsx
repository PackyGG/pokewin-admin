"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Coins, UserX, Zap } from "lucide-react";
import { cn } from "@/lib/utils";

const TABS = [
  { value: "fill", label: "Fill Creators", Icon: Coins },
  { value: "multiplier", label: "Multiplier Creators", Icon: Zap },
  // Canceled / ex-creators — users whose creator role was removed but
  // who were creators before. Sourced from the DB (see
  // _queries/list-ex-creators.ts), not the live backend roster.
  { value: "past", label: "Past Creators", Icon: UserX },
] as const;

/**
 * URL-driven Fill / Multiplier / Past tab switcher for /creators. Each
 * tab shows a different creator population (active fill deals, active
 * multiplier deals, or canceled ex-creators). `fill` is the default and
 * carries no `?tab` param.
 *
 * Plain `<Link>` (not router.replace) so the active tab survives
 * page reload and ⌘-click into a new tab works. Mirrors the
 * outcome-tab pattern on /transactions/upgrader and the deposits/
 * withdrawals split on /transactions/deposits.
 *
 * Switching tabs deliberately drops `q`, `sortBy`, `page`, `filter`,
 * and `period` — the tabs surface different pools and their default-
 * relevant ordering can diverge, so carrying those params across feels
 * broken. The Grid / List `view` IS preserved so a list-view admin
 * stays in list view across tabs (it's pure presentation, not a pool-
 * specific control).
 */
export function CreatorsTabSwitch() {
  const searchParams = useSearchParams();
  const raw = searchParams.get("tab");
  const current =
    raw === "multiplier" ? "multiplier" : raw === "past" ? "past" : "fill";

  // Preserve the active render mode across tab switches; drop every
  // other URL-bound control so the new tab loads with its defaults.
  const viewParam = searchParams.get("view");
  const viewSuffix =
    viewParam === "list" ? `view=list` : "";

  return (
    <div
      role="tablist"
      aria-label="Creator deal program"
      className="inline-flex rounded-lg border border-border/60 bg-muted/30 p-0.5"
    >
      {TABS.map(({ value, label, Icon }) => {
        const active = current === value;
        const baseHref = value === "fill" ? "/creators" : `/creators?tab=${value}`;
        const href = viewSuffix
          ? value === "fill"
            ? `/creators?${viewSuffix}`
            : `${baseHref}&${viewSuffix}`
          : baseHref;
        return (
          <Link
            key={value}
            href={href}
            role="tab"
            aria-selected={active}
            // `replace` so the tab switch doesn't pollute browser history
            // with every flip, but reload + ⌘-click still work because
            // it's a real navigation, not a transient client state.
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
