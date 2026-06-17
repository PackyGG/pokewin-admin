import "server-only";

import { unstable_cache } from "next/cache";

import {
  BackendApiError,
  BackendNetworkError,
  type CreatorListItem,
  type CreatorSessionResponse,
  type StreamSessionStatus,
} from "@/lib/backend-api";
import {
  getCachedCreatorRoster,
  getCachedCreatorSessions,
} from "@/lib/cache/creator-backend-cache";
import { adminDb } from "@/lib/admin-db";
import { resolveLinkedHandle } from "@/lib/creator-hub";
import { logWarn } from "@/lib/errors/logger";

import { readSessionMetaByIds } from "../../creators/[id]/_queries/sessions-data";
import { isLinkedSocialUsername } from "../../../../(admin)/creators/_queries/socials-by-user";

/**
 * Creator Hub — `/creator-hub/sessions` (All Sessions) data.
 *
 * One MERGED chronological feed of EVERY creator's past + current activated
 * stream sessions — the same per-session record the per-creator Sessions tab
 * renders ({@link CreatorSessionResponse}), enriched with the creator identity
 * (avatar / username) and the admin-DB VOD/notes sidecar.
 *
 * AGGREGATION (copies the fan-out shape from `tips-sponsors-data.ts`):
 *   1. {@link listAllCreators} returns the shared, cached creator roster
 *      (`getCachedCreatorRoster` — the same paged `creatorsApi.list` walk,
 *      now shared across fan-outs and Upstash-cached when configured; a pure
 *      pass-through to the live walk when dormant).
 *   2. To respect the backend rate limit (it returns HTTP 429 under load), we
 *      fan out ONLY to creators that can possibly have sessions — a creator is
 *      KEPT when `total_deals_count > 0` OR `active_session_id != null`; the
 *      rest are SKIPPED (no deal ⇒ no session). {@link mapPool} bounds the
 *      concurrency.
 *   3. Each kept creator's sessions come from the shared, cached per-creator
 *      session list (`getCachedCreatorSessions` — the same paged
 *      `creatorsApi.listSessions` walk).
 *
 * RESILIENCE: each creator's session-paging loop is wrapped in try/catch — a
 * `BackendApiError`/`BackendNetworkError` (e.g. a 429) counts that creator into
 * `partialCreators` and continues, so a single throttled creator never sinks
 * the whole aggregate. If the roster `listAllCreators` itself fails that way,
 * `backendUnavailable` is set and an empty aggregate returns (mirrors how
 * `tips-sponsors-data` degrades).
 *
 * DBs: the backend session/roster reads are READ-ONLY (MAIN/prod untouched);
 * the VOD/notes sidecar lives in the ADMIN DB (read-only here — writes happen
 * via the per-creator `setSessionVodUrl` server action, reused by the table).
 * No schema migration runs; {@link readSessionMetaByIds} self-heals a missing
 * substrate table.
 *
 * LAZY: the only caller is the page's keyed `<Suspense>` section, so this runs
 * solely for the active page/order/status — nothing is preloaded.
 */

/** One merged row = the backend session record + creator identity + VOD/notes. */
export type AllCreatorSessionRow = CreatorSessionResponse & {
  /** Manager-entered Kick VOD URL (admin DB), or null when unset. */
  kickVodUrl: string | null;
  /** Manager-entered free-text note (admin DB), or null when unset. */
  notes: string | null;
  /** The owning creator's backend/text user id (= `user_id`). */
  creatorId: string;
  /** The creator's display username, or null (falls back to a short id slice). */
  creatorUsername: string | null;
  /** The creator's avatar URL, or null. */
  creatorImage: string | null;
  /** The creator's linked Kick handle (admin DB `creator_socials`), or null. */
  creatorKickHandle: string | null;
};

/** Lifetime/full-set KPI roll-up summed over the WHOLE merged feed. */
export type AllSessionsKpis = {
  totalSessions: number;
  activeSessions: number;
  creatorsWithSessions: number;
  loadedUsd: number;
  spentUsd: number;
  convertedUsd: number;
  tipsUsd: number;
  sponsorUsd: number;
};

/** Status filter for the feed (`all` = no filter). */
export type AllSessionsStatusFilter = StreamSessionStatus | "all";

/** Sort direction over `activated_at` — `desc` = newest first (default). */
export type AllSessionsOrder = "asc" | "desc";

/** The cached, GLOBAL aggregate — sessions ASC by `activated_at` + KPIs/flags. */
type AllSessionsAggregate = {
  /** Every collected session, ASCENDING by `activated_at` (oldest first). */
  sessions: AggregateRow[];
  kpis: AllSessionsKpis;
  /** Creators whose session paging failed this run (possibly rate-limited). */
  partialCreators: number;
  /** The roster fetch itself failed — the feed is empty this run. */
  backendUnavailable: boolean;
  /** The merged feed exceeded {@link MAX_TOTAL_SESSIONS} and was capped. */
  truncated: boolean;
  /** How many creators were fanned out to (post deal/active filter). */
  creatorsScanned: number;
};

