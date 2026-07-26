"use client";

import { BellRing, Settings2 } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

import { Spinner } from "@/components/ux";
import { cn } from "@/lib/utils";

export type SettingsTab = "general" | "discord";

const TABS: Array<{
  value: SettingsTab;
  label: string;
  icon: typeof Settings2;
}> = [
  { value: "general", label: "General", icon: Settings2 },
  { value: "discord", label: "Discord", icon: BellRing },
];

export function SettingsTabNav({ active }: { active: SettingsTab }) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  function hrefFor(tab: SettingsTab): string {
    const params = new URLSearchParams(searchParams.toString());
    if (tab === "general") params.delete("tab");
    else params.set("tab", tab);
    const query = params.toString();
    return query ? `${pathname}?${query}` : pathname;
  }

  function select(tab: SettingsTab) {
    if (tab === active) return;
    startTransition(() => router.replace(hrefFor(tab), { scroll: false }));
  }

  return (
    <div
      role="tablist"
      aria-label="Antifraud settings"
      className="flex w-fit gap-1 rounded-lg border bg-muted/50 p-1"
    >
      {TABS.map(({ value, label, icon: Icon }) => {
        const selected = value === active;
        return (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={selected}
            disabled={selected}
            onClick={() => select(value)}
            onMouseEnter={() => router.prefetch(hrefFor(value))}
            onFocus={() => router.prefetch(hrefFor(value))}
            className={cn(
              "flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium motion-safe:transition-colors",
              selected
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {selected && pending ? (
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
