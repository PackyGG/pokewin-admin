"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { LinkPendingShell } from "@/components/ux";

const PERIODS = [
  { label: "Today", value: "today" },
  { label: "7d", value: "7d" },
  { label: "30d", value: "30d" },
  { label: "90d", value: "90d" },
  { label: "All", value: "all" },
] as const;

export function PeriodFilter() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const current = searchParams.get("period") ?? "30d";

  return (
    <div className="flex gap-1 rounded-lg border bg-muted/50 p-1">
      {PERIODS.map(({ label, value }) => (
        <Link
          key={value}
          href={`${pathname}?period=${value}`}
          replace
          prefetch={false}
          className={cn(
            "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
            current === value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {/* Pending feedback: switching the period re-runs the page's
              server analytics fetch with no commit-time UI, so a slow
              window felt like a dead click. LinkPendingShell dims the
              label + appends a spinner only while THIS link's navigation
              is in flight (useLinkStatus). Motion-safe / no-op otherwise. */}
          <LinkPendingShell spinnerSize={12}>{label}</LinkPendingShell>
        </Link>
      ))}
    </div>
  );
}
