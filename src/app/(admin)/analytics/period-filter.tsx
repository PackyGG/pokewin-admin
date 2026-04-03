"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";

const PERIODS = [
  { label: "Today", value: "today" },
  { label: "7d", value: "7d" },
  { label: "30d", value: "30d" },
  { label: "90d", value: "90d" },
  { label: "All", value: "all" },
] as const;

export function PeriodFilter() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const current = searchParams.get("period") ?? "30d";

  function handlePeriodChange(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("period", value);
    router.replace(`${pathname}?${params.toString()}`);
    router.refresh();
  }

  return (
    <div className="flex gap-1 rounded-lg border bg-muted/50 p-1">
      {PERIODS.map(({ label, value }) => (
        <button
          key={value}
          onClick={() => handlePeriodChange(value)}
          className={cn(
            "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
            current === value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
