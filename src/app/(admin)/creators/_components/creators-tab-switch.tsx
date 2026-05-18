"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { Coins, Zap } from "lucide-react";
import { cn } from "@/lib/utils";

const TABS = [
  { value: "fill", label: "Fill", Icon: Coins },
  { value: "multiplier", label: "Multiplier", Icon: Zap },
] as const;

/**
 * URL-driven Fill / Multiplier tab switcher for /creators. Each tab
 * shows only creators of that deal program. `fill` is the default and
 * carries no `?tab` param. Switching tabs drops `?page` (the pool
 * differs, so the old page number would be meaningless).
 */
export function CreatorsTabSwitch() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const current =
    searchParams.get("tab") === "multiplier" ? "multiplier" : "fill";

  function go(tab: string) {
    if (tab === current) return;
    const params = new URLSearchParams(searchParams.toString());
    if (tab === "fill") params.delete("tab");
    else params.set("tab", tab);
    params.delete("page");
    startTransition(() => {
      router.replace(`?${params.toString()}`, { scroll: false });
    });
  }

  return (
    <div
      role="tablist"
      aria-label="Creator deal program"
      className="inline-flex rounded-lg border border-border/60 bg-muted/30 p-0.5"
    >
      {TABS.map(({ value, label, Icon }) => {
        const active = current === value;
        return (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => go(value)}
            disabled={isPending}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-60",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-3.5" />
            {label}
          </button>
        );
      })}
    </div>
  );
}
