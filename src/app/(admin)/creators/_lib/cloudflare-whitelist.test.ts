import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseRuleExpression,
  buildRuleExpression,
  isValidIp,
  isValidKey,
  parseList,
} from "./cloudflare-whitelist.ts";

// A trimmed copy of the live rule expression (two IPs, two keys).
const SAMPLE =
  '(starts_with(http.request.uri.path, "/v1/affiliate/stats") and ip.src in {1.2.3.4 2a02:4780:f:bfde::1}) or ' +
  '(starts_with(http.request.uri.path, "/v1/affiliate/stats") and any(http.request.headers["x-custom-key"][*] in {"55d80e40-7673-45c6-b504-12136de9b322" "abc123"}))';

test("parses ips and keys out of the live expression shape", () => {
  const parsed = parseRuleExpression(SAMPLE);
  assert.deepEqual(parsed, {
    ips: ["1.2.3.4", "2a02:4780:f:bfde::1"],
    keys: ["55d80e40-7673-45c6-b504-12136de9b322", "abc123"],
  });
});

test("build → parse round-trips", () => {
  const wl = { ips: ["10.0.0.1", "::1"], keys: ["k1", "k2", "k3"] };
  assert.deepEqual(parseRuleExpression(buildRuleExpression(wl)), wl);
});

test("refuses an expression that doesn't match the template", () => {
  assert.equal(parseRuleExpression("ip.src eq 1.2.3.4"), null);
});

test("validators block injection chars", () => {
  assert.ok(isValidIp("1.2.3.4"));
  assert.ok(isValidIp("2a02:4780:f::1"));
  assert.ok(isValidIp("10.0.0.0/24"));
  assert.ok(!isValidIp('1.2.3.4} or true')); // brace/space escape attempt
  assert.ok(!isValidIp("notanip"));

  assert.ok(isValidKey("55d80e40-7673-45c6-b504-12136de9b322"));
  assert.ok(!isValidKey('a" "b')); // quote escape attempt
  assert.ok(!isValidKey("a}b"));
});

test("parseList splits on whitespace, commas, newlines", () => {
  assert.deepEqual(parseList("a, b\nc  d"), ["a", "b", "c", "d"]);
  assert.deepEqual(parseList("   "), []);
});
