"use client";

import * as React from "react";
import { usePathname } from "next/navigation";

import { OnboardingChecklistPanel } from "./onboarding-checklist-client";
import type { CreatorChecklistData } from "./onboarding-checklist-shared";
import { fetchCreatorChecklistForDock } from "./checklist-dock-actions";

/**
 * Per-creator Onboarding-Checklist DOCK — the right-rail host.
 *
 * Owner spec: on the Creator Hub the onboarding checklist must be MORE visible
 * than the Live + Recent docks → it sits at the TOP of the right rail (above
 * them), expanded + accent-emphasised, and AUTO-HIDES per creator once every
 * item is complete.
 *
 * Why a client island (not a server component like `<CreatorChecklist>`): the
 * dock is mounted from `creator-hub/layout.tsx`, which has NO access to the
 * `creators/[id]` route param. This component reads the creator id from the
 * pathname instead, so it can live in the shared layout yet target the creator
 * currently being viewed.
 *
 * LAZY / active-surface-only (owner-mandated never-preload): it fetches NOTHING
 * unless the manager is on a `creators/[id]` detail page. On every other Hub
 * route it renders null and runs no query. The fetch fires once per creator
 * (keyed on the id) — no loop, no poll.
 *
 * Positioning: a `fixed` panel anchored at the rail's top (top-20, matching
 * `RAIL_TOP_REM`), 320px wide like the other docks, `z-40` so it sits ABOVE the
 * `z-30` live/recent rail — i.e. literally the top, most-prominent rail item.
 * The inner `OnboardingChecklistPanel` is itself collapsible, so a manager who
 * wants the rail tabs underneath can fold it; completing onboarding removes it
 * entirely and restores the rail.
 *
 * No function props cross the RSC boundary — the data comes from a server
 * action and the already-client `OnboardingChecklistPanel` renders it.
 */

/**
 * Extract the creator id from a Creator-Hub detail pathname.
 *
 * Matches ONLY `/creator-hub/creators/<id>` (optionally with a trailing slash) —
 * the single-segment detail route. The bare roster (`/creator-hub/creators`)
 * and any deeper/other path return null so the dock never shows off the detail
 * page. The id segment is decoded + sanity-checked (non-empty, no slash).
 */
function creatorIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/creator-hub\/creators\/([^/]+)\/?$/);
  if (!match) return null;
  let id: string;
  try {
    id = decodeURIComponent(match[1]);
  } catch {
    id = match[1];
  }
  id = id.trim();
  return id.length > 0 ? id : null;
}

export function CreatorChecklistDock() {
  const pathname = usePathname();
  const creatorId = creatorIdFromPath(pathname);

  const [data, setData] = React.useState<CreatorChecklistData | null>(null);
  // Track which creator the current `data` belongs to so a stale payload from a
  // previous creator never flashes while navigating between detail pages.
  const [loadedFor, setLoadedFor] = React.useState<string | null>(null);

  React.useEffect(() => {
    // Off the detail page → clear any prior payload and fetch nothing.
    if (!creatorId) {
      setData(null);
      setLoadedFor(null);
      return;
    }

    let alive = true;
    // Reset so the previous creator's checklist doesn't linger during the load.
    setData(null);
    setLoadedFor(null);

    fetchCreatorChecklistForDock(creatorId)
      .then((res) => {
        if (!alive) return;
        setData(res);
        setLoadedFor(creatorId);
      })
      .catch(() => {
        if (!alive) return;
        // Render nothing in the rail on failure — the page-level checklist
        // already surfaces detail; the dock stays quiet.
        setData(null);
        setLoadedFor(creatorId);
      });

    return () => {
      alive = false;
    };
  }, [creatorId]);

  // Not on a creator detail page, or nothing loaded yet for this creator.
  if (!creatorId || loadedFor !== creatorId || !data) return null;
  // Auto-hide once fully onboarded (matches the page-mounted panel).
  if (data.complete) return null;

  return (
    <div
      aria-label="Creator onboarding checklist"
      className="fixed right-0 top-20 z-40 w-[320px] max-w-[calc(100vw-1rem)] pr-2"
    >
      <div className="max-h-[min(60vh,32rem)] overflow-y-auto rounded-l-2xl">
        <OnboardingChecklistPanel data={data} />
      </div>
    </div>
  );
}
