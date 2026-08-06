import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path: string): Promise<string> {
  return readFile(new URL(`../../${path}`, import.meta.url), "utf8");
}

test("the automatic Fiat eligibility explainer remains a guarded direct route", async () => {
  const [page, sidebar, hosts] = await Promise.all([
    source("src/app/(antifraud)/antifraud/fiat-eligibility/page.tsx"),
    source("src/app/(antifraud)/antifraud/_components/antifraud-sidebar.tsx"),
    source("src/lib/app-hosts.ts"),
  ]);

  assert.match(page, /requireAntifraudManagerPage\(\)/);
  assert.match(page, /Automatic Fiat eligibility/);
  assert.match(
    page,
    /allowed = no blocking signal AND final risk score &lt; 50/,
  );
  assert.match(page, /Fingerprint Pro Plus/);
  assert.match(page, /proxycheck\.io/);
  assert.match(page, /Single-use Fingerprint event/);
  assert.match(page, /new call = new check/);
  assert.match(page, /Latest login IP changed/);
  assert.match(page, /below \$15 counts at 25% strength/);
  assert.match(page, /Automatic containment/);
  assert.doesNotMatch(page, /expires after 60 seconds/);
  assert.match(page, /Fail closed/);
  assert.doesNotMatch(sidebar, /href:\s*"\/antifraud\/fiat-eligibility"/);
  assert.match(
    hosts,
    /host:\s*`fraud\.\$\{ROOT_DOMAIN\}`[\s\S]*?segmentRoutes:\s*\[[\s\S]*?"fiat-eligibility"/,
  );
});

test("the page documents the service's canonical binary threshold", async () => {
  const [service, policy] = await Promise.all([
    source("services/antifraud-monitor/src/fiat-eligibility.ts"),
    source("services/antifraud-monitor/src/fiat-eligibility-policy.ts"),
  ]);

  assert.match(service, /AUTOMATIC_DENY_SCORE,/);
  assert.match(policy, /export const AUTOMATIC_DENY_SCORE = 50/);
  assert.match(
    policy,
    /deduped\.some\(\(signal\) => signal\.blocking\)[\s\S]*?blocked \|\| riskScore >= AUTOMATIC_DENY_SCORE[\s\S]*?\? "deny"[\s\S]*?: "allow"/,
  );
  assert.match(policy, /export const DECISION_TTL_MS = 60_000/);
  assert.match(policy, /export const MAX_REQUEST_AGE_MS = 120_000/);
});
