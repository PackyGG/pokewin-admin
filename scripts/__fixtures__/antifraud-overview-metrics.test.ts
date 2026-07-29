import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pagePath = "src/app/(antifraud)/antifraud/page.tsx";
const queryPath = "src/lib/antifraud/overview.ts";
const loadingPath = "src/app/(antifraud)/antifraud/loading.tsx";

test("fraud overview shows the four requested lifetime account metrics", async () => {
  const [page, query, loading] = await Promise.all([
    readFile(pagePath, "utf8"),
    readFile(queryPath, "utf8"),
    readFile(loadingPath, "utf8"),
  ]);

  assert.match(page, /label="Total fiat deposits"/);
  assert.match(page, /label="Fraud account deposits"/);
  assert.match(page, /label="KYC accounts"/);
  assert.match(page, /label="Automatic KYC \/ flagged"/);
  assert.doesNotMatch(page, /label="Open cases"|label="In review"/);
  assert.match(page, /lg:grid-cols-4/);
  assert.match(loading, /Array\.from\(\{ length: 4 \}\)/);

  assert.match(query, /paid_at IS NOT NULL/);
  assert.match(query, /antifraud_reviews\.status,\s*"flagged"/);
  assert.match(query, /kyc_required_by LIKE 'system:antifraud-%'/);
  assert.match(query, /admin_decision <> 'pending'/);
  assert.match(query, /unstable_cache\(/);
  assert.match(query, /revalidate: 60/);
});
