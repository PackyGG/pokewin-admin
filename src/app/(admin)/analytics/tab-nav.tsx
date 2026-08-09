"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  BarChart3,
  Dices,
  Gift,
  Sigma,
  TrendingDown,
  Globe,
  Wallet,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { LinkPendingShell } from "@/components/ux";

export type AnalyticsTab =
  | "overview"
  | "games"
  | "crm"
  | "cost-breakdown"
  | "rewards"
  | "fiat"
  | "map";

// Cohorts / Funnel / Creator LTV / Retention / Top Performers were deleted
// (owner, 2026-07-23: "never was used, over-engineered"). Their tab files,
// tabs, there is no code left behind them.
//
// Revenue went the same way (owner, 2026-07-23): its four source tables and
// GGR/NGR tiles restated, less clearly, the numbers Cost Breakdown already
// ties together in one waterfall. The only panel it alone owned — withdrawn
// cash per crypto rail — moved to Overview rather than dying with it.
const TABS: { value: AnalyticsTab; label: string; icon: typeof BarChart3 }[] = [
  { value: "overview", label: "Overview", icon: BarChart3 },
  // Raw pack/battle gambling margin — separate from Overview's broader
  // realized + windowed P&L panels so admins can deep-link the
  // real-money-only gameplay outcome view without scrolling past the
  // rest. Excludes creator wagers AND borrow-mode plays.
  // Absorbed from /insights/double-down (owner, 2026-07-23) — that route now
  // redirects here. Locked to 30d, so the page period filter doesn't apply.
  // Games — the modes a player can put money into. Packs and battles were
  // dropped here too (owner, 2026-07-23), leaving upgrader + double down.
  { value: "games", label: "Games", icon: Dices },
  // Absorbed from the /insights section (owner, 2026-07-23) — those routes
  // now redirect here. Each keeps its own sub-nav / period on namespaced
  // params (?rn=, ?cbPeriod=, ?rw=/?rwPeriod=) so no two bars fight over one.
  // Player CRM — lifecycle, value tiers and win-back targets. Came in with
  // Real Numbers and OUTLIVED it: the Real Numbers view itself was deleted
  // (owner, 2026-07-23) because Overview now answers the same question
  // better, but this is a different tool and kept its place.
  { value: "crm", label: "Player CRM", icon: Sigma },
  { value: "cost-breakdown", label: "Cost Breakdown", icon: TrendingDown },
  { value: "rewards", label: "Rewards", icon: Gift },
  // The former standalone /fiat workspace now lives in Analytics. It keeps
  // its own nested navigation for configuration, payments, access and
  // webhooks; this top-level chip selects the workspace itself.
  { value: "fiat", label: "Fiat", icon: Wallet },
  // Migrated from the standalone /map page — geographic breakdown of
  // users + per-country money flows. Lives here so it shares the
  // analytics hero's period filter instead of carrying its own.
  { value: "map", label: "Map", icon: Globe },
];

/**
 * Horizontal tab nav that persists the active tab in `?tab=` so deep links
 * land on the right panel. Other query params (period etc.) are preserved
 * across tab switches.
 *
 * Mobile UX:
 *   - Tabs are wider than a phone (7 chips × ~110px ≈ 770px), so the
 *     row stays horizontally scrollable on touch — but on phones it's
 *     unclear whether more content lives off-screen. We fade the strip's
 *     own edges to transparent with a horizontal `mask-image` gradient,
 *     so off-screen chips dissolve at both edges regardless of what sits
 *     behind the strip (no background-color matching needed, unlike an
 *     overlay div). The mask is dropped at lg+ where all chips fit.
 *   - `overscroll-x-contain` keeps the momentum swipe inside the strip
 *     instead of bouncing the whole page.
 *   - Active chip is `scroll-mx-4` so when the page mounts mid-scroll the
 *     active tab still clears the faded edge.
 */
export function AnalyticsTabNav() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const current = (searchParams.get("tab") ?? "overview") as AnalyticsTab;

  function hrefFor(tab: AnalyticsTab): string {
    const p = new URLSearchParams(searchParams.toString());
    // Overview is the page's default (the one-scroll view) — its chip links
    // to the bare canonical URL instead of carrying a redundant ?tab=.
    if (tab === "overview") {
      p.delete("tab");
    } else {
      p.set("tab", tab);
    }
    const qs = p.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  }

  return (
    <div
      className={cn(
        "flex gap-1 overflow-x-auto overscroll-x-contain rounded-lg border bg-muted/50 p-1",
        "[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        // Fade both edges to transparent on phones to signal more chips
        // off-screen; removed at lg+ where the full strip is visible.
        "[mask-image:linear-gradient(to_right,transparent,black_1.5rem,black_calc(100%-1.5rem),transparent)]",
        "lg:[mask-image:none]",
      )}
    >
      {TABS.map(({ value, label, icon: Icon }) => (
        <Link
          key={value}
          href={hrefFor(value)}
          replace
          prefetch={false}
          className={cn(
            "flex shrink-0 scroll-mx-4 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
            current === value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {/* While THIS tab's navigation is pending, the row dims + shows a
              trailing spinner so the click reads as "loading" immediately,
              before the server segment streams in. Safe no-op when idle. */}
          <LinkPendingShell>
            <Icon className="size-3.5" />
            {label}
          </LinkPendingShell>
        </Link>
      ))}
    </div>
  );
}
