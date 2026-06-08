"use client";

import * as React from "react";
import {
  BarChart3,
  Boxes,
  Banknote,
  Gauge,
  Gem,
  Gift,
  Lightbulb,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";

export type PlannerV2SectionId =
  | "overview"
  | "gaming"
  | "rewards"
  | "shards"
  | "withdrawals"
  | "packs"
  | "ideas";

const SECTIONS: {
  id: PlannerV2SectionId;
  label: string;
  short: string;
  icon: LucideIcon;
}[] = [
  { id: "overview", label: "Overview", short: "Overview", icon: BarChart3 },
  { id: "gaming", label: "House edge", short: "Edge", icon: Gauge },
  { id: "rewards", label: "Rewards", short: "Rewards", icon: Gift },
  { id: "shards", label: "Shards economy", short: "Shards", icon: Gem },
  { id: "withdrawals", label: "Withdrawals", short: "Cash out", icon: Banknote },
  { id: "packs", label: "Packs & signup", short: "Packs", icon: Boxes },
  { id: "ideas", label: "Future levers", short: "Ideas", icon: Lightbulb },
];

export function PlannerV2SectionNav({
  active,
  onChange,
  className,
}: {
  active: PlannerV2SectionId;
  onChange: (id: PlannerV2SectionId) => void;
  className?: string;
}) {
  return (
    <nav
      className={cn(
        "flex gap-1 overflow-x-auto rounded-xl border bg-muted/40 p-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className,
      )}
      aria-label="Edge Plan 2.0 sections"
    >
      {SECTIONS.map((s) => {
        const Icon = s.icon;
        const isActive = s.id === active;
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => onChange(s.id)}
            title={s.label}
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
              isActive
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
            )}
          >
            <Icon className={cn("size-4", isActive && "text-violet-500")} />
            <span className="hidden md:inline">{s.label}</span>
            <span className="md:hidden">{s.short}</span>
          </button>
        );
      })}
    </nav>
  );
}

export function PlannerV2SectionPanel({
  id,
  active,
  children,
}: {
  id: PlannerV2SectionId;
  active: PlannerV2SectionId;
  children: React.ReactNode;
}) {
  if (id !== active) return null;
  return (
    <div className="space-y-4 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200">
      {children}
    </div>
  );
}
