import "server-only";

import { getDb } from "@/lib/db";
import { adminDb } from "@/lib/admin-db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import type { CreatorListItem } from "@/lib/backend-api";
import type { CreatorsSearchParams } from "../_lib/search-params";
import type { CreatorsListPage } from "./list-creators";

/**
 * list-ex-creators.ts — the "Canceled / Past creators" tab for /creators.
 *
 * The active /creators list is sourced from the packy.gg backend
 * (`creatorsApi.list`), which only returns users whose CURRENT role is
 * `creator`. Anyone whose creator role was removed (deal cancelled, role
 * stripped, retired) drops off that list entirely and their historical
 * data becomes invisible. This query reconstructs that set from the DB so
 * the owner can still see them.
 *
 * ─── Ex-creator identification (artifact-anchored source of truth) ──────
 *
 * An EX-creator is any user whose CURRENT role is NOT `creator` AND who
 * has at least one creator-specific artifact in either DB. The artifact
 * set spans every creator-only relation we've ever written:
 *
 *   Main DB (game / affiliate side):
 *     • `affiliate_codes`              (a creator-only mintable resource)
 *     • `creator_withdrawal_limits`    (creator-only withdrawal config)
 *     • `affiliate_payouts`            (creator-only payout flow)
 *
 *   Admin DB (admin-portal side):
 *     • `creator_deals`                (target_user_id)
 *     • `creator_webhooks`             (target_user_id)
 *     • `creator_socials`              (target_user_id)
 *     • `creator_balance_fills`        (target_user_id)
 *     • `admin_audit_events` of type
 *         - `user_made_creator`        (admin-panel promotion)
 *         - `creator_deal_created`     (had a deal created — audit-level
 *                                       evidence even if the deal row was
 *                                       since deleted)
 *         - `creator_force_reset_to_user` (explicit escape-hatch demotion)
 *         - `role_changed` with `metadata.new_role = 'creator'`
 *           (the user-detail dropdown's promotion path)
 *         - `role_changed` with `metadata.prev_role = 'creator'` AND
 *           `metadata.new_role <> 'creator'` (post-1001be2 enriched
 *           dropdown demotion — was a creator, now isn't)
 *
 * The two new admin-audit signals (`creator_deal_created`,
 * `creator_force_reset_to_user`) and the three new admin-DB tables
 * (`creator_deals`, `creator_webhooks`, `creator_socials`,
 * `creator_balance_fills`) close the original detection gap: a user
 * demoted via the role dropdown BEFORE the metadata gained `prev_role`
 * had no `affiliate_codes` and no `role_changed → creator` row
 * (the dropdown writes a `role_changed → <new>` event, not a
 * promotion-to-creator one) but DID have e.g. a creator_deal_created
 * audit row, a creator_socials approval row, or a creator_deals row in
 * the admin DB. Now any of those alone surfaces them.
 *
 * Dual-DB: artifacts live across BOTH databases. Per the strict
 * no-cross-DB-join rule, the candidate id set is unioned in code: the
 * Main DB hands back its creator-only-table user_ids, the Admin DB hands
 * back its creator-table + audit user_ids, and we union them before
 * resolving identities back from the Main DB user table.
 *
 * Filters applied at resolve time:
 *   • `user.role <> 'creator'` — drops anyone who's currently a creator
 *     (they belong on the active roster, not here).
 *   • `user.id NOT IN excluded_users` — drops the analytics blacklist
 *     (those users are intentionally hidden from creator analytics
 *     surfaces; same rule the rest of /creators uses).
 *
 * Staff (`admin` / `support`) are deliberately KEPT — a creator demoted
 * to support is still a "past creator" the owner wants to see; only the
 * CURRENT-creator gate (`role = 'creator'`) excludes the active roster.
 */

/**
 * Resolve the set of user IDs that have ever been creators, by querying
 * every creator-specific artifact source. Each source is queried with a
 * single DISTINCT statement; their results are unioned in memory.
 *
 * Returns the candidate set as a JS Set so callers can intersect it
 * against the Main-DB user table (which carries the current role).
 */
