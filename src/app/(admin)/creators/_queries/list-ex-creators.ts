import "server-only";

import { getDb } from "@/lib/db";
import { adminDb } from "@/lib/admin-db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import type { CreatorListItem } from "@/lib/backend-api";
import type { CreatorsSearchParams } from "../_lib/search-params";
import type { CreatorsListPage } from "./list-creators";

type ResolvedExCreatorUser = {
  id: string;
  username: string | null;
  email: string | null;
  image: string | null;
  created_at: Date;
  totalDealsCount: number;
  historicalDeal: CreatorListItem["current_deal"];
  historicalCode: string | null;
};

type CreatorAuditEvent = {
  event_type: string;
  target_user_id: string | null;
  metadata: unknown;
  created_at: Date;
};

type AdminCreatorDealRow = {
  id: string;
  target_user_id: string;
  status: string;
  amount: unknown;
  start_date: Date;
  end_date: Date | null;
  created_at: Date;
};

type HistoricalCreatorArtifacts = {
  totalDealsCount: number;
  latestActivityAt: Date | null;
  historicalDeal: CreatorListItem["current_deal"];
  historicalCode: string | null;
  fallbackUsername: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  if (value && typeof value === "object" && "toString" in value) {
    const raw = value.toString();
    if (raw !== "[object Object]" && Number.isFinite(Number(raw))) {
      return Number(raw);
    }
  }
  return null;
}

function decimalString(value: unknown): string {
  const n = numberValue(value);
  return n == null ? "0.00" : n.toFixed(2);
}

