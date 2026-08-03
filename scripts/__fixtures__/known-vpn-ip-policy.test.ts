import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string): string => readFileSync(path, "utf8");
const ui = read("src/app/(antifraud)/antifraud/_components/identifier-blocklist-client.tsx");
const actions = read("src/app/(antifraud)/antifraud/_components/identifier-blocklist-actions.ts");
const migration = read("services/antifraud-monitor/migrations/052_known_vpn_identifier_policy.sql");
const signup = read("services/antifraud-monitor/src/identifier-blocklists.ts");
const fiat = read("services/antifraud-monitor/src/fiat-eligibility-policy.ts");
const perks = read("services/antifraud-monitor/src/fiat-perks.ts");

test("known VPN is a distinct audited non-containing IP policy", () => {
  assert.match(migration, /effect = 'block'.*known_vpn/is);
  assert.match(ui, /Known VPN/);
  assert.match(ui, /Move to known VPN/);
  assert.match(ui, /VPN\/proxy detected/);
  assert.match(actions, /antifraud_identifier_marked_known_vpn/);
  assert.match(signup, /known_vpn_ip[\s\S]*points: 15/);
  assert.match(signup, /"no_action"/);
  assert.match(fiat, /known_vpn_ip_match[\s\S]*points: 15[\s\S]*containing: false/);
  assert.match(perks, /b\.effect = 'block'/);
});
