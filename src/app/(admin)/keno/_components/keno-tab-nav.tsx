import Link from "next/link";
import { BarChart3, Settings2, Sigma } from "lucide-react";

import { cn } from "@/lib/utils";
import { KENO_TABS, type KenoTab } from "../tabs";
import type { AnalyticsPeriod } from "../../analytics/types";

const TAB_META: Record<
  KenoTab,
  { label: string; icon: typeof BarChart3 }
> = {
  overview: { label: "Overview", icon: BarChart3 },
  configuration: { label: "Configuration", icon: Settings2 },
  odds: { label: "Odds & Chances", icon: Sigma },
};

export function KenoTabNav({
  current,
  period,
}: {
  current: KenoTab;
  period: AnalyticsPeriod;
}) {
  return (
    <div
      role="tablist"
      aria-label="Keno workspace sections"
      className={cn(
        "flex gap-1 overflow-x-auto overscroll-x-contain rounded-lg border bg-muted/50 p-1",
        "[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
      )}
    >
      {KENO_TABS.map((value) => {
        const { label, icon: Icon } = TAB_META[value];
        const active = current === value;
        return (
          <Link
            key={value}
            role="tab"
            href={`/analytics?tab=games&g=keno&period=${period}&kenoTab=${value}`}
            replace
            prefetch={false}
            aria-selected={active}
            aria-current={active ? "page" : undefined}
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