async function getEverCreatorCandidateIds(): Promise<Set<string>> {
  const db = await getDb();

  // Main DB artifacts: distinct user_ids from each creator-only table.
  // These run on the same DB so we issue them in parallel.
  const [codeOwners, withdrawalLimitOwners, payoutOwners] = await Promise.all([
    db.$queryRawUnsafe<{ user_id: string }[]>(
      `SELECT DISTINCT user_id FROM affiliate_codes WHERE user_id IS NOT NULL`,
    ),
    db.$queryRawUnsafe<{ user_id: string }[]>(
      `SELECT DISTINCT user_id FROM creator_withdrawal_limits WHERE user_id IS NOT NULL`,
    ),
    db.$queryRawUnsafe<{ affiliate_user_id: string }[]>(
      `SELECT DISTINCT affiliate_user_id FROM affiliate_payouts WHERE affiliate_user_id IS NOT NULL`,
    ),
  ]);

  // Admin DB artifacts: distinct target_user_ids from each creator-only
  // table + audit events. Same parallel-on-one-DB pattern.
  const [
    dealTargets,
    webhookTargets,
    socialTargets,
    fillTargets,
    audits,
  ] = await Promise.all([
    adminDb.creator_deals.findMany({
      select: { target_user_id: true },
      distinct: ["target_user_id"],
    }),
    adminDb.creator_webhooks.findMany({
      select: { target_user_id: true },
      distinct: ["target_user_id"],
    }),
    adminDb.creator_socials.findMany({
      select: { target_user_id: true },
      distinct: ["target_user_id"],
    }),
    adminDb.creator_balance_fills.findMany({
      select: { target_user_id: true },
      distinct: ["target_user_id"],
    }),
    // Audit rows we care about — the four creator-signal event types +
    // `role_changed` (which we then split client-side on metadata so we
    // catch BOTH promotion-to-creator and demotion-from-creator rows).
    adminDb.admin_audit_events.findMany({
      where: {
        event_type: {
          in: [
            "user_made_creator",
            "creator_deal_created",
            "creator_force_reset_to_user",
            "role_changed",
          ],
        },
        target_user_id: { not: null },
      },
      select: { event_type: true, target_user_id: true, metadata: true },
    }),
  ]);

  const candidateIds = new Set<string>();

  // Add Main-DB candidates.
  for (const r of codeOwners) candidateIds.add(r.user_id);
  for (const r of withdrawalLimitOwners) candidateIds.add(r.user_id);
  for (const r of payoutOwners) candidateIds.add(r.affiliate_user_id);

  // Add Admin-DB table candidates.
  for (const r of dealTargets) candidateIds.add(r.target_user_id);
  for (const r of webhookTargets) candidateIds.add(r.target_user_id);
  for (const r of socialTargets) candidateIds.add(r.target_user_id);
  for (const r of fillTargets) candidateIds.add(r.target_user_id);

  // Add Admin-DB audit candidates. The four creator-marketing event types
  // count outright (any of them means the user was, at some point, in the
  // creator program). `role_changed` is the dropdown path — keep it only
  // when the metadata actually identifies a creator role on either side
  // of the transition. This catches the gap the original detection
  // missed: dropdown demotions (`prev_role = 'creator'`) without an
  // affiliate-code artifact were previously invisible.
  for (const e of audits) {
    if (!e.target_user_id) continue;
    if (e.event_type !== "role_changed") {
      candidateIds.add(e.target_user_id);
      continue;
    }
    const meta =
      e.metadata && typeof e.metadata === "object" && !Array.isArray(e.metadata)
        ? (e.metadata as Record<string, unknown>)
        : {};
    const wasCreator = meta.prev_role === "creator";
    const becameCreator = meta.new_role === "creator";
    if (wasCreator || becameCreator) candidateIds.add(e.target_user_id);
  }

  return candidateIds;
}

