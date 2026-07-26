import "server-only";

import {
  creatorsApi,
  type CreatorListItem,
  type CreatorSessionResponse,
} from "@/lib/backend-api";
import { getDrizzleDb } from "@/lib/db";
import { readDbEnv } from "@/lib/db-env";
import {
  creator_deals,
  creator_stream_sessions,
  user,
} from "@/lib/db-schema/main/schema";
import { and, desc, eq, gt, inArray, lte, sql } from "drizzle-orm";

import {
  buildCacheKey,
  cacheGetOrSet,
  cacheGetOrSetStale,
} from "./redis";

/**
 * Shared, Upstash-backed cache for the RATE-LIMITED creator-backend reads.
 *
 * The creator-hub fan-outs (`sessions/_queries/all-sessions-data.ts`,
 * `tips-sponsors/_queries/tips-sponsors-data.ts`, `alerts/_queries/
 * creator-alerts.ts`) each independently page the creator roster
 * (`creatorsApi.list`) and, per creator, every stream session
 * (`creatorsApi.listSessions`). Under concurrent admin load that fan-out gets
 * HTTP 429'd by the backend. Centralizing those two reads here means repeat
 * page loads and multiple concurrent admins share ONE cached roster entry and
 * ONE cached entry per creator's sessions instead of each re-walking the
 * backend.
 *
 * DORMANT-SAFE: every read goes through `cacheGetOrSet`, which is a pure
 * pass-through when Upstash is not configured (no UPSTASH_REDIS_REST_URL /
 * TOKEN) or on ANY Redis error. With no env, these helpers do EXACTLY the live
 * paging the call sites do today — same data, same order, same pagination.
 *
 * BACKEND-ERROR RESILIENCE: the roster retains a last-known-good value for six
 * hours. A transient backend failure after the two-minute fresh window serves
 * that retained roster. With no retained value, the backend error still
 * propagates to the call site's existing unavailable/partial state. Session
 * reads retain the original transparent get-or-set behavior.
 *
 * ENV KEYING: the backend is env-aware (the `admin_db_env` cookie can route an
 * admin's requests at dev vs prod — see `backend-api/config.ts`). We key cache
 * entries on the resolved env so a dev-toggled admin never reads prod-scoped
 * cached data and vice-versa. `readDbEnv()` resolves `prod` outside a request
 * scope (e.g. inside `unstable_cache`'s cookieless context), which matches the
 * backend's own fallback there — so we do NOT try to "fix" the dev toggle in
 * that scope, we mirror it.
 *
 * READ-ONLY: these only ever GET from the backend (roster + sessions) and
 * GET/SET against the dedicated Upstash instance. Nothing here writes to the
 * prod game DB or the prod Redis.
 */

// Paging constants copied verbatim from the call-site loops so the cached
// walk is byte-identical to today's direct walk.
const CREATOR_LIST_CAP = 500; // matches all-sessions-data / tips-sponsors-data
const SESSIONS_PAGE_LIMIT = 100; // matches all-sessions-data / tips-sponsors-data
const MAX_SESSION_PAGES = 100; // matches all-sessions-data / tips-sponsors-data

// Short TTL — same 120s revalidate window the consumers' `unstable_cache`
// wrappers already use, so cache freshness is unchanged.
const ROSTER_TTL_SECONDS = 120;
const ROSTER_STALE_TTL_SECONDS = 6 * 60 * 60;
const SESSIONS_TTL_SECONDS = 120;

/**
 * Page the creator roster up to {@link CREATOR_LIST_CAP}.
 *
 * This loop is copied VERBATIM from `tips-sponsors-data.ts`'s
 * `listAllCreators()` (identical to `all-sessions-data.ts`'s) so the cached
 * roster is exactly the live roster.
 */
async function pageCreatorRoster(): Promise<CreatorListItem[]> {
  try {
    const out: CreatorListItem[] = [];
    let offset = 0;
    while (out.length < CREATOR_LIST_CAP) {
      const slice = await creatorsApi.list({ limit: 100, offset });
      out.push(...slice.data);
      offset += slice.data.length;
      if (slice.data.length === 0 || offset >= slice.total) break;
    }
    return out;
  } catch (error) {
    console.warn(
      "[creator-roster] backend unavailable; reading canonical PostgreSQL roster",
      error,
    );
    return pageCreatorRosterFromPostgres();
  }
}

/**
 * Read-only fallback matching the backend's `listCreators` repository query.
 * The admin already has request-scoped MAIN PostgreSQL access, so a broken
 * backend deployment must not blank a read-only roster.
 */