/** The cached row (no VOD/notes yet — those attach per displayed page). */
type AggregateRow = CreatorSessionResponse & {
  creatorId: string;
  creatorUsername: string | null;
  creatorImage: string | null;
};

/** The final paged result handed to the page. */
export type AllSessionsPage = {
  rows: AllCreatorSessionRow[];
  /** Row count after the status filter (drives pagination). */
  total: number;
  page: number;
  totalPages: number;
  order: AllSessionsOrder;
  kpis: AllSessionsKpis;
  partialCreators: number;
  backendUnavailable: boolean;
  truncated: boolean;
  creatorsScanned: number;
  /** The admin-DB VOD/notes read for the displayed slice degraded. */
  metaDegraded: boolean;
};

/** Bounded concurrency to stay under the backend's 429 rate limit. */
const CREATOR_CONCURRENCY = 4;
/** Hard cap on the merged feed — keep the most recent N, flag `truncated`. */
const MAX_TOTAL_SESSIONS = 5000;
/** Page size for the displayed feed. */
const PAGE_SIZE = 50;

export const ALL_SESSIONS_PAGE_SIZE = PAGE_SIZE;

/** Parse a decimal string to a finite number, else 0. */
function num(v: string | null | undefined): number {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function emptyKpis(): AllSessionsKpis {
  return {
    totalSessions: 0,
    activeSessions: 0,
    creatorsWithSessions: 0,
    loadedUsd: 0,
    spentUsd: 0,
    convertedUsd: 0,
    tipsUsd: 0,
    sponsorUsd: 0,
  };
}

/**
 * Page the creator roster up to the cap — delegates to the shared cached
 * roster (`getCachedCreatorRoster`), which runs the identical paged
 * `creatorsApi.list` walk (same cap/limit) and is Upstash-cached across
 * fan-outs when configured, or a pure pass-through to the live walk when
 * dormant. The returned roster is unchanged either way.
 */
async function listAllCreators(): Promise<CreatorListItem[]> {
  return getCachedCreatorRoster();
}

/**
 * A creator can only have sessions if they've had at least one deal OR are live
 * right now. Skipping the rest keeps the fan-out small enough to stay under the
 * backend 429 rate limit.
 */
function creatorCanHaveSessions(c: CreatorListItem): boolean {
  return c.total_deals_count > 0 || c.active_session_id != null;
}

/**
 * Page ALL of one creator's sessions (newest-first as the backend returns) —
 * delegates to the shared cached session list (`getCachedCreatorSessions`),
 * which runs the identical paged `creatorsApi.listSessions` walk (same
 * limit/page cap) and is Upstash-cached per creator across fan-outs when
 * configured, or a pure pass-through to the live walk when dormant. The
 * returned sessions are unchanged either way.
 */
async function listAllCreatorSessions(
  userId: string,
): Promise<CreatorSessionResponse[]> {
  return getCachedCreatorSessions(userId);
}

/** Bounded-concurrency map (same helper as tips-sponsors-data). */
async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await fn(items[i]!);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  );
  return out;
}

function isBackendError(err: unknown): boolean {
  return err instanceof BackendApiError || err instanceof BackendNetworkError;
}

/**
 * Fetch + merge every creator's sessions into one chronological feed (ASC by
 * `activated_at`), with KPIs summed over the FULL set and honest degrade flags.
 */
async function computeAllSessions(): Promise<AllSessionsAggregate> {
  let creators: CreatorListItem[];
  try {
    creators = await listAllCreators();
  } catch (err) {
    if (isBackendError(err)) {
      // Roster itself unreachable — empty aggregate, flagged (mirror tips-sponsors).
      return {
        sessions: [],
        kpis: emptyKpis(),
        partialCreators: 0,
        backendUnavailable: true,
        truncated: false,
        creatorsScanned: 0,
      };
    }
    throw err;
  }

  // Only fan out to creators that can possibly have sessions (429-budget).
  const kept = creators.filter(creatorCanHaveSessions);

  let partialCreators = 0;

  const perCreator = await mapPool(kept, CREATOR_CONCURRENCY, async (c) => {
    try {
      const sessions = await listAllCreatorSessions(c.id);
      const rows: AggregateRow[] = sessions.map((s) => ({
        ...s,
        creatorId: c.id,
        creatorUsername: c.username,
        creatorImage: c.image,
      }));
      return rows;
    } catch (err) {
      if (isBackendError(err)) {
        // Throttled / unreachable for THIS creator — skip, count, continue.
        partialCreators += 1;
        return [] as AggregateRow[];
      }
      // Any non-backend error is a real bug — surface it.
      throw err;
    }
  });

  // KPIs are summed over the FULL collected set (before any display cap),
  // counting each creator that contributed at least one session.
  const kpis = emptyKpis();
  let merged: AggregateRow[] = [];
  for (const rows of perCreator) {
    if (rows.length > 0) kpis.creatorsWithSessions += 1;
    for (const r of rows) {
      merged.push(r);
      kpis.totalSessions += 1;
      if (r.status === "active") kpis.activeSessions += 1;
      kpis.loadedUsd += num(r.fill_loaded_usd);
      kpis.spentUsd += num(r.fill_spent_usd);
      kpis.convertedUsd += num(r.converted_to_raw_usd);
      kpis.tipsUsd += num(r.tips_spent_this_session_usd);
      kpis.sponsorUsd += num(r.sponsorship_spent_this_session_usd);
    }
  }

  // Order ASCENDING by activated_at (oldest first) — the cached canonical order.
  merged.sort(
    (a, b) =>
      new Date(a.activated_at).getTime() - new Date(b.activated_at).getTime(),
  );

  // Cap honestly: if the feed is huge, keep the most RECENT N (the tail of the
  // ascending order) and flag it — never a silent drop.
  let truncated = false;
  if (merged.length > MAX_TOTAL_SESSIONS) {
    truncated = true;
    merged = merged.slice(merged.length - MAX_TOTAL_SESSIONS);
  }

  return {
    sessions: merged,
    kpis,
    partialCreators,
    backendUnavailable: false,
    truncated,
    creatorsScanned: kept.length,
  };
}

