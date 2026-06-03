"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  BarChart3,
  Package,
  Swords,
  TrendingUp,
  HandCoins,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { LinkPendingShell } from "@/components/ux";
import type { GamesTab } from "./types";

const TABS: { value: GamesTab; label: string; icon: typeof BarChart3 }[] = [
  { value: "overview", label: "Overview", icon: BarChart3 },
  { value: "packs", label: "Packs", icon: Package },
  { value: "battles", label: "Battles", icon: Swords },
  { value: "upgrader", label: "Upgrader", icon: TrendingUp },
  { value: "borrow", label: "Borrow", icon: HandCoins },
  { value: "users", label: "Top Users", icon: Users },
];

/**
 * Tab nav for /insights/games — preserves URL params (including
 * the active period) when switching tabs so the user's view
 * configuration sticks. Same fade-mask + scroll pattern as the
 * /analytics tab nav so phones can scroll the strip without losing
 * the off-screen-chip affordance.
 */
export function GamesTabNav() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const current = (searchParams.get("tab") ?? "overview") as GamesTab;

  function hrefFor(tab: GamesTab): string {
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
