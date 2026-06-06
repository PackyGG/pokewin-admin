"use server";

import { z } from "zod";

import { requireRole } from "@/lib/dal";
import { getCreatorChecklist } from "../_queries/onboarding-checklist-data";
import type { CreatorChecklistData } from "./onboarding-checklist-shared";

/**
 * Right-rail Onboarding-Checklist DOCK — server read action.
 *
 * The dock lives in the Creator-Hub `layout.tsx` right rail, so it cannot
 * receive the `creators/[id]` route param the way the page-mounted
 * `<CreatorChecklist>` server component does. Instead the dock is a client
 * island that reads the creator id from the pathname and pulls the checklist
 * through THIS action — only when the manager is actually on a creator detail
 * page (lazy / active-surface-only; nothing fetches on other Hub routes).
 *
 * Gate: `requireRole(['admin','creator_manager'])` — the SAME access set the
 * page + the manual checklist actions enforce, re-verified server-side against
 * the ADMIN DB. The client identity is never trusted.
 *
 * DB policy: reuses {@link getCreatorChecklist}, which reads MAIN/prod
 * READ-ONLY (PFP / socials / deals / leaderboards / api-key lookups) and writes
 * only the ADMIN-DB auto-hide snapshot. Nothing here loops or polls — the dock
 * fetches once per creator-detail mount.
 *
 * Returns `null` on an auth miss or a bad id so the dock simply renders nothing
 * rather than surfacing an opaque error in the rail.
 */

const userIdSchema = z.string().trim().min(1).max(128);

export async function fetchCreatorChecklistForDock(
  targetUserId: string,
): Promise<CreatorChecklistData | null> {
  try {
    await requireRole(["admin", "creator_manager"]);
  } catch {
    // requireRole redirects on a real auth miss; this guard keeps the action
    // from throwing an opaque error into the client dock.
    return null;
  }

  const parsed = userIdSchema.safeParse(targetUserId);
  if (!parsed.success) return null;

  try {
    return await getCreatorChecklist(parsed.data);
  } catch {
    // A hard failure (e.g. backend outage) → render nothing in the rail rather
    // than a broken dock. The page-level checklist already surfaces detail.
    return null;
  }
}
