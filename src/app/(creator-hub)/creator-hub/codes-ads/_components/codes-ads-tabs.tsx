"use client";

import Link from "next/link";
import { Code, Megaphone } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  HUB_CODES_ADS_PATH,
  type CodesAdsTab,
} from "../_lib/tab";

const TABS: { key: CodesAdsTab; label: string; icon: typeof Code }[] = [
  { key: "codes", label: "Affiliate Codes", icon: Code },
  { key: "ads", label: "Ads", icon: Megaphone },
];

export function CodesAdsTabs({ current }: { current: CodesAdsTab }) {
  return (
    <nav className="flex flex-wrap gap-1 rounded-lg border border-pink-500/15 bg-background/40 p-1">
      {TABS.map((tab) => {
        const active = tab.key === current;
        const Icon = tab.icon;
        return (
          <Link
            key={tab.key}
            href={`${HUB_CODES_ADS_PATH}?tab=${tab.key}`}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors",
              active
                ? "bg-pink-500/15 text-pink-700 dark:text-pink-300"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <Icon className="size-3.5 shrink-0" />
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
