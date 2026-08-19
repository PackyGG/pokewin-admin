import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type pg from "pg";

import { serviceRequestAuthorized } from "../src/auth.js";
import type { Databases } from "../src/db.js";
import {
  findNetworkClusterHighRiskMembers,
  listActiveNetworkClusterHighRiskMembers,
  maskIp,
  NETWORK_HIGH_RISK_CASE_PEAK_SCORE,
  NETWORK_HIGH_RISK_SIGNUP_SCORE,
  scoreAnalysisSignals,
  type AnalysisSignal,
} from "../src/network-risk.js";

const config = {
  API_TOKEN: "read-token-that-is-long-enough",
  API_ADMIN_TOKEN: "admin-token-that-is-long-enough",
};

test("network responses use stable masked IPv4 and IPv6 labels", () => {
  assert.equal(maskIp("203.0.113.42"), "203.0.113.x");
  assert.equal(maskIp("2001:db8:abcd:12::99"), "2001:db8:abcd:12::/64");
  assert.equal(maskIp("not-an-ip"), "Hidden IP");
});

test("analysis scores preserve raw points and cap the display at 100", () => {
  const signals: AnalysisSignal[] = [
    {
      key: "shared_device",
      title: "Shared device",
      detail: "3 accounts",
      points: 70,
      value: 3,
      threshold: 2,
      category: "network",
    },
    {
      key: "shared_ip",
      title: "Shared IP",
      detail: "4 accounts",
      points: 50,
      value: 4,
      threshold: 2,
      category: "affiliate",
    },
  ];
  assert.deepEqual(scoreAnalysisSignals(signals), {
    rawScore: 120,
    score: 100,
    severity: "critical",
    breakdown: { network: 70, affiliate: 50, behavior: 0 },
  });
});

test("scan, network-case, rule, and exact-IP routes require the admin token", () => {
  const routes: Array<[string, string]> = [
    ["POST", "/v1/networks/accounts/user-1/rescan"],
    ["POST", "/v1/creator-fraud/creator-1/rescan"],
    ["POST", "/v1/network-cases"],
    ["PUT", "/v1/analysis-rules/network_shared_ip"],
    ["GET", "/v1/networks/00000000-0000-0000-0000-000000000000/nodes/ip:key/reveal"],
  ];
  for (const [method, path] of routes) {
    assert.equal(
      serviceRequestAuthorized(method, path, config.API_TOKEN, config),
      false,
      `${method} ${path} accepted the read token`,
    );
    assert.equal(
      serviceRequestAuthorized(method, path, config.API_ADMIN_TOKEN, config),
      true,
      `${method} ${path} rejected the admin token`,
    );
  }
});

