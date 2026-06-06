"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Code, Megaphone, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { LinkPendingShell } from "@/components/ux";

const TABS: { key: "codes" | "ads"; label: string; href: string; icon: LucideIcon }[] =
  [
    {
      key: "codes",
      label: "Codes",
      href: "/creator-hub/codes-ads/codes",
      icon: Code,
    },
    {
      key: "ads",
      label: "Ads",
      href: "/creator-hub/codes-ads/ads",
      icon: Megaphone,
    },
  ];

/** Tab strip for the Codes & Ads list views (not shown on detail routes). */
export function CodesAdsTabBar() {
  const pathname = usePathname();
  const active =
    pathname === "/creator-hub/codes-ads/ads" ||
    pathname.startsWith("/creator-hub/codes-ads/ads/")
      ? "ads"
      : "codes";

  return (
    <div className="flex gap-1 overflow-x-auto rounded-xl border bg-muted/30 p-1">
      {TABS.map((tab) => {
        const Icon = tab.icon;
        const isActive = active === tab.key;
        return (
          <Link
            key={tab.key}
            href={tab.href}
            prefetch={false}
            className={cn(
              "inline-flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
              isActive
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <LinkPendingShell>
              <Icon
                className={cn(
                  "size-4 shrink-0",
                  isActive ? "text-pink-500" : "text-muted-foreground/60",
                )}
              />
              <span>{tab.label}</span>
            </LinkPendingShell>
          </Link>
        );
      })}
    </div>
  );
}
