"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  Sparkles,
  Gift,
  Percent,
  Trophy,
  Share2,
  UserPlus,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { LinkPending } from "@/components/ux";

/**
 * URL-driven category tab switcher for /rewards/analytics — Overview /
 * Deposit Bonus / Rakeback / Race / Affiliate / Sign Up.
 *
 * Mirrors the pattern on /ggr (`ggr-window-switch.tsx`) and /creators
 * (`creators-tab-switch.tsx`): plain `<Link>` (not router.replace) so
 * the active tab survives reload + ⌘-click into a new tab, and the
 * server component re-runs the category-specific query on every swap.
 * `replace` keeps history clean.
 *
 * The active category lives in the `?category=` URL param; the
 * default (`overview`) carries no `?category` param so a bare
 * `/rewards/analytics` deep-link lands on it. Every link preserves
 * the current `?period=` so flipping categories doesn't reset the
 * window the admin picked.
 */

const TABS = [
  { value: "overview", label: "Overview", Icon: Sparkles },
  { value: "deposit-bonus", label: "Deposit Bonus", Icon: Gift },
  { value: "rakeback", label: "Rakeback", Icon: Percent },
  { value: "race", label: "Race", Icon: Trophy },
  { value: "affiliate", label: "Affiliate", Icon: Share2 },
  { value: "signup", label: "Sign Up", Icon: UserPlus },
] as const;

export type RewardsAnalyticsCategory = (typeof TABS)[number]["value"];

export function RewardsAnalyticsTabSwitch() {
  const searchParams = useSearchParams();
  const rawCategory = searchParams.get("category");
  const current: RewardsAnalyticsCategory =
    rawCategory === "deposit-bonus" ||
    rawCategory === "rakeback" ||
    rawCategory === "race" ||
    rawCategory === "affiliate" ||
    rawCategory === "signup"
      ? rawCategory
      : "overview";
  // Preserve the period param so flipping tabs doesn't reset the
  // window. Drop `category` from the carry-over so the per-tab href
  // can append its own (or omit it for Overview).
  const period = searchParams.get("period");
  const carryPeriod = period ? `period=${encodeURIComponent(period)}` : "";

  return (
    <div
      role="tablist"
      aria-label="Reward analytics category"
      className="inline-flex flex-wrap rounded-lg border border-border/60 bg-muted/30 p-0.5"
    >
      {TABS.map(({ value, label, Icon }) => {
        const active = current === value;
        // Overview is the default — keeps the URL clean when admins
        // navigate there.
        const tabParam = value === "overview" ? "" : `category=${value}`;
        const params = [tabParam, carryPeriod].filter(Boolean).join("&");
        const href = params ? `/rewards/analytics?${params}` : "/rewards/analytics";
        return (
          <Link
            key={value}
            href={href}
            role="tab"
            aria-selected={active}
            // `replace` so the tab switch doesn't pollute browser
            // history with every flip, but reload + ⌘-click still work
            // because it's a real navigation.
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
            {/* Inline pending cue for THIS tab's navigation (each tab is
                its own server fetch). Shows only while the click is in
                flight, so a slow category swap never reads as a dead tap. */}
            <LinkPending size={13} className="ml-0" />
          </Link>
        );
      })}
    </div>
  );
}
