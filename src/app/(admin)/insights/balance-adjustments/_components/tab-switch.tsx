"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  Sparkles,
  ArrowLeftRight,
  ShieldCheck,
  Users,
  ScrollText,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * URL-driven tab switcher for /insights/balance-adjustments.
 *
 * Five tabs:
 *   1. Overview          — KPI strip (volume, credits/debits, net, count,
 *                           distinct users, distinct admins) + daily chart
 *   2. Direction & Reason — credit vs debit split, reason breakdown,
 *                           adjustment-size distribution
 *   3. By Admin          — accountability: which admin moved how much
 *   4. By User           — top credited / top debited / high-frequency
 *   5. Audit trail       — forensic: recent adjustments, admin → user
 *
 * Active tab lives in `?tab=`. Period param survives every switch.
 */

const TABS = [
  { value: "overview", label: "Overview", Icon: Sparkles },
  { value: "direction", label: "Direction & Reason", Icon: ArrowLeftRight },
  { value: "admins", label: "By Admin", Icon: ShieldCheck },
  { value: "users", label: "By User", Icon: Users },
  { value: "audit", label: "Audit trail", Icon: ScrollText },
] as const;

export type BalanceAdjustmentTab = (typeof TABS)[number]["value"];

export function BalanceAdjustmentTabSwitch() {
  const searchParams = useSearchParams();
  const raw = searchParams.get("tab");
  const current: BalanceAdjustmentTab = (TABS.map((t) => t.value) as string[]).includes(
    raw ?? "",
  )
    ? (raw as BalanceAdjustmentTab)
    : "overview";
  const period = searchParams.get("period");
  const carryPeriod = period ? `period=${encodeURIComponent(period)}` : "";

  return (
    <div
      role="tablist"
      aria-label="Balance adjustments insights view"
      className="inline-flex flex-wrap rounded-lg border border-border/60 bg-muted/30 p-0.5"
    >
      {TABS.map(({ value, label, Icon }) => {
        const active = current === value;
        const tabParam = value === "overview" ? "" : `tab=${value}`;
        const params = [tabParam, carryPeriod].filter(Boolean).join("&");
        const href = params
          ? `/insights/balance-adjustments?${params}`
          : "/insights/balance-adjustments";
        return (
          <Link
            key={value}
            href={href}
            role="tab"
            aria-selected={active}
            replace
            scroll={false}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
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
