import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(path, "utf8");

test("creator list surfaces share the retained roster cache", () => {
  const hub = read(
    "src/app/(creator-hub)/creator-hub/creators/_queries/list-roster-creators.ts",
  );
  const legacy = read(
    "src/app/(admin)/creators/_queries/list-creators-by-tab.ts",
  );
  const cache = read("src/lib/cache/creator-backend-cache.ts");

  for (const source of [hub, legacy]) {
    assert.match(source, /getCachedCreatorRoster\(\)/);
    assert.doesNotMatch(source, /creatorsApi\.list/);
  }
  assert.match(cache, /cacheGetOrSetStale\(/);
  assert.match(cache, /ROSTER_STALE_TTL_SECONDS = 6 \* 60 \* 60/);
  assert.match(cache, /pageCreatorRosterFromPostgres\(\)/);
  assert.match(cache, /eq\(user\.role, "creator"\)/);
  assert.match(cache, /creator_stream_sessions\.status, "active"/);
  assert.match(cache, /count\(\*\)::int/);
});

test("all creator backend read families fall back to canonical PostgreSQL", () => {
  const creators = read("src/lib/backend-api/creators.ts");
  const leaderboards = read(
    "src/lib/backend-api/affiliate-leaderboards.ts",
  );
  const postgres = read("src/lib/backend-api/postgres-reads.ts");

  for (const fallback of [
    "listCreatorsFromPostgres",
    "listCreatorDealsFromPostgres",
    "getCreatorDealFromPostgres",
    "listCreatorSessionsFromPostgres",
    "listPendingConversionsFromPostgres",
    "listCreatorSocialsFromPostgres",
    "getCreatorApiKeyStatusFromPostgres",
  ]) {
    assert.match(creators, new RegExp(fallback));
  }
  assert.match(leaderboards, /listAffiliateLeaderboardsFromPostgres/);
  assert.match(leaderboards, /getAffiliateLeaderboardFromPostgres/);

  for (const table of [
    "creator_deals",
    "creator_stream_sessions",
    "creator_session_pending_conversions",
    "creator_socials",
    "affiliate_leaderboards",
    "affiliate_leaderboard_prize_tiers",
  ]) {
    assert.match(postgres, new RegExp(table));
  }
});

test("creator detail leaderboard cards use the resilient shared read client", () => {
  for (const file of [
    "src/app/(admin)/creators/[userId]/leaderboards-card.tsx",
    "src/app/(creator-hub)/creator-hub/creators/[id]/_queries/leaderboards-preview.ts",
    "src/app/(creator-hub)/creator-hub/creators/[id]/_queries/previous-leaderboards.ts",
  ]) {
    const source = read(file);
    assert.match(source, /affiliateLeaderboardsApi\.list/);
    assert.doesNotMatch(source, /backendApi\.get/);
  }
});

test("upgrader and announcement reads also recover from PostgreSQL", () => {
  const upgrader = read("src/lib/backend-api/upgrader.ts");
  const announcements = read("src/lib/backend-api/announcements.ts");

  assert.match(upgrader, /listOutputsFromPostgres/);
  assert.match(upgrader, /upgrader_output_cards/);
  assert.match(upgrader, /innerJoin\(cards/);
  assert.match(announcements, /getAnnouncementsFromPostgres/);
  assert.match(announcements, /\.from\(announcements\)/);
  assert.match(announcements, /count\(\*\)::int/);
});

test("legacy antifraud notifications leave the segment host explicitly", () => {
  const page = read(
    "src/app/(antifraud)/antifraud/notifications/page.tsx",
  );
  const middleware = read("src/middleware.ts");

  assert.match(page, /hrefFrom\(resolveAppHost\(host\)/);
  assert.match(page, /"\/system\/staff-notifications"/);
  assert.doesNotMatch(page, /redirect\("\/system\/staff-notifications"\)/);
  assert.match(
    middleware,
    /appHost\?\.basePath === "\/antifraud" && pathname === "\/notifications"/,
  );
  assert.match(
    middleware,
    /https:\/\/\$\{apex\.host\}\/system\/staff-notifications/,
  );
  assert.match(
    middleware,
    /appHost\?\.basePath === "\/antifraud" && pathname === "\/settings\/api"/,
  );
  assert.match(middleware, /new URL\("\/api", request\.url\)/);
});

test("idempotent backend reads retry bounded transient failures", () => {
  const client = read("src/lib/backend-api/client.ts");

  assert.match(client, /MAX_GET_FAILURE_RETRIES = 1/);
  assert.match(client, /res\.status === 500/);
  assert.match(client, /res\.status === 502/);
  assert.match(client, /res\.status === 504/);
  assert.match(client, /method === "GET"/);
});

test("MAIN pool acquire budget outlives its statement budget", () => {
  const db = read("src/lib/db.ts");

  const acquire = Number(
    db.match(/connectionTimeoutMillis:\s*([\d_]+)/)?.[1].replaceAll("_", ""),
  );
  const statement = Number(
    db.match(/statement_timeout:\s*([\d_]+)/)?.[1].replaceAll("_", ""),
  );

  assert.ok(Number.isFinite(acquire));
  assert.ok(Number.isFinite(statement));
  assert.ok(acquire > statement);
});
