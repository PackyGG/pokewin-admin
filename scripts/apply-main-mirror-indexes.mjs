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
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("A configured database URL is invalid");
  }
  const port = url.port || "5432";
  return `${url.hostname.toLowerCase()}:${port}${url.pathname}`;
}

function endpointDetails(rawUrl) {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    return {
      host: url.hostname,
      port: Number(url.port || "5432"),
      database: decodeURIComponent(url.pathname.replace(/^\/+/, "")) || null,
      sslMode: url.searchParams.get("sslmode"),
      libpqCompat: url.searchParams.get("uselibpqcompat") === "true",
    };
  } catch {
    return { invalid: true };
  }
}

function mirrorConnectionString(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("The configured mirror database URL is invalid");
  }
  if (
    url.searchParams.get("sslmode") === "require" &&
    !url.searchParams.has("uselibpqcompat")
  ) {
    // node-postgres 8 aliases sslmode=require to verify-full. The mirrors use
    // the standard libpq meaning: encrypted transport without CA validation.
    url.searchParams.set("uselibpqcompat", "true");
  }
  return url.toString();
}

function redactedErrorMessage(error) {
  if (!(error instanceof Error)) return "Unknown mirror index operation failure";
  return error.message
    .replace(/(postgres(?:ql)?:\/\/)[^@\s]+@/gi, "$1[redacted]@")
    .replace(/\bpassword\s*=\s*[^\s]+/gi, "password=[redacted]");
}

function errorField(error, field) {
  if (typeof error !== "object" || error === null || !(field in error)) return undefined;
  const value = error[field];
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function errorHint(code) {
  switch (code) {
    case "ECONNREFUSED":
      return "The host responded, but no PostgreSQL listener accepted this port";
    case "ETIMEDOUT":
      return "The endpoint did not respond; check routing, firewall, and allowlists";
    case "ENOTFOUND":
      return "The configured database hostname did not resolve";
    case "28P01":
      return "PostgreSQL rejected the configured username or password";
    case "3D000":
      return "The configured PostgreSQL database does not exist";
    case "42501":
      return "The mirror user lacks a required PostgreSQL privilege";
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "SELF_SIGNED_CERT_IN_CHAIN":
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
      return "TLS reached PostgreSQL, but the server did not present a certificate chain trusted by Node.js";
    case "ERR_TLS_CERT_ALTNAME_INVALID":
      return "TLS reached PostgreSQL, but the certificate does not match the configured mirror hostname";
    default:
      return null;
  }
}

const operation = {
  requestedTarget: target,
  target: null,
  mirrorKey: null,
  endpoint: null,
  phase: "initialization",
  index: null,
};

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

  Object.assign(operation, {
    target: name,
    mirrorKey,
    endpoint: endpointDetails(mirrorUrl),
    phase: "configuration",
    index: null,
  });

  if (!mirrorUrl || !primaryUrl) {
    throw new Error(`${mirrorKey} and ${primaryKey} must both be configured`);
  }
  if (endpointIdentity(mirrorUrl) === endpointIdentity(primaryUrl)) {
    throw new Error(`${mirrorKey} resolves to the protected ${primaryKey} endpoint`);
  }

  const client = new Client({
    connectionString: mirrorConnectionString(mirrorUrl),
    application_name: `pokewin-admin-mirror-indexes-${name}`,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 0,
  });
  const summary = { target: name, created: [], skipped: [], dropped: [] };

  try {
    operation.phase = "connect";
    await client.connect();
    operation.phase = "enable-ddl-session";
    await client.query("SET default_transaction_read_only = off");
    operation.phase = "preflight";
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

    operation.phase = "acquire-advisory-lock";
    await client.query(
      "SELECT pg_advisory_lock(hashtext('pokewin-admin-main-mirror-indexes-v1'))",
    );
    try {
      for (const statement of statements) {
        const name = indexName(statement);
        const isDrop = /^DROP/i.test(statement);

        operation.index = name;
        operation.phase = "inspect-index";
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
            operation.phase = "drop-invalid-index";
            await client.query(`DROP INDEX CONCURRENTLY IF EXISTS "${name}"`);
            summary.dropped.push(name);
          }
        }

        operation.phase = isDrop ? "drop-index" : "create-index";
        await client.query(statement);
        (isDrop ? summary.dropped : summary.created).push(name);
      }
    } finally {
      try {
        await client.query(
          "SELECT pg_advisory_unlock(hashtext('pokewin-admin-main-mirror-indexes-v1'))",
        );
      } catch (error) {
        operation.phase = "release-advisory-lock";
        throw error;
      }
    }
  } finally {
    await client.end().catch(() => undefined);
  }

  operation.phase = "complete";
  operation.index = null;
  return summary;
}

loadLocalEnv();
const targets = target === "all" ? ["dev", "prod"] : [target];
const results = [];
try {
  for (const name of targets) results.push(await applyTarget(name));
  console.log(JSON.stringify(results, null, 2));
} catch (error) {
  const code = errorField(error, "code") ?? "MIRROR_INDEX_APPLY_FAILED";
  console.error(
    JSON.stringify({
      target: operation.target ?? target,
      requestedTarget: operation.requestedTarget,
      status: "failed",
      mirrorKey: operation.mirrorKey,
      endpoint: operation.endpoint,
      phase: operation.phase,
      index: operation.index,
      code,
      message: redactedErrorMessage(error),
      hint: errorHint(code),
      socket: {
        errno: errorField(error, "errno"),
        syscall: errorField(error, "syscall"),
        address: errorField(error, "address"),
        port: errorField(error, "port"),
      },
      postgres: {
        severity: errorField(error, "severity"),
        routine: errorField(error, "routine"),
        constraint: errorField(error, "constraint"),
      },
    }),
  );
  process.exitCode = 1;
}
