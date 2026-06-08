"use client";

import * as React from "react";
import {
  BarChart3,
  Boxes,
  Gauge,
  Gift,
  Lightbulb,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";

export type PlannerSectionId =
  | "overview"
  | "gaming"
  | "rewards"
  | "packs"
  | "ideas";

const SECTIONS: {
  id: PlannerSectionId;
  label: string;
  short: string;
  icon: LucideIcon;
}[] = [
  { id: "overview", label: "Overview & charts", short: "Overview", icon: BarChart3 },
  { id: "gaming", label: "House edge", short: "Edge", icon: Gauge },
  { id: "rewards", label: "Rewards & promos", short: "Rewards", icon: Gift },
  { id: "packs", label: "Packs & signup", short: "Packs", icon: Boxes },
  { id: "ideas", label: "Future levers", short: "Ideas", icon: Lightbulb },
];

export function PlannerSectionNav({
  active,
  onChange,
  className,
}: {
  active: PlannerSectionId;
  onChange: (id: PlannerSectionId) => void;
  className?: string;
}) {
  return (
    <nav
      className={cn(
        "flex gap-1 overflow-x-auto rounded-xl border bg-muted/40 p-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className,
      )}
      aria-label="Planner sections"
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
            <Icon className={cn("size-4", isActive && "text-cyan-500")} />
            <span className="hidden sm:inline">{s.label}</span>
            <span className="sm:hidden">{s.short}</span>
          </button>
        );
      })}
    </nav>
  );
}

export function PlannerSectionPanel({
  id,
  active,
  children,
  className,
}: {
  id: PlannerSectionId;
  active: PlannerSectionId;
  children: React.ReactNode;
  className?: string;
}) {
  if (id !== active) return null;
  return (
    <div className={cn("space-y-5 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200", className)}>
      {children}
    </div>
  );
}