// GLOBAL aggregate (not per-admin) → a single cache entry is correct. Same
// `creator-hub` tag + 120s revalidate as tips-sponsors-data.
const cachedAllSessions = unstable_cache(
  computeAllSessions,
  ["creator-hub-all-sessions-v1"],
  { revalidate: 120, tags: ["creator-hub"] },
);

function applyStatusFilter(
  sessions: AggregateRow[],
  status: AllSessionsStatusFilter,
): AggregateRow[] {
  if (status === "all") return sessions;
  return sessions.filter((s) => s.status === status);
}

/** A missing-relation error (table not migrated): Prisma P2021 / Postgres 42P01. */
function isMissingRelation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === "P2021" || code === "42P01";
}

/**
 * Read linked Kick handles (ADMIN DB `creator_socials` where `platform = 'kick'`)
 * for the displayed slice's creators only — keyed by `target_user_id`. Mirrors
 * the per-slice {@link readSessionMetaByIds} sidecar pattern: a small, bounded
 * ADMIN-DB read (never MAIN). Best-effort — a missing relation or any read
 * failure degrades to an empty map (handle simply renders as "not linked").
 */
async function readKickHandlesByUserIds(
  userIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return out;
  try {
    const rows = await adminDb.creator_socials.findMany({
      where: { target_user_id: { in: unique }, platform: "kick" },
      select: { target_user_id: true, username: true },
    });
    for (const r of rows) {
      if (!isLinkedSocialUsername(r.username)) continue;
      const handle = resolveLinkedHandle(r.username);
      if (handle) out.set(r.target_user_id, handle);
    }
  } catch (err) {
    if (!isMissingRelation(err)) {
      logWarn("creator-hub.all-sessions", "kick handle read failed", err);
    }
  }
  return out;
}

/**
 * Read the global aggregate, apply the optional status filter + order, slice to
 * one page, then attach the admin-DB VOD/notes sidecar for ONLY the displayed
 * session ids.
 *
 * @param params.page   1-based page (clamped ≥ 1).
 * @param params.order  `desc` (newest first, default) or `asc` (oldest first,
 *                      the cached order).
 * @param params.status `active` | `ended` | `converted` | `all` (default `all`).
 */
export async function getAllSessionsPage(params: {
  page: number;
  order?: AllSessionsOrder;
  status?: AllSessionsStatusFilter;
}): Promise<AllSessionsPage> {
  const order: AllSessionsOrder = params.order === "asc" ? "asc" : "desc";
  const status: AllSessionsStatusFilter = params.status ?? "all";
  const rawPage = params.page;
  const page =
    Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1;

  const aggregate = await cachedAllSessions();

  // Status filter first (drives pagination), then order. `asc` IS the cached
  // order; `desc` is a reversed copy (never mutate the cached array).
  const filtered = applyStatusFilter(aggregate.sessions, status);
  const ordered = order === "desc" ? [...filtered].reverse() : filtered;

  const total = ordered.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const start = (page - 1) * PAGE_SIZE;
  const slice = ordered.slice(start, start + PAGE_SIZE);

  // VOD/notes sidecar for ONLY the displayed slice (reuses the self-healing
  // per-creator reader — no duplicate ensure-schema logic). The Kick-handle
  // sidecar (admin DB `creator_socials`) is read for the same slice's creators.
  const [{ byId, degraded }, kickByCreator] = await Promise.all([
    readSessionMetaByIds(slice.map((s) => s.id)),
    readKickHandlesByUserIds(slice.map((s) => s.creatorId)),
  ]);

  const rows: AllCreatorSessionRow[] = slice.map((s) => {
    const meta = byId.get(s.id);
    return {
      ...s,
      kickVodUrl: meta?.kickVodUrl ?? null,
      notes: meta?.notes ?? null,
      creatorKickHandle: kickByCreator.get(s.creatorId) ?? null,
    };
  });

  return {
    rows,
    total,
    page,
    totalPages,
    order,
    kpis: aggregate.kpis,
    partialCreators: aggregate.partialCreators,
    backendUnavailable: aggregate.backendUnavailable,
    truncated: aggregate.truncated,
    creatorsScanned: aggregate.creatorsScanned,
    metaDegraded: degraded,
  };
}
