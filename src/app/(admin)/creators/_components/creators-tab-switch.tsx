"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Coins, Zap } from "lucide-react";
import { cn } from "@/lib/utils";

const TABS = [
  { value: "fill", label: "Fill Creators", Icon: Coins },
  { value: "multiplier", label: "Multiplier Creators", Icon: Zap },
] as const;

/**
 * URL-driven Fill / Multiplier tab switcher for /creators. Each tab
 * shows only creators of that deal program. `fill` is the default and
 * carries no `?tab` param.
 *
 * Plain `<Link>` (not router.replace) so the active tab survives
 * page reload and ⌘-click into a new tab works. Mirrors the
 * outcome-tab pattern on /transactions/upgrader and the deposits/
 * withdrawals split on /transactions/deposits.
 *
 * Switching tabs deliberately drops `search`, `sortBy`, and `page` —
 * the two tabs surface different pools and their default-relevant
 * ordering can diverge, so carrying those params across feels broken.
 */
export function CreatorsTabSwitch() {
  const searchParams = useSearchParams();
  const current =
    searchParams.get("tab") === "multiplier" ? "multiplier" : "fill";

  return (
    <div
      role="tablist"
      aria-label="Creator deal program"
      className="inline-flex rounded-lg border border-border/60 bg-muted/30 p-0.5"
    >
      {TABS.map(({ value, label, Icon }) => {
        const active = current === value;
        const href =
          value === "fill" ? "/creators" : "/creators?tab=multiplier";
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