/**
 * The set of user IDs that were creators but no longer hold the creator
 * role. Resolves the candidate set, intersects against Main-DB users
 * with `role <> 'creator'`, applies the analytics blacklist, and
 * returns the resolved user records (id/username/email/image/created_at)
 * so the caller can shape them into the list rows directly.
 *
 * Search is applied at the DB level (username / email ilike) so the
 * Past tab search filters the whole ex-creator set, not just the first
 * page slice.
 */
async function getExCreatorUsers(search?: string): Promise<
  {
    id: string;
    username: string | null;
    email: string | null;
    image: string | null;
    created_at: Date;
  }[]
> {
  const [candidateIds, excludedIds] = await Promise.all([
    getEverCreatorCandidateIds(),
    getExcludedUserIds(),
  ]);
  if (candidateIds.size === 0) return [];

  const db = await getDb();

  // Resolve user records for every candidate, enforcing:
  //   • `role != 'creator'` — current creators belong on the active
  //     roster, not here.
  //   • `id NOT IN excluded_users` — the analytics blacklist hides
  //     users from creator-analytics surfaces; honour it here too so the
  //     past-creator KPI tile and list match the rest of /creators.
  //   • optional username/email contains-search (case-insensitive),
  //     applied at the DB so the search is exhaustive (not page-bounded).
  // Ordered newest-first so the most recently touched ex-creators surface
  // at the top.
  const users = await db.user.findMany({
    where: {
      id: { in: [...candidateIds] },
      role: { not: "creator" },
      ...(excludedIds.length > 0 ? { NOT: { id: { in: excludedIds } } } : {}),
      ...(search && search.trim()
        ? {
            OR: [
              { username: { contains: search.trim(), mode: "insensitive" } },
              { email: { contains: search.trim(), mode: "insensitive" } },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      username: true,
      email: true,
      image: true,
      created_at: true,
    },
    orderBy: { created_at: "desc" },
  });

  return users;
}

/**
 * Paginated ex-creator list shaped as `CreatorsListPage` so the page can
 * render it through the SAME card/list components as the active roster.
 *
 * Each row is a synthesized `CreatorListItem`: identity fields are real
 * (id/username/email/image/created_at); the live/deal fields are forced
 * to their "no active deal" state — an ex-creator has no current deal or
 * live session by definition, so `current_deal: null`,
 * `active_session_id: null`, `total_deals_count: 0`. The downstream
 * enrichment (`getCodeAndWagerByUser`, socials) runs on the resulting ids
 * exactly as it does for active creators, so the code / wager volume /
 * signups / FTDs / momentum columns populate from each ex-creator's full
 * historical affiliate activity.
 *
 * Pagination is applied in memory (the set is small — a handful to low
 * tens of past creators), mirroring `getCreatorsListForTab`. Search is
 * already applied inside `getExCreatorUsers` at the DB level.
 */
export async function getExCreatorsList(
  params: CreatorsSearchParams,
): Promise<CreatorsListPage> {
  const users = await getExCreatorUsers(params.search);

  const data: CreatorListItem[] = users.map((u) => ({
    id: u.id,
    username: u.username,
    email: u.email,
    image: u.image,
    // The synthesized row carries `role: "user"` purely as a type
    // placeholder — the card/list components never read `role`; they key
    // every link + stat off `id`. The actual current role is whatever the
    // backend demoted them to; it's irrelevant to this surface.
    role: "user",
    created_at: u.created_at.toISOString(),
    current_deal: null,
    active_session_id: null,
    total_deals_count: 0,
  }));

  const total = data.length;
  const start = (params.page - 1) * params.perPage;
  return {
    data: data.slice(start, start + params.perPage),
    total,
    page: params.page,
    perPage: params.perPage,
    totalPages: Math.max(1, Math.ceil(total / params.perPage)),
  };
}

/**
 * Count of ex/canceled creators — drives the KPI swap-tile on the Past-
 * creators tab. Same identification as `getExCreatorsList`, no search.
 */
export async function getExCreatorCount(): Promise<number> {
  const users = await getExCreatorUsers();
  return users.length;
}
