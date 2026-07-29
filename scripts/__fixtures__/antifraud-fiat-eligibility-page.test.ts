import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path: string): Promise<string> {
  return readFile(new URL(`../../${path}`, import.meta.url), "utf8");
}

test("Fraud System exposes the automatic Fiat eligibility explainer", async () => {
  const [page, sidebar, hosts] = await Promise.all([
    source("src/app/(antifraud)/antifraud/fiat-eligibility/page.tsx"),
    source("src/app/(antifraud)/antifraud/_components/antifraud-sidebar.tsx"),
    source("src/lib/app-hosts.ts"),
  ]);

  assert.match(page, /requireAntifraudManagerPage\(\)/);
  assert.match(page, /Automatic Fiat eligibility/);
  assert.match(page, /allowed = no blocking signal AND final risk score &lt; 50/);
  assert.match(page, /Fingerprint Pro Plus/);
  assert.match(page, /proxycheck\.io/);
  assert.match(page, /Single-use Fingerprint event/);
  assert.match(page, /Fail closed/);
  assert.match(
    sidebar,
    /label:\s*"Fiat Eligibility",[\s\S]*?href:\s*"\/antifraud\/fiat-eligibility"/,
  );
  assert.match(
    hosts,
    /host:\s*`fraud\.\$\{ROOT_DOMAIN\}`[\s\S]*?segmentRoutes:\s*\[[\s\S]*?"fiat-eligibility"/,
  );
});

test("the page documents the service's canonical binary threshold", async () => {
  const service = await source(
    "services/antifraud-monitor/src/fiat-eligibility.ts",
  );

  assert.match(service, /const AUTOMATIC_DENY_SCORE = 50/);
  assert.match(
    service,
    /deduped\.some\(\(signal\) => signal\.blocking\)[\s\S]*?riskScore >= AUTOMATIC_DENY_SCORE[\s\S]*?\? "deny"[\s\S]*?: "allow"/,
  );
  assert.match(service, /const DECISION_TTL_MS = 60_000/);
  assert.match(service, /const MAX_REQUEST_AGE_MS = 120_000/);
});
