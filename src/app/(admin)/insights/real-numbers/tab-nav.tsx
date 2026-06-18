"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Sigma, PieChart } from "lucide-react";
import { cn } from "@/lib/utils";
import { LinkPendingShell } from "@/components/ux";

export type RealNumbersTab = "real-numbers" | "crm";

const TABS: { value: RealNumbersTab; label: string; icon: typeof Sigma }[] = [
  { value: "real-numbers", label: "Real Numbers", icon: Sigma },
  // Player CRM — folded out of the former standalone /crm page so the
  // lifecycle / VIP / win-back segmentation shares the Insights Overview
  // hero instead of carrying its own owner-gated route.
  { value: "crm", label: "Player CRM", icon: PieChart },
];

/**
 * Tab nav for the Insights Overview. Persists the active tab in `?tab=` so
 * deep links land on the right panel; other query params are preserved across
 * switches. Mirrors the analytics tab-nav UX.
 */
export function RealNumbersTabNav() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const current = (searchParams.get("tab") ?? "real-numbers") as RealNumbersTab;

  function hrefFor(tab: RealNumbersTab): string {
    const p = new URLSearchParams(searchParams.toString());
    p.set("tab", tab);
    return `${pathname}?${p.toString()}`;
  }

  return (
    <div className="flex gap-1 overflow-x-auto overscroll-x-contain rounded-lg border bg-muted/50 p-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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
          <LinkPendingShell>
            <Icon className="size-3.5" />
            {label}
          </LinkPendingShell>
        </Link>
      ))}
    </div>
  );
}
