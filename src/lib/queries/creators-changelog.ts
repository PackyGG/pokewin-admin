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
 * The audit `event_type`s this feed reads from the admin log. Each is a real
 * `createAdminAuditEvent({ eventType })` written by an existing flow:
 *   - user_made_creator          → src/app/(admin)/creators/actions.ts
 *                                   + creators/backend-actions.ts
 *   - creator_deal_created       → same two files
 *   - creator_deal_updated       → src/app/(admin)/creators/actions.ts
 *                                   + creators/backend-actions.ts (split %
 *                                   / status / sponsor-pool edits via the
 *                                   /creators/[userId]/deal surface)
 *   - creator_webhook_created    → src/app/(admin)/creators/actions.ts
 *                                   + my-profile/actions.ts (creator's own
 *                                   webhook self-edit)
 *   - creator_webhook_updated    → same two files
 *   - creator_webhook_deleted    → src/app/(admin)/creators/actions.ts
 *   - creator_force_reset_to_user→ src/app/(admin)/users/[id]/actions.ts
 *                                   (the "Reset to User Role" escape hatch)
 *   - role_changed               → src/app/(admin)/users/[id]/actions.ts
 *                                   (the generic role dropdown, used on both
 *                                   /creators/[userId] and /users/[id]). We
 *                                   read these to surface CREATOR REMOVALS:
 *                                   a creator fired back to a plain user via
 *                                   the dropdown writes `role_changed`, NOT
 *                                   `creator_force_reset_to_user`. Only rows
 *                                   whose metadata shows the creator role was
 *                                   specifically removed are kept (see
 *                                   `isCreatorRemoval` + the mapping below);
 *                                   every other role change is dropped.
 *   - excluded_user_added        → src/app/(admin)/system/excluded-users/actions.ts
 *   - excluded_user_removed      → same file
 *
 * NOTE this is the SQL read-set, which differs from the DISPLAY event set
 * (`CreatorChangelogEventType`): `role_changed` rows are re-projected to the
 * synthetic `creator_removed` display type (or filtered out), and never
 * surface under their raw `role_changed` type.
 */
const CHANGELOG_SOURCE_EVENT_TYPES = [
  "user_made_creator",
  "creator_deal_created",
  "creator_deal_updated",
  "creator_webhook_created",
  "creator_webhook_updated",
  "creator_webhook_deleted",
  "creator_force_reset_to_user",
  "role_changed",
  "excluded_user_added",
  "excluded_user_removed",
] as const;

/**
 * The DISPLAY event types the feed renders. Mirrors the source set above,
 * except `role_changed` is replaced by the synthetic `creator_removed`
 * (a creator fired back to a plain user) — the only role change this
 * creator-marketing feed cares about. Used as the `EVENT_DISPLAY` key set
 * and the KPI-tally key set.
 */
export const CREATOR_CHANGELOG_EVENT_TYPES = [
  "user_made_creator",
  "creator_deal_created",
  "creator_deal_updated",
  "creator_webhook_created",
  "creator_webhook_updated",
  "creator_webhook_deleted",
  "creator_force_reset_to_user",
  "creator_removed",
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
 *   - Updating an existing creator deal (split %, status, sponsor-pool
 *     %) is a routine config change → blue.
 *   - Creator webhook lifecycle (create / update / delete) is a routine
 *     integration plumbing event — blue for create/update, amber for
 *     delete (a wired integration was removed).
 *   - Resetting a creator back to a plain user via the escape hatch is a
 *     corrective action → amber.
 *   - Removing a creator (firing them back to a normal user via the role
 *     dropdown) is a corrective / negative action → rose.
 *   - Adding a user to the analytics-exclusion blacklist is a corrective /
 *     guarded action → amber. Removing one (re-including them in customer
 *     analytics) is the inverse → emerald.
 */
const EVENT_DISPLAY: Record<
  CreatorChangelogEventType,
  { label: string; tone: ChangelogTone }
> = {
  user_made_creator: { label: "Creator signed", tone: "blue" },
  creator_deal_created: { label: "Deal created", tone: "emerald" },
  creator_deal_updated: { label: "Deal updated", tone: "blue" },
  creator_webhook_created: { label: "Webhook created", tone: "blue" },
  creator_webhook_updated: { label: "Webhook updated", tone: "blue" },
  creator_webhook_deleted: { label: "Webhook deleted", tone: "amber" },
  creator_force_reset_to_user: { label: "Creator reset to user", tone: "amber" },
  creator_removed: { label: "Creator removed", tone: "rose" },
  excluded_user_added: { label: "User excluded", tone: "amber" },
  excluded_user_removed: { label: "Exclusion removed", tone: "emerald" },
};

/**
 * Decide whether a `role_changed` audit row represents a CREATOR REMOVAL —
 * i.e. someone fired/demoted from `creator` back to a non-creator role via
 * the role dropdown (which writes the generic `role_changed` event, not
 * `creator_force_reset_to_user`).
 *
 * `changeRole` stamps `{ prev_role, new_role }` onto the row. We keep only
 * rows where the PREVIOUS role was `creator` and the NEW role is anything
 * else. Rows missing `prev_role` (written before the metadata was enriched)
 * can't be classified and are dropped — past dropdown demotions therefore
 * can't be shown retroactively; only the escape-hatch removals
 * (`creator_force_reset_to_user`) were historically captured.
 */
function isCreatorRemoval(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object") return false;
  const m = metadata as Record<string, unknown>;
  return m.prev_role === "creator" && m.new_role !== "creator";
}

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
  //    relation — no cross-DB hop). event_type IN (...) is index-covered by
  //    admin_audit_events_event_type_created_idx. We read the SOURCE set
  //    (which includes generic `role_changed` rows) and re-project below —
  //    `role_changed` rows are kept only when they're a creator removal.
  const rows = await adminDb.admin_audit_events.findMany({
    where: {
      event_type: { in: [...CHANGELOG_SOURCE_EVENT_TYPES] },
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

  // Re-project the raw audit rows into DISPLAY events. Most source types map
  // 1:1 to their display type; `role_changed` is the exception — it's kept
  // ONLY when it's a creator removal (re-typed to the synthetic
  // `creator_removed`) and dropped otherwise. `flatMap` lets a row resolve to
  // zero events (a non-creator role change) or one. Ordering is preserved
  // (the query already sorts by created_at DESC and we don't reorder).
  return rows.flatMap((r): CreatorChangelogEvent[] => {
    // Normalize the raw audit type into the display type. A generic
    // `role_changed` becomes `creator_removed` when it fired a creator back
    // to a normal user; any other role change isn't a creator-marketing
    // event, so we drop it (return []).
    let eventType: CreatorChangelogEventType;
    if (r.event_type === "role_changed") {
      if (!isCreatorRemoval(r.metadata)) return [];
      eventType = "creator_removed";
    } else {
      // Constrained to the remaining union members by the WHERE clause, so
      // this cast is sound (Prisma types the column as a free string).
      eventType = r.event_type as CreatorChangelogEventType;
    }
    const display = EVENT_DISPLAY[eventType];
    return [
      {
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
      },
    ];
  });
}
