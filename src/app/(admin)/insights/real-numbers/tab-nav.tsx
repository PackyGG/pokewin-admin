"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Sigma, PieChart, LineChart } from "lucide-react";
import { cn } from "@/lib/utils";
import { LinkPendingShell } from "@/components/ux";

export type RealNumbersTab = "analytics" | "real-numbers" | "crm";

const TABS: { value: RealNumbersTab; label: string; icon: typeof Sigma }[] = [
  // Real Numbers — the LANDING view (default). The source-of-truth
  // reconciled headline (wager / GGR / reward cost / NGR / realized P&L).
  { value: "real-numbers", label: "Real Numbers", icon: Sigma },
  // Analytics — carries the deposit-cadence figures (Avg Deposit + Deposits
  // / Hour) moved off the dashboard KPI strip. Demoted from the landing to
  // a tab.
  { value: "analytics", label: "Analytics", icon: LineChart },
  // Player CRM — folded out of the former standalone /crm page so the
  // lifecycle / VIP / win-back segmentation shares the Insights Overview
  // hero instead of carrying its own owner-gated route.
  { value: "crm", label: "Player CRM", icon: PieChart },
];

/**
 * Tab nav for the Insights Overview. Persists the active tab in `?tab=` so
 * deep links land on the right panel; other query params are preserved across
 * switches. Mirrors the analytics tab-nav UX.
 *
 * The heavy Real-Numbers / CRM tabs can take a moment to stream their server
 * body. To keep the switch from feeling like a dead click, the active pill
 * flips OPTIMISTICALLY the instant a tab is clicked: the click starts a
 * `useTransition` and records the in-flight target, so the pill styling moves
 * immediately while the destination `<Suspense>` skeleton resolves. Once the
 * `?tab=` navigation commits, `committed` catches up and the optimistic target
 * is dropped. `prefetch={false}` stays (these are heavy per-tab reads we never
 * want to eager-fetch), and the app's shared `TopProgressBar` still fires on
 * the `?tab=` commit for the global cue.
 */
export function RealNumbersTabNav() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  // The in-flight target set on click; drives the active pill optimistically
  // until the URL commits. `null` when nothing is pending.
  const [pending, setPending] = useState<RealNumbersTab | null>(null);
  const committed = (searchParams.get("tab") ?? "real-numbers") as RealNumbersTab;

  // Once the navigation commits (URL caught up) or the transition finished,
  // the optimistic target is stale — drop it so the pill tracks the real URL.
  useEffect(() => {
    if (pending !== null && (!isPending || pending === committed)) {
      setPending(null);
    }
  }, [pending, isPending, committed]);

  // What the pill should read as active RIGHT NOW: the in-flight target during
  // a transition, otherwise the committed URL tab.
  const active = pending ?? committed;

  function hrefFor(tab: RealNumbersTab): string {
    const p = new URLSearchParams(searchParams.toString());
    p.set("tab", tab);
    return `${pathname}?${p.toString()}`;
  }

  function onSelect(
    e: React.MouseEvent<HTMLAnchorElement>,
    tab: RealNumbersTab,
  ) {
    // Let modifier / middle clicks fall through to the browser (new tab etc.).
    if (
      e.defaultPrevented ||
      e.metaKey ||
      e.ctrlKey ||
      e.shiftKey ||
      e.altKey ||
      e.button !== 0
    ) {
      return;
    }
    if (tab === committed) return;
    e.preventDefault();
    setPending(tab); // optimistic: move the active pill now
    startTransition(() => {
      router.replace(hrefFor(tab));
    });
  }

  return (
    <div className="flex gap-1 overflow-x-auto overscroll-x-contain rounded-lg border bg-muted/50 p-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {TABS.map(({ value, label, icon: Icon }) => (
        <Link
          key={value}
          href={hrefFor(value)}
          replace
          prefetch={false}
          onClick={(e) => onSelect(e, value)}
          aria-current={active === value ? "page" : undefined}
          className={cn(
            "flex shrink-0 scroll-mx-4 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
            active === value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <LinkPendingShell>
            <Icon className="size-3.5" />
            {label}
          </LinkPendingShell>
        </Link>
      ))}
    </div>
  );
}
