import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string): string => readFileSync(path, "utf8");

test("Fiat screening is absent from the dashboard and monitor runtime", () => {
  const removedPaths = [
    "src/app/(antifraud)/antifraud/fiat-perks/page.tsx",
    "src/lib/antifraud/fiat-perks-api.ts",
    "services/antifraud-monitor/src/fiat-perks.ts",
    "services/antifraud-monitor/src/fiat-perk-routes.ts",
    "services/antifraud-monitor/src/fiat-perk-access.ts",
  ];
  for (const path of removedPaths) {
    assert.equal(existsSync(path), false, `${path} must stay removed`);
  }

  const sidebar = read(
    "src/app/(antifraud)/antifraud/_components/antifraud-sidebar.tsx",
  );
  const server = read("services/antifraud-monitor/src/server.ts");
  const eligibility = read(
    "services/antifraud-monitor/src/fiat-eligibility.ts",
  );
  const config = read("services/antifraud-monitor/src/config.ts");

  assert.doesNotMatch(sidebar, /fiat-perks|Screening/);
  assert.doesNotMatch(server, /FiatPerk|fiat-perk/);
  assert.doesNotMatch(eligibility, /fiat_perk|perkGate/);
  assert.doesNotMatch(config, /FIAT_PERK_GATE_ENABLED/);
});

test("Fraud Config owns the global Fiat availability switch", () => {
  const page = read("src/app/(antifraud)/antifraud/config/page.tsx");
  const card = read(
    "src/app/(antifraud)/antifraud/config/fiat-availability-card.tsx",
  );
  const sidebar = read(
    "src/app/(antifraud)/antifraud/_components/antifraud-sidebar.tsx",
  );

  assert.match(sidebar, /Config.*\/antifraud\/config/);
  assert.match(page, /GlobalFiatAvailabilityCard/);
  assert.match(card, /setGlobalFiatDeposits/);
  assert.match(card, /Global Fiat deposits/);
});
