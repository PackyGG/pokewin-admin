import { adminDb } from "@/lib/admin-db";
import { getDb } from "@/lib/db";
import { withTimeout, isQueryTimeoutError } from "@/lib/errors/safe-query";
import { logError } from "@/lib/errors/logger";
import {
  periodToCutoff,
  type DashboardPeriod,
} from "@/lib/queries/dashboard-period";

/**
 * Creator Marketing → Changelog feed.
 *
 * A time-ordered, read-only feed of the creator-marketing admin actions
 * that already flow into the admin audit log (`admin_audit_events`). It is
 * NOT a new audit pipeline — it's a focused lens over the existing one,
 * filtered to the handful of `event_type`s that change a user's creator
 * standing or their analytics-exclusion status.
 *
 * DUAL-DB (mirrors `src/lib/queries/audit.ts`):
 *   - The audit rows live in the ADMIN DB (`adminDb`). The acting employee's
 *     username is the admin DB's own `admin_users` relation, so it comes back
 *     via `include` on the same query — no extra hop.
 *   - The TARGET is a main-DB user (the `target_user_id` column references the
 *     main DB's text `user.id`). There is NO cross-DB join, so target
 *     usernames are resolved in a SEPARATE `db.user.findMany({ id: { in } })`
 *     against the MAIN DB and folded back in via an in-memory map.
 *   - That single main-DB hit is wrapped in `withTimeout` + try/catch so a
 *     slow/unavailable main DB degrades to raw ids (the feed still renders
 *     every event, just without resolved usernames) instead of throwing away
 *     the whole page.
 */

// Wall-clock budget for the cross-DB main-DB username resolution. This is a
// single bounded, indexed point-lookup by id — it finishes well under a
// second on prod-sized data; the timeout only fires if the main DB is
// genuinely slow/unavailable, in which case the feed degrades to raw target
// ids rather than blocking the whole /creators/changelog route. Matches the
// short budget the sibling /audit query uses for the same kind of lookup.
const CHANGELOG_MAIN_DB_TIMEOUT_MS = 8_000;

/**
 * The creator-marketing event types this feed surfaces. Each is a real
 * `createAdminAuditEvent({ eventType })` written by an existing flow:
 *   - user_made_creator          → src/app/(admin)/creators/actions.ts
 *                                   + creators/backend-actions.ts
 *   - creator_deal_created       → same two files
 *   - creator_force_reset_to_user→ src/app/(admin)/users/[id]/actions.ts
 *   - excluded_user_added        → src/app/(admin)/system/excluded-users/actions.ts
 *   - excluded_user_removed      → same file
 */
export const CREATOR_CHANGELOG_EVENT_TYPES = [
  "user_made_creator",
  "creator_deal_created",
  "creator_force_reset_to_user",
  "excluded_user_added",
  "excluded_user_removed",
] as const;

export type CreatorChangelogEventType =
  (typeof CREATOR_CHANGELOG_EVENT_TYPES)[number];

/** House-POV accent for an event's badge (per CLAUDE.md color rules). */
export type ChangelogTone = "emerald" | "blue" | "amber" | "rose";

export type CreatorChangelogEvent = {
  id: string;
  eventType: CreatorChangelogEventType;
  /** Human-readable label for the badge. */
  label: string;
  /** House-POV tone for the badge. */
  tone: ChangelogTone;
  adminUserId: string | null;
  /** Acting employee's username (admin DB), or null for system/deleted. */
  adminUsername: string | null;
  /** Target main-DB user id (text), or null. */
  targetUserId: string | null;
  /** Resolved target username from the MAIN DB, or null if unresolved. */
  targetUsername: string | null;
  /** Raw audit metadata JSON (already in the admin DB row). */
  metadata: unknown;
  createdAt: string;
};

