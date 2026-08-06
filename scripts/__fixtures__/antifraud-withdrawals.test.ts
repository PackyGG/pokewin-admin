import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

test("the standalone Antifraud withdrawal feature stays removed", () => {
  for (const file of [
    "src/app/(antifraud)/antifraud/withdrawals/page.tsx",
    "src/app/(antifraud)/antifraud/withdrawals/actions.ts",
    "src/app/(antifraud)/antifraud/withdrawals/[id]/page.tsx",
    "src/lib/antifraud/withdrawals-api.ts",
    "services/antifraud-monitor/src/withdrawal-risk.ts",
    "services/antifraud-monitor/src/withdrawal-routes.ts",
  ]) {
    assert.equal(existsSync(path.join(root, file)), false, file);
  }

  const sidebar = read(
    "src/app/(antifraud)/antifraud/_components/antifraud-sidebar.tsx",
  );
  const hosts = read("src/lib/app-hosts.ts");
  const middleware = read("src/middleware.ts");
  const mainWithdrawals = read("src/app/(admin)/withdrawals/page.tsx");
  const server = read("services/antifraud-monitor/src/server.ts");
  const auth = read("services/antifraud-monitor/src/auth.ts");
  const fraudRoutes = hosts.slice(
    hosts.indexOf("host: `fraud.${ROOT_DOMAIN}`"),
    hosts.indexOf("host: `marketing.${ROOT_DOMAIN}`"),
  );

  assert.doesNotMatch(sidebar, /\/antifraud\/withdrawals/);
  assert.doesNotMatch(fraudRoutes, /"withdrawals"/);
  assert.doesNotMatch(middleware, /if \(pathname === "\/withdrawals"\)/);
  assert.match(mainWithdrawals, /requirePageAccess\("\/withdrawals"\)/);
  assert.match(mainWithdrawals, /getWithdrawals/);
  assert.doesNotMatch(server, /WithdrawalRiskService|registerWithdrawalRoutes/);
  assert.doesNotMatch(auth, /\/v1\/withdrawals/);
});

test("normal withdrawals and Fraud withdrawal-lock controls remain separate", () => {
  const mainNav = read("src/lib/nav-config.ts");
  const reviewActions = read(
    "src/app/(antifraud)/antifraud/reviews/actions.ts",
  );
  const fiatHolds = read(
    "services/antifraud-monitor/src/fiat-withdrawal-holds.ts",
  );

  assert.match(mainNav, /href: "\/withdrawals"/);
  assert.match(reviewActions, /lock_withdrawals/);
  assert.match(fiatHolds, /fiat_deposit_withdrawal_hold/);
});
