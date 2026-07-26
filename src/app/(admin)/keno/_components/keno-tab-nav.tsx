"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { BarChart3, Settings2, Sigma } from "lucide-react";

import { Spinner } from "@/components/ux";
import { cn } from "@/lib/utils";
import { KENO_TABS, type KenoTab } from "../tabs";

const TAB_META: Record<
  KenoTab,
  { label: string; icon: typeof BarChart3 }
> = {
  overview: { label: "Overview", icon: BarChart3 },
  configuration: { label: "Configuration", icon: Settings2 },
  odds: { label: "Odds & Chances", icon: Sigma },
};

export function KenoTabNav() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const current = (searchParams.get("tab") ?? "overview") as KenoTab;
  const [isPending, startTransition] = useTransition();

  function hrefFor(tab: KenoTab): string {
    return `${pathname}?tab=${tab}`;
  }

  function go(tab: KenoTab) {
    if (tab === current) return;
    startTransition(() => {
      router.replace(hrefFor(tab), { scroll: false });
    });
  }

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
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={active}
            aria-current={active ? "page" : undefined}
            disabled={active}
            onClick={() => go(value)}
            onMouseEnter={() => router.prefetch(hrefFor(value))}
            onFocus={() => router.prefetch(hrefFor(value))}
            className={cn(
              "flex shrink-0 scroll-mx-4 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
              isPending && !active && "opacity-50",
            )}
          >
            {active && isPending ? (
              <Spinner size={14} label={`Loading ${label}`} />
            ) : (
              <Icon className="size-3.5" />
            )}
            {label}
          </button>
        );
      })}
    </div>
  );
}
