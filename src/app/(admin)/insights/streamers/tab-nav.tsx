"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  BarChart3,
  Coins,
  ShieldAlert,
  Shuffle,
  Trophy,
  Percent,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { LinkPendingShell } from "@/components/ux";
import type { StreamerTab } from "./types";

const TABS: { value: StreamerTab; label: string; icon: typeof BarChart3 }[] = [
  { value: "overview", label: "Overview", icon: BarChart3 },
  { value: "money-makers", label: "Money Makers", icon: Coins },
  { value: "sus", label: "Sus / Abuse", icon: ShieldAlert },
  { value: "code-switching", label: "Code Switching", icon: Shuffle },
  { value: "leaderboard-snipers", label: "Leaderboard Snipers", icon: Trophy },
  { value: "roi", label: "Affiliate ROI", icon: Percent },
];

/**
 * Horizontal tab strip — mirrors the structure used on /analytics so the
 * site's nav vocabulary stays consistent. Tab state lives in `?tab=` so
 * deep links land on the right panel; the period chip's selection is
 * preserved across tab switches because we copy `searchParams` into the
 * href builder.
 */
export function StreamersTabNav() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const current = (searchParams.get("tab") ?? "overview") as StreamerTab;

  function hrefFor(tab: StreamerTab): string {
    const p = new URLSearchParams(searchParams.toString());
    p.set("tab", tab);
    return `${pathname}?${p.toString()}`;
  }

  return (
    <div
      className={cn(
        "flex gap-1 overflow-x-auto overscroll-x-contain rounded-lg border bg-muted/50 p-1",
        "[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
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
          <LinkPendingShell>
            <Icon className="size-3.5" />
            {label}
          </LinkPendingShell>
        </Link>
      ))}
    </div>
  );
}
