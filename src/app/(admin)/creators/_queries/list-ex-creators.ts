import "server-only";

import { getDb } from "@/lib/db";
import { adminDb } from "@/lib/admin-db";
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
 * ─── Ex-creator identification (authoritative signal) ────────────────
 *
 * Mirrors the EXACT "was a creator" rule the user-detail page already
 * uses (src/app/(admin)/users/[id]/page.tsx:219-223):
 *
 *   everCreator = role === 'creator'
 *               OR everCreatorByAudit            (admin audit role_changed → creator)
 *               OR ownedCodes.length > 0         (affiliate_codes — a creator-only artifact)
 *   wasCreator  = everCreator AND role !== 'creator'
 *
 * So an EX-creator is a user with `role != 'creator'` who EITHER owns at
 * least one `affiliate_codes` row OR has an admin audit `role_changed`
 * event whose `metadata.new_role === 'creator'`. The same two creator-
 * only artifacts `getUserCreatorHistory` + the user-detail `everCreator`
 * derive the past-creator badge from.
 *
 * Dual-DB: `affiliate_codes` lives in the Main DB; the role-change audit
 * trail lives in the Admin DB. Per the strict no-cross-DB-join rule, each
 * side is queried independently and the user-id sets are unioned in code.
 * Staff (admin/support) are deliberately KEPT here — a creator demoted to
 * support is still a "past creator" the owner wants to see; only the
 * CURRENT-creator gate (`role = 'creator'`) excludes the active roster.
 */

/**
 * The set of user IDs that were creators but no longer hold the creator
 * role. Union of:
 *   • Main DB — users with `role != 'creator'` who own ≥1 affiliate_codes
 *     row (creator-only artifact).
 *   • Admin DB — users with an admin audit `role_changed` event whose
 *     `metadata.new_role = 'creator'`, intersected against `role !=
 *     'creator'` (verified against the Main DB role below).
 *
 * Returns the resolved user records (id/username/email/image/created_at)
 * so the caller can shape them into the list rows directly.
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
  const db = await getDb();

  // ── Signal A (Main DB): current non-creators who own an affiliate code.
  // affiliate_codes is populated exclusively for creators (the
  // affiliate.service.ts#createCode path), so a non-creator owning one is
  // a former creator. DISTINCT collapses creators who minted several codes.
  const codeOwnerRows = await db.$queryRawUnsafe<{ user_id: string }[]>(
    `SELECT DISTINCT ac.user_id
       FROM affiliate_codes ac
       JOIN "user" u ON u.id = ac.user_id
      WHERE u.role <> 'creator'`,
  );

  // ── Signal B (Admin DB): users with an audit role_changed → creator
  // event. Same source `getUserCreatorHistory` reads. We can't filter on
  // the Main-DB role here (no cross-DB join), so collect candidate ids and
  // narrow against the Main-DB role set below.
  const auditEvents = await adminDb.admin_audit_events.findMany({
    where: { event_type: "role_changed" },
    select: { target_user_id: true, metadata: true },
  });
  const auditCandidateIds = new Set<string>();
  for (const e of auditEvents) {
    if (!e.target_user_id) continue;
    const meta =
      e.metadata && typeof e.metadata === "object" && !Array.isArray(e.metadata)
        ? (e.metadata as Record<string, unknown>)
        : {};
    if (meta.new_role === "creator") auditCandidateIds.add(e.target_user_id);
  }

  // Union of both candidate id sources (the audit ids still need their
  // Main-DB role checked — done in the resolve query's WHERE).
  const candidateIds = new Set<string>([
    ...codeOwnerRows.map((r) => r.user_id),
    ...auditCandidateIds,
  ]);
  if (candidateIds.size === 0) return [];

  // Resolve user records for every candidate, enforcing `role != 'creator'`
  // (so audit candidates who are CURRENTLY creators are excluded — they
  // belong on the active roster, not here) and applying the optional
  // username/email search. Ordered newest-first so the most recently
  // touched ex-creators surface at the top.
  const users = await db.user.findMany({
    where: {
      id: { in: [...candidateIds] },
      role: { not: "creator" },
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
 * Search + pagination are applied in memory (the set is small — a handful
 * to low tens of past creators), mirroring `getCreatorsListForTab`.
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
