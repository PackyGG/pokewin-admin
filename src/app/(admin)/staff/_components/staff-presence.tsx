"use client";

import { useEffect } from "react";

import { recordCurrentStaffPresence } from "../presence-action";

let recordedThisPageLoad = false;

/**
 * Best-effort presence heartbeat. It runs after hydration, so a transient
 * ADMIN write failure can never fail a Server Component render or build.
 */
export function StaffPresence() {
  useEffect(() => {
    if (recordedThisPageLoad) return;
    recordedThisPageLoad = true;
    void recordCurrentStaffPresence().catch(() => {
      // Presence is optional telemetry; the staff workspace remains usable.
    });
  }, []);

  return null;
}
