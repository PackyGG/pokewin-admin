import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * /analytics read-budget guardrails.
 *
 * MAIN mirror reads pass through a process-wide admission semaphore
 * (`src/lib/db.ts`), so what makes this page slow — and what makes tiles
 * render "Couldn't load this section" — is the TOTAL number of reads a single
 * render issues, not the cost of any one of them. A read whose result is
 * discarded is therefore not free: it occupies a slot every visible tile is
 * queueing for.
 *
 * These assertions pin the SHAPE that keeps the budget honest, never a tuning
 * number (pool sizes and timeouts stay owned by `src/lib/db.ts`). Sources are
 * read as text — nothing here imports app modules, which are `server-only`
 * and pull in `next/cache`.
 */
function source(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), "utf8");
}

/** Body of a top-level `async function <name>(` up to the next top-level `}`. */
function functionBody(src: string, name: string): string {
  // Normalise line endings first — these files are edited on Windows and a
  // CRLF checkout would otherwise make every offset here miss.
  const text = src.replace(/\r\n/g, "\n");
  const start = text.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `expected to find async function ${name}`);
  const end = text.indexOf("\n}\n", start);
  assert.notEqual(end, -1, `expected a closing brace for ${name}`);
  return text.slice(start, end);
}

test("the Overview bundle does not fetch data the Overview never renders", () => {
  const analytics = source("src/lib/queries/analytics.ts");
  const body = functionBody(analytics, "computeAnalyticsData");

  // The battle-mode / pack-popularity aggregates belong to the Games tab.
  // They lived in this bundle for a while and were computed on EVERY Overview
  // render without a single consumer reading them back.
  assert.doesNotMatch(
    body,
    /FROM battles/,
    "computeAnalyticsData must not scan `battles` — the Overview renders no battle breakdown",
  );

  // The payload must not re-grow the fields those scans existed to fill.
  for (const field of ["battleStats", "packStats"]) {
    assert.doesNotMatch(
      body,
      new RegExp(`\\b${field}\\s*:`),
      `computeAnalyticsData must not return \`${field}\` — nothing on the Overview consumes it`,
    );
  }

  // Period wager totals are summed from the per-day rows rather than fetched
  // by a second aggregate over the same table with the same WHERE.
  assert.match(
    body,
    /pack_wager_borrowed/,
    "the daily ledger scan must carry the borrowed-wager columns so the headline totals need no extra scan",
  );
});

test("the Overview shell does not wait on the heavy bundle", () => {
  const overview = source("src/app/(admin)/analytics/overview-page.tsx");

  // A top-level `await` here would serialise the independent legs (daily
  // P&L, withdrawal rails) behind the slowest read on the page, and would
  // make one failed bundle blank sections whose own data had arrived.
  assert.doesNotMatch(
    overview,
    /export async function CoreSections/,
    "CoreSections must start the overview read without awaiting it, so independent legs stream in parallel",
  );
  assert.match(
    overview,
    /export function CoreSections/,
    "CoreSections must remain a synchronous shell that renders its Suspense legs immediately",
  );
});

