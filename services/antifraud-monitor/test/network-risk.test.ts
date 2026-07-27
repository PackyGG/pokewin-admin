import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { serviceRequestAuthorized } from "../src/auth.js";
import {
  maskIp,
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
  assert.doesNotMatch(graphRoute, /target_key=ANY/);
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
