import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path: string): Promise<string> {
  return readFile(new URL(`../../${path}`, import.meta.url), "utf8");
}

test("signup ingestion owns one private Opportify fraud analysis", async () => {
  const [config, enrichment, monitor, signupSource] = await Promise.all([
    source("services/antifraud-monitor/src/config.ts"),
    source("services/antifraud-monitor/src/enrichment.ts"),
    source("services/antifraud-monitor/src/monitor.ts"),
    source("services/antifraud-monitor/src/source.ts"),
  ]);

  assert.match(config, /OPPORTIFY_API_KEY: z\.string\(\)\.min\(1\)/);
  assert.match(
    enrichment,
    /https:\/\/api\.opportify\.ai\/intel\/v1\/fraud\/analyze/,
  );
  assert.match(enrichment, /"x-opportify-token": this\.config\.OPPORTIFY_API_KEY/);
  assert.match(enrichment, /submissionType: "registration"/);
  assert.match(enrichment, /fullName: signup\.name/);
  assert.match(enrichment, /username: signup\.username/);
  assert.match(enrichment, /country: signup\.country_code/);
  assert.doesNotMatch(enrichment, /opportifyToken:/);
  assert.doesNotMatch(enrichment, /opportifyFormUUID:/);
  assert.match(signupSource, /u\.id, u\.name, u\.username, u\.email/);
  assert.match(monitor, /cachedOpportify\(signup, weights\)/);
  assert.match(monitor, /provider = 'opportify'/);
  assert.match(monitor, /user_id = \$1[\s\S]*provider = 'opportify'/);
});

test("Opportify is visible as independent signup evidence", async () => {
  const [server, schema, settings, migration] = await Promise.all([
    source("services/antifraud-monitor/src/server.ts"),
    source("src/lib/antifraud/signups.ts"),
    source("src/app/(antifraud)/antifraud/settings/_sections/integrations.tsx"),
    source(
      "services/antifraud-monitor/migrations/036_opportify_signup_intelligence.sql",
    ),
  ]);

  assert.match(server, /opportify\.score AS opportify_score/);
  assert.match(schema, /opportify_score: z\.number\(\)\.nullable\(\)/);
  assert.match(settings, /name: "Opportify Full Fraud Check"/);
  assert.match(migration, /'opportify_risk_medium', 25/);
  assert.match(migration, /'opportify_risk_high', 60/);
  assert.match(migration, /'opportify_risk_highest', 100/);
});