test("the Games sub-views only read what they render", () => {
  const tab = source("src/app/(admin)/analytics/tab-packs.tsx");

  // `?g=packs` and `?g=battles` render disjoint sections. Each read must sit
  // behind the flag for the half that displays it.
  assert.match(
    tab,
    /showBattles\s*\?[\s\S]{0,200}getBattleModeStats/,
    "the battle-mode scans must be gated on the battles sub-view",
  );
  assert.match(
    tab,
    /showPacks\s*\?[\s\S]{0,200}getPackPopularityStats/,
    "the pack-popularity scan must be gated on the packs sub-view",
  );
  assert.match(
    tab,
    /showPacks\s*\?[\s\S]{0,200}getTopOpenedPacks24h/,
    "the rolling-24h leaderboard is packs-only and must not be fetched on the battles sub-view",
  );

  // The per-pack attribution deep-dive computes one side, not both.
  assert.match(
    tab,
    /getPackProfitability\(\s*period,/,
    "getPackProfitability must be told which side to compute",
  );
});

test("the Games overview is the default and reuses one canonical gaming read", () => {
  const tab = source("src/app/(admin)/analytics/tab-games.tsx");
  const overview = source("src/lib/queries/analytics-games-overview.ts");
  const metrics = source("src/lib/metrics/queries.ts");
  const component = source(
    "src/app/(admin)/analytics/games-overview.tsx",
  );
  const body = functionBody(overview, "getGamesOverview");

  assert.match(
    tab,
    /GAME_VIEWS\s*=\s*\[\s*"overview"/,
    "Overview must be the first Games sub-view",
  );
  assert.match(
    tab,
    /:\s*"overview";/,
    "invalid or absent game views must land on Overview",
  );
  assert.equal(
    (body.match(/getGamingLegs\(/g) ?? []).length,
    1,
    "the mode mix and headline must come from one canonical gaming read",
  );
  assert.doesNotMatch(
    body,
    /queryRows|queryMainRows/,
    "the overview reshaper must not add a second direct database scan",
  );
  for (const payout of [
    "packPayout",
    "battlePayout",
    "upgraderPayout",
    "ddPayout",
    "kenoPayout",
  ]) {
    assert.match(
      body,
      new RegExp(`payout:\\s*legs\\.${payout}`),
      `the overview must expose ${payout} for per-mode GGR`,
    );
  }
  assert.match(
    metrics,
    /source_type::text = 'pack'[\s\S]{0,120}AS pack_payout/,
    "pack GGR must use the pack-only inventory payout leg",
  );
  assert.match(
    metrics,
    /'battle_refund','battle_excess_to_voucher'[\s\S]{0,120}AS battle_payout/,
    "battle GGR must include both canonical cash/voucher settlement legs",
  );
  assert.match(
    component,
    /GGR \/ hold/,
    "every game row must render its directly attributed GGR and hold",
  );
  assert.doesNotMatch(
    component,
    /Wager is net cash staked|Staff, creator accounts/,
    "the removed scope explainer must stay out of the Games overview",
  );
});

test("getPackProfitability can skip the half that is not rendered", () => {
  const packs = source("src/lib/queries/analytics-packs.ts");
  assert.match(
    packs,
    /export type PacksProfitSide\s*=/,
    "the profitability query must expose a side selector",
  );
  assert.match(
    packs,
    /const wantPacks = side !== "battles"/,
    "the solo-pack attribution scan must be skippable",
  );
  assert.match(
    packs,
    /const wantBattles = side !== "packs"/,
    "the battle-pack attribution scan must be skippable",
  );
});

test("the Upgrader view derives its window totals from one scan", () => {
  const upgrader = source("src/lib/queries/analytics-upgrader.ts");
  const body = functionBody(upgrader, "computeUpgraderAnalytics");

  // The window-wide distinct-player count used to repeat the identical
  // filtered scan in a second round trip. It rides the day-bucket statement
  // now; the only other read is the `to_regclass` table probe.
  const reads = body.match(/queryRows</g) ?? [];
  assert.equal(
    reads.length,
    2,
    "computeUpgraderAnalytics must issue exactly the table probe plus one data read",
  );
  assert.match(
    body,
    /window_total AS \(\s*SELECT COUNT\(DISTINCT user_id\)/,
    "the window-wide player count must be computed inside the day-bucket statement",
  );
});

test("every analytics leg still degrades on its own", () => {
  // One slow or failed secondary read must turn into one fallback panel, not
  // a dead page — that is what `safeQuery`'s timeout wrapper buys.
  for (const relativePath of [
    "src/app/(admin)/analytics/overview-page.tsx",
    "src/app/(admin)/analytics/tab-packs.tsx",
    "src/app/(admin)/analytics/tab-map.tsx",
  ]) {
    const src = source(relativePath);
    assert.match(
      src,
      /safeQuery\(/,
      `${relativePath} must wrap its reads in safeQuery`,
    );
    assert.match(
      src,
      /REWARD_QUERY_TIMEOUT_MS/,
      `${relativePath} must bound its reads with the shared timeout budget`,
    );
  }
});
