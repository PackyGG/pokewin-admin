import {
  BarChart3,
  IdCard,
  Tv,
  Twitter,
  ShieldAlert,
  TrendingUp,
  Users,
  UsersRound,
  CalendarClock,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Creator detail tab bar.
 *
 * Tab set (owner-confirmed): Overview · Creator · Sessions · Kick · Twitter ·
 * Risk · Forecast · Cohorts & LTV · Alt Accounts.
 *
 * THIS WAVE builds ONLY the Overview tab — it's the single active tab.
 * Every other tab is rendered as a non-navigating "Soon" placeholder so the
 * eventual structure is visible without dead links AND nothing else is
 * eager-loaded (active-tab-only: a non-Overview tab never fetches its data
 * because it can't be selected yet). The future tabs land in later waves.
 *
 * Server-safe (no client state — Overview is statically the active tab in
 * this wave). Icons imported directly from lucide-react.
 */

type CreatorTab = {
  key: string;
  label: string;
  icon: LucideIcon;
  /** Placeholder (future wave) — rendered disabled, never navigates. */
  soon?: boolean;
};

const TABS: CreatorTab[] = [
  { key: "overview", label: "Overview", icon: TrendingUp },
  { key: "creator", label: "Creator", icon: IdCard, soon: true },
  { key: "sessions", label: "Sessions", icon: BarChart3, soon: true },
  { key: "kick", label: "Kick", icon: Tv, soon: true },
  { key: "twitter", label: "Twitter", icon: Twitter, soon: true },
  { key: "risk", label: "Risk", icon: ShieldAlert, soon: true },
  { key: "forecast", label: "Forecast", icon: CalendarClock, soon: true },
  { key: "cohorts", label: "Cohorts & LTV", icon: UsersRound, soon: true },
  { key: "alts", label: "Alt Accounts", icon: Users, soon: true },
];

export function CreatorTabBar() {
  return (
    <div
      role="tablist"
      aria-label="Creator detail sections"
      className="flex w-full items-center gap-1 overflow-x-auto rounded-xl border bg-muted/40 p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {TABS.map((tab) => {
        const Icon = tab.icon;
        // Overview is the only active tab this wave; everything else is a
        // disabled placeholder.
        const isActive = !tab.soon && tab.key === "overview";
        return (
          <div
            key={tab.key}
            role="tab"
            aria-selected={isActive}
            aria-disabled={tab.soon ? true : undefined}
            title={tab.soon ? `${tab.label} — coming in the next wave` : tab.label}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium",
              isActive
                ? "bg-background text-foreground shadow-sm ring-1 ring-border"
                : "cursor-default text-muted-foreground/70",
            )}
          >
            <Icon
              className={cn(
                "size-4",
                isActive ? "text-pink-500" : "text-muted-foreground/60",
              )}
            />
            <span>{tab.label}</span>
            {tab.soon && (
              <span className="ml-0.5 rounded-sm bg-muted px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                Soon
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
