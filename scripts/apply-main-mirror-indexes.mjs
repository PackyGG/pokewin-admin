import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import pg from "pg";

const { Client } = pg;
const repoRoot = path.resolve(import.meta.dirname, "..");
const target = process.argv[2];

if (!["prod", "dev", "all"].includes(target)) {
  console.error("Usage: node scripts/apply-main-mirror-indexes.mjs <prod|dev|all>");
  process.exit(2);
}

function loadLocalEnv() {
  const envPath = path.join(repoRoot, ".env");
  if (!fs.existsSync(envPath)) return;

  for (const rawLine of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const name = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[name]) process.env[name] = value;
  }
}

function endpointIdentity(rawUrl) {
  const url = new URL(rawUrl);
  const port = url.port || "5432";
  return `${url.hostname.toLowerCase()}:${port}${url.pathname}`;
}

function statementsFrom(filePath) {
  const withoutLineComments = fs
    .readFileSync(filePath, "utf8")
    .replace(/^\s*--.*$/gm, "");
  return [
    ...withoutLineComments.matchAll(
      /(?:CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS|DROP\s+INDEX\s+CONCURRENTLY\s+IF\s+EXISTS)[\s\S]*?;/gi,
    ),
  ].map((match) => match[0].trim());
}

function indexName(statement) {
  const match = statement.match(
    /(?:CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS|DROP\s+INDEX\s+CONCURRENTLY\s+IF\s+EXISTS)\s+"?([a-zA-Z0-9_]+)"?/i,
  );
  if (!match) throw new Error("Could not identify index statement");
  return match[1];
}

const excludedRecommendations = new Set([
  "admin_audit_events_created_at_idx",
  "admin_audit_events_event_type_idx",
  "admin_audit_events_admin_user_id_idx",
  "admin_audit_events_target_user_id_idx",
  "idx_acu_affiliate_user_created_at",
  "idx_battle_participants_battle_id",
  "idx_ledger_tx_deposit_created_at",
  "idx_ledger_tx_user_created_at",
  "idx_ledger_tx_user_type_status_created_at",
  "idx_ledger_user_deposit_created",
  "idx_pf_battle_id",
  "idx_user_created_at",
  "idx_user_lower_display_username_trgm",
  "idx_user_lower_name_trgm",
  "idx_user_lower_username_trgm",
  "promo_codes_code_hash_unique",
]);

const sourceStatements = statementsFrom(
  path.join(repoRoot, "services/antifraud-monitor/migrations/source-mirror-indexes.sql"),
);
const recommendedStatements = statementsFrom(
  path.join(repoRoot, "prisma/recommended-indexes.sql"),
).filter((statement) => !excludedRecommendations.has(indexName(statement)));
const statements = [...sourceStatements, ...recommendedStatements];

async function applyTarget(name) {
  const isProd = name === "prod";
  const mirrorKey = isProd ? "MIRROR_PRODUCTION_DB" : "MIRROR_DEV_DB";
  const primaryKey = isProd ? "DATABASE_URL" : "DEV_DATABASE_URL";
  const mirrorUrl = process.env[mirrorKey];
  const primaryUrl = process.env[primaryKey];

  if (!mirrorUrl || !primaryUrl) {
    throw new Error(`${mirrorKey} and ${primaryKey} must both be configured`);
  }
  if (endpointIdentity(mirrorUrl) === endpointIdentity(primaryUrl)) {
    throw new Error(`${mirrorKey} resolves to the protected ${primaryKey} endpoint`);
  }

  const client = new Client({
    connectionString: mirrorUrl,
    application_name: `pokewin-admin-mirror-indexes-${name}`,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 0,
  });
  const summary = { target: name, created: [], skipped: [], dropped: [] };

  try {
    await client.connect();
    await client.query("SET default_transaction_read_only = off");
    const preflight = await client.query(`
      SELECT
        pg_is_in_recovery() AS is_recovery,
        has_schema_privilege(current_user, 'public', 'CREATE') AS can_create
    `);
    if (preflight.rows[0]?.is_recovery) {
      throw new Error(`${mirrorKey} is a recovery replica and cannot accept index DDL`);
    }
    if (!preflight.rows[0]?.can_create) {
      throw new Error(`${mirrorKey} user lacks CREATE on schema public`);
    }

    await client.query(
      "SELECT pg_advisory_lock(hashtext('pokewin-admin-main-mirror-indexes-v1'))",
    );
    try {
      for (const statement of statements) {
        const name = indexName(statement);
        const isDrop = /^DROP/i.test(statement);

        if (!isDrop) {
          const existing = await client.query(
            `SELECT i.indisvalid
               FROM pg_class c
               JOIN pg_index i ON i.indexrelid = c.oid
              WHERE c.relkind = 'i' AND c.relname = $1`,
            [name],
          );
          if (existing.rows[0]?.indisvalid) {
            summary.skipped.push(name);
            continue;
          }
          if (existing.rows.length) {
            await client.query(`DROP INDEX CONCURRENTLY IF EXISTS "${name}"`);
            summary.dropped.push(name);
          }
        }

        await client.query(statement);
        (isDrop ? summary.dropped : summary.created).push(name);
      }
    } finally {
      await client.query(
        "SELECT pg_advisory_unlock(hashtext('pokewin-admin-main-mirror-indexes-v1'))",
      );
    }
  } finally {
    await client.end().catch(() => undefined);
  }

  return summary;
}

loadLocalEnv();
const targets = target === "all" ? ["dev", "prod"] : [target];
const results = [];
try {
  for (const name of targets) results.push(await applyTarget(name));
  console.log(JSON.stringify(results, null, 2));
} catch (error) {
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : "MIRROR_INDEX_APPLY_FAILED";
  const message =
    code === "MIRROR_INDEX_APPLY_FAILED" && error instanceof Error
      ? error.message
      : "The configured mirror connection or index operation failed";
  console.error(JSON.stringify({ target, status: "failed", code, message }));
  process.exitCode = 1;
}