/**
 * Per-event display metadata. The tone follows CLAUDE.md's house-POV rule:
 *   - A user becoming a creator / getting a creator deal is a normal,
 *     positive marketing event → emerald (deal) / blue (signed up as
 *     creator, a status event).
 *   - Demoting a creator back to a plain user is a corrective action →
 *     amber.
 *   - Adding a user to the analytics-exclusion blacklist is a corrective /
 *     guarded action → rose. Removing one (re-including them in customer
 *     analytics) is the inverse → emerald.
 */
const EVENT_DISPLAY: Record<
  CreatorChangelogEventType,
  { label: string; tone: ChangelogTone }
> = {
  user_made_creator: { label: "Creator signed", tone: "blue" },
  creator_deal_created: { label: "Deal created", tone: "emerald" },
  creator_force_reset_to_user: { label: "Creator reset to user", tone: "amber" },
  excluded_user_added: { label: "User excluded", tone: "amber" },
  excluded_user_removed: { label: "Exclusion removed", tone: "emerald" },
};

/**
 * Load the creator-marketing changelog for a period.
 *
 * @param period a `DashboardPeriod` chip (default `48h`) → SQL cutoff via
 *   `periodToCutoff`. Only rows with `created_at >= cutoff` are returned,
 *   newest first. The `all` sentinel maps to the unix epoch so the filter
 *   degrades to "everything" without a special branch.
 *
 *   The default matches the /creators 48h floor (`CREATORS_MIN_PERIOD`): the
 *   changelog only ever exposes 48h+ windows (the sub-48h chips are hidden +
 *   clamped away on the page), so the query's own fallback agrees with the
 *   rendered chip set on mount.
 */
export async function getCreatorsChangelogEvents({
  period = "48h",
}: {
  period?: DashboardPeriod;
} = {}): Promise<CreatorChangelogEvent[]> {
  const cutoff = periodToCutoff(period, new Date());

  // 1) Admin DB: the audit rows + the acting employee's username (its own
  //    relation — no cross-DB hop). event_type IN (...) is index-covered.
  const rows = await adminDb.admin_audit_events.findMany({
    where: {
      event_type: { in: [...CREATOR_CHANGELOG_EVENT_TYPES] },
      created_at: { gte: cutoff },
    },
    orderBy: { created_at: "desc" },
    include: {
      admin_user: { select: { username: true } },
    },
  });

  // 2) Main DB: resolve target usernames in ONE separate query (no cross-DB
  //    join), folded back via an in-memory map. Bounded + degrade-on-failure.
  const targetIds = [
    ...new Set(rows.map((r) => r.target_user_id).filter(Boolean)),
  ] as string[];

  let targetUserMap = new Map<string, string | null>();
  if (targetIds.length > 0) {
    try {
      const db = await getDb();
      const users = await withTimeout(
        () =>
          db.user.findMany({
            where: { id: { in: targetIds } },
            select: { id: true, username: true },
          }),
        CHANGELOG_MAIN_DB_TIMEOUT_MS,
      );
      targetUserMap = new Map(users.map((u) => [u.id, u.username]));
    } catch (err) {
      if (isQueryTimeoutError(err)) {
        logError(
          "creators.changelog.resolveTargets",
          "main-DB username resolution timed out",
          err,
        );
      } else {
        logError(
          "creators.changelog.resolveTargets",
          "main-DB username resolution failed",
          err,
        );
      }
      // Degrade: leave the map empty → events render with raw target ids.
    }
  }

  return rows.map((r) => {
    // event_type is already constrained to the union by the WHERE clause,
    // so this cast is sound (Prisma types the column as a free string).
    const eventType = r.event_type as CreatorChangelogEventType;
    const display = EVENT_DISPLAY[eventType];
    return {
      id: r.id,
      eventType,
      label: display.label,
      tone: display.tone,
      adminUserId: r.admin_user_id,
      adminUsername: r.admin_user?.username ?? null,
      targetUserId: r.target_user_id,
      targetUsername: r.target_user_id
        ? targetUserMap.get(r.target_user_id) ?? null
        : null,
      metadata: r.metadata,
      createdAt: r.created_at.toISOString(),
    };
  });
}
