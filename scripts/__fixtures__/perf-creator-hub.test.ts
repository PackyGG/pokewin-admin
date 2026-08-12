import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * Read-count guardrails for the (creator-hub) area.
 *
 * Every MAIN read on this surface passes through a process-wide admission
 * semaphore sized to the mirror pool (`withReadAdmissionControl`, src/lib/db.ts),
 * and mirror clients are retired after a single checkout (`maxUses: 1`) — so a
 * "cheap" extra statement still costs a permit AND a fresh connection. Each leg
 * is separately bounded by its own `safeQuery` timeout, which means the failure
 * mode behind "Couldn't load this section" is not one slow query: it is TOTAL
 * reads per render. Once enough legs queue behind the cap, the tail blows its
 * own budget and tiles blank one at a time, differently on every reload.
 *
 * These tests pin STRUCTURE — how many independent reads a render may issue and
 * whether duplicate consumers share one execution — never tuning values. Pool
 * sizes, TTLs and timeout budgets are deliberately not asserted; they are
 * measured numbers that should stay free to move.
 *
 * Source is read with `readFileSync` rather than imported: these modules are
 * `server-only` and reach the pg pool transitively, and a root fixture must
 * never pull runtime dependencies that only exist outside the Vercel root
 * install.
 */
const read = (path: string) => readFileSync(path, "utf8");

/**
 * Source with comments stripped.
 *
 * Every assertion below is about what the module DOES. The modules carry
 * deliberately detailed comments naming the call sites that were merged away
 * ("these used to be three sequential queryRows calls"), so matching raw text
 * would fail on the very prose that documents the fix and would push the next
 * author to delete the explanation to get the gate green.
 */
const code = (path: string) =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

const count = (source: string, pattern: RegExp) =>
  source.match(pattern)?.length ?? 0;

const HUB = "src/app/(creator-hub)/creator-hub";

test("every Creator Hub route ships the shell-first loading.tsx its page needs", () => {
  // Shell-first is a repo mandate: the page renders its heading + static
  // controls immediately and streams data behind <Suspense>, with a matching
  // loading.tsx so a navigation paints the same shell instead of a blank
  // frame. A page.tsx without a sibling loading.tsx cannot satisfy that for
  // the navigation case, however well its body is structured.
  const missing: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry === "page.tsx") {
        try {
          statSync(join(dir, "loading.tsx"));
        } catch {
          missing.push(dir);
        }
      }
    }
  };
  walk(HUB);

  assert.deepEqual(
    missing,
    [],
    `every Creator Hub page must ship a sibling loading.tsx rendering the same ` +
      `shell; missing for: ${missing.join(", ")}`,
  );
});