test("network storage isolates exact values and supports one live network case", async () => {
  const migration = await readFile(
    new URL("../migrations/008_account_networks_creator_fraud.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /CREATE TABLE IF NOT EXISTS network_node_secrets/);
  assert.match(migration, /cases_one_live_per_network/);
  assert.match(migration, /subject_type = 'network'/);
  assert.match(migration, /network_case_members/);

  const routes = await readFile(
    new URL("../src/network-routes.ts", import.meta.url),
    "utf8",
  );
  const graphRoute = routes.slice(
    routes.indexOf('app.get("/v1/networks/:snapshotId/graph"'),
    routes.indexOf('"/v1/networks/:snapshotId/nodes/:nodeKey/reveal"'),
  );
  assert.doesNotMatch(graphRoute, /network_node_secrets|exact_value/);
  assert.match(graphRoute, /AND source_key=ANY\(\$2::text\[\]\)/);
  // Both endpoints must be inside the returned node set. At large page sizes the account page
  // consumed the whole node budget and no connector nodes came back, while the edge query
  // still filtered on source_key alone -- so the graph shipped edges pointing at nodes the
  // client never received.
  assert.match(graphRoute, /AND target_key=ANY\(\$2::text\[\]\)/);
  assert.match(graphRoute, /\.max\(1_000\)/);
  assert.doesNotMatch(routes, /websocket:\s*true|EventSource/);
});

test("creator assessments retain account-level evidence and queue detected IP networks", async () => {
  const source = await readFile(
    new URL("../src/network-risk.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /ipGroups: ipEvidenceGroups/);
  assert.match(source, /walletGroups: walletEvidenceGroups/);
  assert.match(source, /group\.members\.map\(\(member\) => member\.userId\)/);
  assert.match(
    source,
    /this\.enqueueAccount\(group\.rootUserId, `creator:\$\{creatorUserId\}`\)/,
  );
  assert.doesNotMatch(
    source,
    /ipGroups:[\s\S]{0,200}(signup_ip|source_address)/,
    "creator metrics must not persist exact IPs or wallet addresses",
  );
});

test("creator assessments score referred accounts and exclude the creator account", async () => {
  const source = await readFile(
    new URL("../src/network-risk.ts", import.meta.url),
    "utf8",
  );
  const assessment = source.slice(
    source.indexOf("async assessCreator("),
    source.indexOf("private creatorEvidenceGroup("),
  );

  assert.equal(
    (assessment.match(/AND referred_user_id <> \$1/g) ?? []).length,
    2,
    "both cohort membership and affiliate aggregates must exclude the creator",
  );
  assert.match(assessment, /referred accounts share a deposit source wallet/);
  assert.match(assessment, /Referred-account value trails expected GGR/);
});

test("staff-requested network scans run ahead of background reconciliation", async () => {
  const source = await readFile(
    new URL("../src/network-risk.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /ORDER BY \(requested_by IS NULL\), created_at/);
});

function fakeAntifraudDb(
  handler: (sql: string, values: unknown[]) => { rows: Array<{ user_id: string }> },
): Databases {
  const antifraud = {
    async query(sql: string, values: unknown[]) {
      return handler(sql, values);
    },
  } as unknown as pg.Pool;
  return { source: antifraud, fiatDevSource: null, antifraud };
}

test("cluster evidence reuses the exact high-risk thresholds free-battle-risk.ts already uses", () => {
  assert.equal(NETWORK_HIGH_RISK_SIGNUP_SCORE, 60);
  assert.equal(NETWORK_HIGH_RISK_CASE_PEAK_SCORE, 80);
});

test("targeted cluster lookup skips the query entirely for an empty input", async () => {
  let calls = 0;
  const db = fakeAntifraudDb(() => {
    calls += 1;
    return { rows: [] };
  });
  const result = await findNetworkClusterHighRiskMembers(db, []);
  assert.deepEqual([...result], []);
  assert.equal(calls, 0);
});

test("targeted cluster lookup is bounded, indexed, and returns only flagged members", async () => {
  let queryText = "";
  let queryValues: unknown[] = [];
  const db = fakeAntifraudDb((sql, values) => {
    queryText = sql;
    queryValues = values;
    return { rows: [{ user_id: "participant-1" }] };
  });
  const result = await findNetworkClusterHighRiskMembers(db, [
    "participant-1",
    "participant-2",
  ]);
  assert.deepEqual([...result], ["participant-1"]);
  assert.match(queryText, /FROM network_nodes n/);
  assert.match(queryText, /suspectedAlt/);
  assert.match(queryText, /signup_assessments/);
  assert.match(queryText, /peak_score, 0\) >= \$3/);
  // The "latest snapshot per network_key" CTE is recency-bounded exactly like the active-scan
  // variant. Unbounded it scanned every snapshot ever taken, and -- because network_key is a
  // hash of the sorted member ids -- a superseded cluster kept a "latest" row forever, so an
  // account stayed flagged on a cluster that no longer exists with no way for a rescan to
  // clear it.
  assert.match(queryText, /scanned_at >= now\(\) - \(\$4::text \|\| ' days'\)::interval/);
  assert.deepEqual(queryValues, [
    ["participant-1", "participant-2"],
    NETWORK_HIGH_RISK_SIGNUP_SCORE,
    NETWORK_HIGH_RISK_CASE_PEAK_SCORE,
    30,
  ]);
});

test("creator network metrics use the same recency-bounded latest-snapshot CTE", async () => {
  const source = await readFile(
    new URL("../src/network-risk.ts", import.meta.url),
    "utf8",
  );
  const metrics = source.slice(source.indexOf("private async creatorNetworkMetrics("));
  assert.match(
    metrics,
    /scanned_at >= now\(\) - \(\$2::text \|\| ' days'\)::interval/,
  );
  assert.match(metrics, /\[userIds, CLUSTER_SCAN_LOOKBACK_DAYS\]/);
});

test("latest network snapshots stream deterministically from a covering index", async () => {
  const [source, migration] = await Promise.all([
    readFile(new URL("../src/network-risk.ts", import.meta.url), "utf8"),
    readFile(
      new URL(
        "../migrations/086_network_snapshot_latest_covering_index.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);

  assert.equal(
    (source.match(/ORDER BY network_key, scanned_at DESC, id DESC/g) ?? [])
      .length,
    3,
  );
  assert.match(
    migration,
    /ON network_snapshots\(network_key, scanned_at DESC, id DESC\)/,
  );
  assert.match(migration, /DROP INDEX IF EXISTS network_snapshots_key_scanned_idx/);
});

test("stale network scan jobs are recovered a bounded number of times", async () => {
  const source = await readFile(
    new URL("../src/network-risk.ts", import.meta.url),
    "utf8",
  );
  const recovery = source.slice(
    source.indexOf("private async recoverStaleJobs("),
    source.indexOf("private async claimJob("),
  );
  // A job that reliably kills its worker must stop re-leasing and blocking the queue head.
  assert.match(recovery, /recovery_count=COALESCE\(recovery_count, 0\) \+ 1/);
  assert.match(recovery, /COALESCE\(recovery_count, 0\) < \$1::int/);
  assert.match(recovery, /COALESCE\(recovery_count, 0\) >= \$1::int/);
  assert.match(recovery, /SET status='failed'/);

  const migration = await readFile(
    new URL(
      "../migrations/067_network_scan_job_recovery_bound.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    migration,
    /ADD COLUMN IF NOT EXISTS recovery_count integer NOT NULL DEFAULT 0/,
  );
});

test("creator IP-chain grouping normalizes addresses the same way the graph builder does", async () => {
  const source = await readFile(
    new URL("../src/network-risk.ts", import.meta.url),
    "utf8",
  );
  const assessment = source.slice(
    source.indexOf("const ipMembers = new Map<string, SourceAccount[]>();"),
    source.indexOf("const sharedIpGroups"),
  );
  // Grouping on the raw string split one shared chain into sub-threshold groups whenever the
  // same address arrived with different whitespace/formatting.
  assert.match(assessment, /const signupIp = validIp\(account\.signup_ip\)/);
  assert.doesNotMatch(assessment, /ipMembers\.get\(account\.signup_ip\)/);
});

test("targeted cluster lookup with no matches leaves the result empty (unaffected accounts stay unaffected)", async () => {
  const db = fakeAntifraudDb(() => ({ rows: [] }));
  const result = await findNetworkClusterHighRiskMembers(db, ["participant-1"]);
  assert.equal(result.size, 0);
});

test("active cluster scan is capped by a lookback window and a bounded row limit", async () => {
  let queryText = "";
  let queryValues: unknown[] = [];
  const db = fakeAntifraudDb((sql, values) => {
    queryText = sql;
    queryValues = values;
    return { rows: [{ user_id: "creator-1" }] };
  });
  const result = await listActiveNetworkClusterHighRiskMembers(db);
  assert.deepEqual([...result], ["creator-1"]);
  assert.match(queryText, /scanned_at >= now\(\) - \(\$3::text \|\| ' days'\)::interval/);
  assert.match(queryText, /LIMIT \$4/);
  assert.deepEqual(queryValues, [
    NETWORK_HIGH_RISK_SIGNUP_SCORE,
    NETWORK_HIGH_RISK_CASE_PEAK_SCORE,
    30,
    5_000,
  ]);
});
