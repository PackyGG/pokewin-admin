"use client";

import { useState } from "react";
import Link from "next/link";
import { Activity, ArrowUpRight, Users } from "lucide-react";

import { cn } from "@/lib/utils";

type TabKey = "users" | "wagers";

type Props = {
  code: string;
  counts: { users: number; wagers: number };
  usersPanel: React.ReactNode;
  wagersPanel: React.ReactNode;
};

const TABS: Array<{
  key: TabKey;
  label: string;
  icon: React.ElementType;
}> = [
  { key: "users", label: "Users on code", icon: Users },
  { key: "wagers", label: "Last wagers", icon: Activity },
];

/**
 * Tabbed code-activity section for the creator detail page. Lays out
 * like a "small page within the page": a sticky pill-tab bar at the
 * top followed by the active tab's content full-width below, no Card
 * chrome wrapping the whole thing. Same visual language as the
 * pill-tab bar on /users/[id] — segmented pills, primary fill on the
 * active tab, scroll-into-view on phone.
 *
 * Both panels are pre-rendered server-side and kept mounted via CSS
 * `hidden`. Tab switch is purely visual, no RSC re-fetch on click.
 */
export function CodeActivityTabs({
  code,
  counts,
  usersPanel,
  wagersPanel,
}: Props) {
  const [tab, setTab] = useState<TabKey>("users");

  return (
    <section className="space-y-3">
      {/* Pill-tab bar — keeps the same row also when wrapping to mobile;
          counts hug each label so the active tab reads as
          "Users on code · 12". */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div
          role="tablist"
          aria-label="Code activity"
          className="inline-flex items-center gap-1 rounded-xl border bg-card/60 p-1"
        >
          {TABS.map((t) => {
            const Icon = t.icon;
            const isActive = tab === t.key;
            const count = t.key === "users" ? counts.users : counts.wagers;
            return (
              <button
                key={t.key}
                role="tab"
                type="button"
                aria-selected={isActive}
                onClick={() => setTab(t.key)}
                className={cn(
                  "inline-flex shrink-0 items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <Icon className="size-4" />
                <span>{t.label}</span>
                <span
                  className={cn(
                    "tabular-nums text-xs",
                    isActive
                      ? "text-primary-foreground/80"
                      : "text-muted-foreground/70",
                  )}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        {counts.users > 0 && tab === "users" && (
          <Link
            href={`/creators/codes/${code}`}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            Full breakdown
            <ArrowUpRight className="size-3" />
          </Link>
        )}
      </div>

      {/* Tab panels — both rendered server-side and kept mounted to
          avoid a flash on switch. `hidden` is the canonical no-paint
          way; aria-hidden mirrors the visual state for assistive tech. */}
      <div
        role="tabpanel"
        aria-labelledby="users-tab"
        hidden={tab !== "users"}
        aria-hidden={tab !== "users"}
      >
        {usersPanel}
      </div>
      <div
        role="tabpanel"
        aria-labelledby="wagers-tab"
        hidden={tab !== "wagers"}
        aria-hidden={tab !== "wagers"}
      >
        {wagersPanel}
      </div>
    </section>
  );
}