test("Tips & Sponsors legs de-duplicate across their Suspense boundaries", () => {
  const page = code(`${HUB}/tips-sponsors/page.tsx`);
  const data = code(`${HUB}/tips-sponsors/_queries/tips-sponsors-data.ts`);

  // The page deliberately consumes each leg from several independent
  // boundaries (headline tiles, chart/ranklist, reconciliation). That is good
  // streaming design — but `unstable_cache` does NOT coalesce concurrent COLD
  // callers, so without a request-level memo a cache miss ran the ledger leg's
  // reads once PER boundary and fanned the backend session walk out three
  // times in parallel.
  const ledgerConsumers = count(
    page,
    /getTipsSponsorsLedgerOverview\(/g,
  );
  const sessionConsumers = count(page, /getTipsSponsorsSessionsOverview\(/g);
  assert.ok(
    ledgerConsumers > 1 && sessionConsumers > 1,
    "tips-sponsors/page.tsx is expected to consume each leg from more than one " +
      "streamed section — if that stopped being true this guardrail needs rewriting",
  );

  for (const entry of [
    "getTipsSponsorsLedgerOverview",
    "getTipsSponsorsSessionsOverview",
  ]) {
    assert.match(
      data,
      new RegExp(`export const ${entry} = cache\\(`),
      `${entry} must stay wrapped in React cache() — it is awaited from ` +
        `multiple Suspense boundaries in one render, and unstable_cache alone ` +
        `lets every cold caller run the underlying reads again`,
    );
  }
});

test("the Hub dashboard's creator-cost breakdown is one MAIN statement", () => {
  const cost = code(`${HUB}/_queries/hub-dashboard-creator-cost.ts`);

  // Multiplier vouchers + house-funded tips + leaderboard prize gross used to
  // be three SEQUENTIAL round-trips. They are three scalar subqueries in one
  // statement now: same predicates, same indexes, one checkout.
  assert.equal(
    count(cost, /queryRows</g),
    1,
    "hub-dashboard-creator-cost.ts must issue ONE MAIN statement for its SQL " +
      "cost legs — splitting them again costs a mirror permit and a fresh " +
      "connection per leg on the Hub's busiest page",
  );

  // All three legs must still be present in that single statement.
  for (const leg of [
    "creator_multiplier_payout",
    "creator_fill_spend_tip",
    "affiliate_leaderboard_prize",
  ]) {
    assert.ok(
      cost.includes(leg),
      `the merged cost statement must still carry the '${leg}' leg — the ` +
        `breakdown total is the sum of all three plus the fill-conversion leg`,
    );
  }
});

test("the upgrader table probe is not a per-render MAIN read", () => {
  const cohort = code(`${HUB}/_queries/hub-dashboard-cohort.ts`);

  // The probe is part of the chart cache's KEY, so it cannot live inside that
  // entry — which is exactly why it used to run on every dashboard render.
  // It now has its own long-lived cache; whether a table exists changes only
  // on a migration.
  const requestScoped = cohort.slice(
    cohort.indexOf("export async function getHubCohortCharts"),
  );
  assert.ok(
    requestScoped.length > 0,
    "getHubCohortCharts must still be the request-scoped entry point",
  );
  assert.ok(
    !/to_regclass/.test(requestScoped),
    "the upgrader-table probe must not run in the request scope of " +
      "getHubCohortCharts — un-memoized it is a full extra MAIN read (permit + " +
      "connection handshake) on every Creator Hub dashboard render",
  );
  assert.match(
    cohort,
    /unstable_cache\([\s\S]*to_regclass/,
    "the upgrader-table probe must stay behind unstable_cache",
  );
});

test("the Alt Accounts tab scans each source table once", () => {
  const alts = code(`${HUB}/creators/[id]/_queries/alt-accounts-data.ts`);

  // Seven signals used to be seven serial statements over four distinct
  // sources: three separate scans of the cohort's `ledger_transactions`
  // deposits, two builds of the identical `user_ips` relation, and two scans
  // of `fingerprints`. They are merged into one statement per source now
  // (each duplicated relation scanned once and re-grouped via UNION ALL).
  assert.equal(
    count(alts, /WITH cohort_deposits AS/g),
    1,
    "the cohort's deposit rows must be selected by ONE statement",
  );
  assert.equal(
    count(alts, /FROM cohort_deposits/g),
    3,
    "the reused-wallet, synchronized-deposit and identical-deposit signals " +
      "must all re-group the SAME materialised deposit scan — three separate " +
      "statements over the same rows is what this merge removed",
  );
  assert.equal(
    count(alts, /WITH user_ips AS/g),
    2,
    "shared-IP and shared-subnet must be grouped from ONE user_ips relation " +
      "(the two occurrences are the with/without-fingerprints variants of the " +
      "same single statement, not two statements)",
  );

  // Whole-module read budget: cohort codes + cohort users + fingerprints-table
  // probe + the three merged signal statements + the two enrichment aggregates
  // = 8 (plus the Drizzle user lookup inside enrichMembers). It was 13 before
  // the merge.
  const reads = count(alts, /queryMainRows</g);
  assert.ok(
    reads <= 8,
    `alt-accounts-data.ts issues ${reads} queryMainRows call sites; the tab's ` +
      `budget is 8. Adding a signal means folding it into the existing ` +
      `per-source statement, not opening another checkout`,
  );

  // The merge must not have dropped a signal: every kind still has to be
  // produced and still has to carry its own gap copy when it degrades.
  for (const kind of [
    "shared_ip",
    "shared_subnet",
    "shared_device",
    "reused_wallet",
    "synchronized_deposit",
    "identical_deposit",
    "platform_alt_flag",
  ]) {
    assert.ok(
      alts.includes(`'${kind}'`) || alts.includes(`"${kind}"`),
      `the '${kind}' signal must survive the query merge`,
    );
  }
});

test("the creator metadata tab resolves the referrer without a third round-trip", () => {
  const meta = code(`${HUB}/creators/[id]/_queries/creator-metadata.ts`);

  // The referrer's display name used to be a SERIAL follow-up read that could
  // only start once the user row came back. It is a LEFT JOIN on the primary
  // key in the same statement now — same result (null for no referrer or a
  // dangling id), one fewer checkout.
  assert.match(
    meta,
    /leftJoin\(referrerUsers/,
    "the referrer lookup must stay folded into the user-record statement",
  );
  assert.ok(
    !/referredByName = referrer/.test(meta),
    "the referrer name must not be re-read in its own round-trip",
  );
});
