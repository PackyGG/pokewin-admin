"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Package, ArrowUpCircle, Wand2, Coins } from "lucide-react";

import { cn } from "@/lib/utils";

import { EDGE_CALC_TABS, type EdgeCalcTab } from "./types";

const TAB_META: Record<EdgeCalcTab, { label: string; icon: typeof Package }> = {
  packs: { label: "Packs", icon: Package },
  upgrader: { label: "Upgrader", icon: ArrowUpCircle },
  scenario: { label: "Scenario Builder", icon: Wand2 },
  bonus: { label: "Bonus Stack ROI", icon: Coins },
};

/**
 * Tab strip for /insights/edge-calc. Mirrors the chip pattern used by
 * the sibling /insights/* surfaces and the legacy /analytics tab nav
 * so the four pages read as a family. Each tab persists in `?tab=` and
 * preserves every other query param (period, pack id) on click — which
 * matters here because the Scenario Builder + Packs tab both filter by
 * `packId` and the admin shouldn't lose their selection switching tabs.
 */
export function EdgeCalcTabNav() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const current = (searchParams.get("tab") ?? "packs") as EdgeCalcTab;

  function hrefFor(tab: EdgeCalcTab): string {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", tab);
    return `${pathname}?${params.toString()}`;
  }

  return (
    <div
      className={cn(
        "flex gap-1 overflow-x-auto overscroll-x-contain rounded-lg border bg-muted/50 p-1",
        "[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        // Edge-fade mask hints at off-screen chips on phones; dropped
        // at lg+ where all chips fit.
        "[mask-image:linear-gradient(to_right,transparent,black_1.5rem,black_calc(100%-1.5rem),transparent)]",
        "lg:[mask-image:none]",
      )}
    >
      {EDGE_CALC_TABS.map((value) => {
        const { label, icon: Icon } = TAB_META[value];
        const active = current === value;
        return (
          <Link
            key={value}
            href={hrefFor(value)}
            replace
            prefetch={false}
            className={cn(
              "flex shrink-0 scroll-mx-4 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
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
