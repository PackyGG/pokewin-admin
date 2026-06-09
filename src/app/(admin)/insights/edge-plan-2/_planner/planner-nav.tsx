"use client";

import * as React from "react";

import type { LeverGroupId } from "./lever-rail";

/**
 * Active-group-only render wrapper for the planner workspace.
 *
 * The navigation chrome (vertical rail on `lg`+, horizontal scroll-pills
 * below) lives in `lever-rail.tsx`, which also owns the single source of
 * truth for the group ids (`LeverGroupId` / `LEVER_GROUPS`). This file keeps
 * only the perf wrapper: it returns `null` for any non-active group so a
 * heavy workspace (charts, dense slider clusters) never mounts until selected
 * — the active-window-only loading rule for tab/section pages.
 *
 * Shards + Future-levers (Ideas) were removed in the 2.0 rework; Raffles was
 * restored as a real cost workspace. The group set is now Edge · Rewards ·
 * Raffles · Withdrawals · Packs & signup.
 */
export function PlannerV2SectionPanel({
  id,
  active,
  children,
}: {
  id: LeverGroupId;
  active: LeverGroupId;
  children: React.ReactNode;
}) {
  if (id !== active) return null;
  return (
    <div className="space-y-4 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200">
      {children}
    </div>
  );
}