function isoString(value: unknown): string | null {
  const raw = stringValue(value);
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function mapAdminDealStatus(
  status: string,
): NonNullable<CreatorListItem["current_deal"]>["status"] {
  switch (status) {
    case "pending":
      return "scheduled";
    case "active":
      return "active";
    case "completed":
      return "completed";
    case "cancelled":
    default:
      return "terminated";
  }
}

function fallbackCreatedAt(artifacts: HistoricalCreatorArtifacts): Date {
  return artifacts.latestActivityAt ?? new Date(0);
}

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
            "creator_deal_deleted",
            "creator_social_approved",
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

function ensureArtifacts(
  map: Map<string, HistoricalCreatorArtifacts>,
  userId: string,
): HistoricalCreatorArtifacts {
  let entry = map.get(userId);
  if (!entry) {
    entry = {
      totalDealsCount: 0,
      latestActivityAt: null,
      historicalDeal: null,
      historicalCode: null,
      fallbackUsername: null,
    };
    map.set(userId, entry);
  }
  return entry;
}

function bumpLatest(entry: HistoricalCreatorArtifacts, at: Date | null) {
  if (!at) return;
  if (!entry.latestActivityAt || at > entry.latestActivityAt) {
    entry.latestActivityAt = at;
  }
}

function replaceHistoricalDeal(
  entry: HistoricalCreatorArtifacts,
  deal: NonNullable<CreatorListItem["current_deal"]>,
) {
  if (
    !entry.historicalDeal ||
    new Date(deal.week_start_utc) > new Date(entry.historicalDeal.week_start_utc)
  ) {
    entry.historicalDeal = deal;
  }
}

function dealStatusFromAudit(
  weekStartIso: string,
  weekEndIso: string,
  deletedDealIds: Set<string>,
  dealId: string,
): NonNullable<CreatorListItem["current_deal"]>["status"] {
  if (deletedDealIds.has(dealId)) return "terminated";
  const now = Date.now();
  const start = new Date(weekStartIso).getTime();
  const end = new Date(weekEndIso).getTime();
  if (Number.isFinite(end) && end < now) return "completed";
  if (Number.isFinite(start) && start > now) return "scheduled";
  return "terminated";
}

function dealEndFromStart(start: Date): string {
  return new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
}

async function getHistoricalArtifactsByUser(
  userIds: string[],
): Promise<Map<string, HistoricalCreatorArtifacts>> {
  const result = new Map<string, HistoricalCreatorArtifacts>();
  if (userIds.length === 0) return result;

  const [adminDeals, audits] = await Promise.all([
    adminDb.creator_deals.findMany({
      where: { target_user_id: { in: userIds } },
      select: {
        id: true,
        target_user_id: true,
        status: true,
        amount: true,
        start_date: true,
        end_date: true,
        created_at: true,
      },
      orderBy: { created_at: "desc" },
    }) as Promise<AdminCreatorDealRow[]>,
    adminDb.admin_audit_events.findMany({
      where: {
        target_user_id: { in: userIds },
        event_type: {
          in: [
            "user_made_creator",
            "creator_deal_created",
            "creator_deal_deleted",
            "creator_deal_updated",
            "creator_social_approved",
            "creator_force_reset_to_user",
            "role_changed",
          ],
        },
      },
      select: {
        event_type: true,
        target_user_id: true,
        metadata: true,
        created_at: true,
      },
      orderBy: { created_at: "desc" },
    }) as Promise<CreatorAuditEvent[]>,
  ]);

  const dealIdsByUser = new Map<string, Set<string>>();
  const deletedDealIds = new Set<string>();

  for (const audit of audits) {
    if (!audit.target_user_id) continue;
    const entry = ensureArtifacts(result, audit.target_user_id);
    bumpLatest(entry, audit.created_at);

    const meta = isRecord(audit.metadata) ? audit.metadata : {};
    const dealId = stringValue(meta.deal_id);
    if (dealId) {
      let ids = dealIdsByUser.get(audit.target_user_id);
      if (!ids) {
        ids = new Set<string>();
        dealIdsByUser.set(audit.target_user_id, ids);
      }
      ids.add(dealId);
      if (audit.event_type === "creator_deal_deleted") {
        deletedDealIds.add(dealId);
      }
    }

    const code = stringValue(meta.code) ?? stringValue(meta.affiliate_code);
    if (code && !entry.historicalCode) entry.historicalCode = code;

    const username = stringValue(meta.username);
    if (username && !entry.fallbackUsername) entry.fallbackUsername = username;
  }

  for (const deal of adminDeals) {
    const entry = ensureArtifacts(result, deal.target_user_id);
    bumpLatest(entry, deal.created_at);

    let ids = dealIdsByUser.get(deal.target_user_id);
    if (!ids) {
      ids = new Set<string>();
      dealIdsByUser.set(deal.target_user_id, ids);
    }
    ids.add(deal.id);

    const weekStart = deal.start_date.toISOString();
    const weekEnd = deal.end_date?.toISOString() ?? dealEndFromStart(deal.start_date);
    replaceHistoricalDeal(entry, {
      id: deal.id,
      status: mapAdminDealStatus(deal.status),
      week_start_utc: weekStart,
      week_end_utc: weekEnd,
      fills_allowed: 1,
      fills_used: deal.status === "pending" || deal.status === "active" ? 0 : 1,
      per_fill_amount_usd: decimalString(deal.amount),
    });
  }

  for (const audit of audits) {
    if (!audit.target_user_id || audit.event_type !== "creator_deal_created") {
      continue;
    }
    const meta = isRecord(audit.metadata) ? audit.metadata : {};
    const dealId = stringValue(meta.deal_id);
    if (!dealId) continue;

    const startIso = isoString(meta.week_start_utc) ?? audit.created_at.toISOString();
    const endIso = isoString(meta.week_end_utc) ?? dealEndFromStart(new Date(startIso));
    const fillsAllowed = Math.max(1, numberValue(meta.fills_allowed) ?? 1);
    const entry = ensureArtifacts(result, audit.target_user_id);
    replaceHistoricalDeal(entry, {
      id: dealId,
      status: dealStatusFromAudit(startIso, endIso, deletedDealIds, dealId),
      week_start_utc: startIso,
      week_end_utc: endIso,
      fills_allowed: fillsAllowed,
      fills_used:
        deletedDealIds.has(dealId) || new Date(endIso).getTime() < Date.now()
          ? fillsAllowed
          : 0,
      per_fill_amount_usd: decimalString(meta.per_fill_amount_usd),
    });
  }

  for (const [userId, dealIds] of dealIdsByUser) {
    const entry = ensureArtifacts(result, userId);
    entry.totalDealsCount = dealIds.size;
  }

  return result;
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
async function getExCreatorUsers(
  search?: string,
): Promise<ResolvedExCreatorUser[]> {
  const [candidateIds, excludedIds] = await Promise.all([
    getEverCreatorCandidateIds(),
    getExcludedUserIds(),
  ]);
  if (candidateIds.size === 0) return [];

  const db = await getDb();
  const excluded = new Set(excludedIds);
  const ids = [...candidateIds].filter((id) => !excluded.has(id));
  if (ids.length === 0) return [];

  const [users, artifactsByUser] = await Promise.all([
    db.user.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        username: true,
        email: true,
        image: true,
        role: true,
        created_at: true,
      },
    }),
    getHistoricalArtifactsByUser(ids),
  ]);
  const usersById = new Map(users.map((u) => [u.id, u]));

  const rows: ResolvedExCreatorUser[] = ids.flatMap((id) => {
    const user = usersById.get(id);
    if (user?.role === "creator") return [];
    const artifacts = artifactsByUser.get(id) ?? {
      totalDealsCount: 0,
      latestActivityAt: null,
      historicalDeal: null,
      historicalCode: null,
      fallbackUsername: null,
    };
    return [
      {
        id,
        username: user?.username ?? artifacts.fallbackUsername,
        email: user?.email ?? null,
        image: user?.image ?? null,
        created_at: user?.created_at ?? fallbackCreatedAt(artifacts),
        totalDealsCount: artifacts.totalDealsCount,
        historicalDeal: artifacts.historicalDeal,
        historicalCode: artifacts.historicalCode,
      },
    ];
  });

  const q = search?.trim().toLowerCase();
  const filtered = q
    ? rows.filter(
        (row) =>
          row.id.toLowerCase().includes(q) ||
          (row.username ?? "").toLowerCase().includes(q) ||
          (row.email ?? "").toLowerCase().includes(q) ||
          (row.historicalCode ?? "").toLowerCase().includes(q),
      )
    : rows;

  return filtered.sort((a, b) => {
    const aArtifact =
      artifactsByUser.get(a.id)?.latestActivityAt?.getTime() ?? 0;
    const bArtifact =
      artifactsByUser.get(b.id)?.latestActivityAt?.getTime() ?? 0;
    if (aArtifact !== bArtifact) return bArtifact - aArtifact;
    return b.created_at.getTime() - a.created_at.getTime();
  });
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
    current_deal: u.historicalDeal,
    active_session_id: null,
    total_deals_count: u.totalDealsCount,
  }));

  const total = data.length;
  return {
    data,
    total,
    page: 1,
    perPage: Math.max(1, total),
    totalPages: 1,
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

/**
 * Whether a user was EVER a creator (any creator artifact in either DB),
 * regardless of their current role. Used to authorize linking a balance
 * adjustment (e.g. Leaderboard) to a past / ex creator, not just an active
 * one. Reuses the same artifact-anchored candidate set as the Past-creators
 * list so the two surfaces agree on who counts as a creator.
 */
export async function isEverCreator(userId: string): Promise<boolean> {
  if (!userId) return false;
  const candidates = await getEverCreatorCandidateIds();
  return candidates.has(userId);
}

/** A creator-link picker option for a past / ex creator. */
export type ExCreatorLinkOption = {
  id: string;
  username: string | null;
  email: string | null;
  image: string | null;
};

/**
 * Ex-creators matching a search term, shaped for the creator-link picker
 * (Adjust Balance → Leaderboard). Same identification + search as the
 * Past-creators tab, capped to a screenful for the dropdown.
 */
export async function searchExCreatorsForLink(
  search: string,
  limit: number,
): Promise<ExCreatorLinkOption[]> {
  const users = await getExCreatorUsers(search);
  return users.slice(0, Math.max(1, limit)).map((u) => ({
    id: u.id,
    username: u.username,
    email: u.email,
    image: u.image,
  }));
}