async function pageCreatorRosterFromPostgres(): Promise<CreatorListItem[]> {
  const db = await getDrizzleDb();
  const creators = await db
    .select({
      id: user.id,
      username: user.username,
      email: user.email,
      image: user.image,
      role: user.role,
      created_at: user.created_at,
    })
    .from(user)
    .where(eq(user.role, "creator"))
    .orderBy(desc(user.created_at))
    .limit(CREATOR_LIST_CAP);

  if (creators.length === 0) return [];

  const ids = creators.map((creator) => creator.id);
  const now = new Date().toISOString();
  const [currentDeals, activeSessions, dealCounts] = await Promise.all([
    db
      .select({
        id: creator_deals.id,
        user_id: creator_deals.user_id,
        status: creator_deals.status,
        week_start_utc: creator_deals.week_start_utc,
        week_end_utc: creator_deals.week_end_utc,
        fills_allowed: creator_deals.fills_allowed,
        fills_used: creator_deals.fills_used,
        per_fill_amount_usd: creator_deals.per_fill_amount_usd,
      })
      .from(creator_deals)
      .where(
        and(
          inArray(creator_deals.user_id, ids),
          inArray(creator_deals.status, ["scheduled", "active"]),
          lte(creator_deals.week_start_utc, now),
          gt(creator_deals.week_end_utc, now),
        ),
      ),
    db
      .select({
        id: creator_stream_sessions.id,
        user_id: creator_stream_sessions.user_id,
      })
      .from(creator_stream_sessions)
      .where(
        and(
          inArray(creator_stream_sessions.user_id, ids),
          eq(creator_stream_sessions.status, "active"),
        ),
      ),
    db
      .select({
        user_id: creator_deals.user_id,
        count: sql<number>`count(*)::int`,
      })
      .from(creator_deals)
      .where(inArray(creator_deals.user_id, ids))
      .groupBy(creator_deals.user_id),
  ]);

  const dealByUser = new Map(
    currentDeals.map((deal) => [deal.user_id, deal]),
  );
  const sessionByUser = new Map(
    activeSessions.map((session) => [session.user_id, session.id]),
  );
  const countByUser = new Map(
    dealCounts.map((count) => [count.user_id, count.count]),
  );

  return creators.map((creator) => {
    const deal = dealByUser.get(creator.id);
    return {
      ...creator,
      current_deal: deal
        ? {
            id: deal.id,
            status: deal.status,
            week_start_utc: deal.week_start_utc,
            week_end_utc: deal.week_end_utc,
            fills_allowed: deal.fills_allowed,
            fills_used: deal.fills_used,
            per_fill_amount_usd: deal.per_fill_amount_usd,
          }
        : null,
      active_session_id: sessionByUser.get(creator.id) ?? null,
      total_deals_count: countByUser.get(creator.id) ?? 0,
    };
  });
}

/**
 * Page ALL of one creator's sessions (newest-first as the backend returns).
 *
 * This loop is copied VERBATIM from `all-sessions-data.ts`'s
 * `listAllCreatorSessions()` so the cached session list is exactly the live
 * list.
 */
async function pageCreatorSessions(
  userId: string,
): Promise<CreatorSessionResponse[]> {
  const out: CreatorSessionResponse[] = [];
  let offset = 0;
  for (let page = 0; page < MAX_SESSION_PAGES; page++) {
    const slice = await creatorsApi.listSessions(userId, {
      limit: SESSIONS_PAGE_LIMIT,
      offset,
    });
    out.push(...slice.data);
    offset += slice.data.length;
    if (slice.data.length === 0 || offset >= slice.total) break;
  }
  return out;
}

/**
 * Cached creator roster — the FULL paged list (up to the cap), shared across
 * every fan-out. Keyed on the resolved backend env. A last-known-good result is
 * retained for six hours so a brief backend/database incident does not blank
 * every creator surface. Dormant → just the live paging from
 * {@link pageCreatorRoster}.
 *
 * The result is identical to calling the call-sites' local `listAllCreators()`
 * directly.
 */
export async function getCachedCreatorRoster(): Promise<CreatorListItem[]> {
  const env = await readDbEnv();
  return cacheGetOrSetStale(
    buildCacheKey("creator-roster-v2", [env]),
    ROSTER_TTL_SECONDS,
    ROSTER_STALE_TTL_SECONDS,
    pageCreatorRoster,
  );
}

/**
 * Cached per-creator session list — ALL of one creator's sessions, shared
 * across every fan-out. Keyed on the resolved backend env + creator id.
 * Dormant → just the live paging from {@link pageCreatorSessions}.
 *
 * The result is identical to calling the call-sites' local
 * `listAllCreatorSessions(userId)` directly.
 */
export async function getCachedCreatorSessions(
  userId: string,
): Promise<CreatorSessionResponse[]> {
  const env = await readDbEnv();
  return cacheGetOrSet(
    buildCacheKey("creator-sessions", [env, userId]),
    SESSIONS_TTL_SECONDS,
    () => pageCreatorSessions(userId),
  );
}
