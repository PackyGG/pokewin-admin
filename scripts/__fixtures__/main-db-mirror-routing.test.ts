import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const repoRoot = process.cwd();
const readResolvers = new Set([
  "getReadDrizzleDb",
  "getProdReadDrizzleDb",
  "getDevReadDrizzleDb",
  "readDrizzleForEnv",
]);

function trackedRuntimeFiles(): string[] {
  return execFileSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "src/**/*.ts",
      "src/**/*.tsx",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  )
    .split(/\r?\n/)
    .filter((file) => file && fs.existsSync(path.join(repoRoot, file)));
}

test("mirror DB configuration fails closed and forces read-only sessions", () => {
  const source = fs.readFileSync(path.join(repoRoot, "src/lib/db.ts"), "utf8");
  assert.match(source, /MIRROR_PRODUCTION_DB/);
  assert.match(source, /MIRROR_DEV_DB/);
  assert.match(source, /default_transaction_read_only=on/);
  assert.match(source, /uselibpqcompat/);
  assert.match(source, /sslmode"\) === "require"/);
  assert.match(source, /getReadDrizzleDb/);
  assert.match(source, /getPrimaryDrizzleDb/);
  assert.doesNotMatch(source, /MIRROR_PRODUCTION_DB\s*\?\?\s*process\.env\.DATABASE_URL/);
  assert.doesNotMatch(source, /MIRROR_DEV_DB\s*\?\?\s*process\.env\.DEV_DATABASE_URL/);
});

test("PostgreSQL health fails closed when logical replication is stopped or stale", () => {
  const source = fs.readFileSync(
    path.join(repoRoot, "src/app/api/health/postgres/route.ts"),
    "utf8",
  );

  assert.match(source, /pg_subscription/);
  assert.match(source, /pg_stat_subscription/);
  assert.match(source, /pg_subscription_rel/);
  assert.match(source, /status\.relid IS NULL/);
  assert.match(source, /enabled_subscriptions > 0/);
  assert.match(
    source,
    /running_subscriptions ===\s*replication\.enabled_subscriptions/,
  );
  assert.match(source, /replication\.not_ready_tables === 0/);
  assert.match(source, /MAX_REPLICATION_MESSAGE_AGE_MS = 120_000/);
  assert.match(source, /replicationHealthy: false/);
  assert.match(source, /\{ status: 503 \}/);
  assert.doesNotMatch(source, /await db\.execute\(sql`SELECT 1`\)/);
});

test("serverless mirror pools preserve shared role connection headroom", () => {
  const source = fs.readFileSync(path.join(repoRoot, "src/lib/db.ts"), "utf8");
  const warmRoute = fs.readFileSync(
    path.join(repoRoot, "src/app/api/cron/warm/route.ts"),
    "utf8",
  );

  assert.match(source, /max:\s*isReadMirror\s*\?\s*2\s*:\s*3/);
  assert.match(source, /maxUses:\s*isReadMirror\s*\?\s*100\s*:\s*Infinity/);
  assert.doesNotMatch(source, /idle_session_timeout=/);
  assert.match(source, /work_mem=32MB/);
  assert.match(source, /random_page_cost=1\.1/);
  assert.match(
    source,
    /idleTimeoutMillis:\s*isReadMirror\s*\?\s*1_000\s*:\s*10_000/,
  );
  assert.match(source, /maxLifetimeSeconds:\s*600/);
  assert.match(warmRoute, /export const maxDuration = 60/);
  assert.match(warmRoute, /Array\.from\(\{ length: 2 \}/);
  assert.match(
    fs.readFileSync(path.join(repoRoot, "src/lib/drizzle-query.ts"), "utf8"),
    /withTransientPostgresReadRetry/,
  );
});

test("mirror session recovery release discards outage-era cache namespaces", () => {
  const deposits = fs.readFileSync(
    path.join(repoRoot, "src/lib/queries/transactions.ts"),
    "utf8",
  );
  const userDetail = fs.readFileSync(
    path.join(repoRoot, "src/lib/queries/users-detail-cache.ts"),
    "utf8",
  );

  assert.match(deposits, /transactions-deposits-list-v3/);
  assert.match(userDetail, /users-detail-aggregate-v4/);
  assert.match(userDetail, /users-detail-pnl-v7/);
  assert.doesNotMatch(userDetail, /function cachedUserGamingTransactions/);
  assert.match(userDetail, /users-detail-financial-tx-v3/);
});

test("mirror index failures expose safe, actionable connection diagnostics", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, "scripts/apply-main-mirror-indexes.mjs"), "prod"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        MIRROR_PRODUCTION_DB:
          "postgresql://diagnostic-user:super-secret-password@127.0.0.1:1/diagnostic-db?sslmode=disable",
        DATABASE_URL:
          "postgresql://protected-user:another-secret@127.0.0.1:2/protected-db?sslmode=disable",
      },
    },
  );

  assert.equal(result.status, 1);
  const diagnosticLine = result.stderr
    .split(/\r?\n/)
    .find((line) => line.trim().startsWith("{"));
  assert.ok(diagnosticLine, result.stderr);

  const diagnostic = JSON.parse(diagnosticLine) as {
    target: string;
    mirrorKey: string;
    endpoint: {
      host: string;
      port: number;
      database: string;
      sslMode: string;
      libpqCompat: boolean;
    };
    phase: string;
    index: string | null;
    code: string;
    hint: string;
    socket: { syscall?: string; address?: string; port?: number };
  };

  assert.equal(diagnostic.target, "prod");
  assert.equal(diagnostic.mirrorKey, "MIRROR_PRODUCTION_DB");
  assert.deepEqual(diagnostic.endpoint, {
    host: "127.0.0.1",
    port: 1,
    database: "diagnostic-db",
    sslMode: "disable",
    libpqCompat: false,
  });
  assert.equal(diagnostic.phase, "connect");
  assert.equal(diagnostic.index, null);
  assert.equal(diagnostic.code, "ECONNREFUSED");
  assert.match(diagnostic.hint, /no PostgreSQL listener/i);
  assert.equal(diagnostic.socket.syscall, "connect");
  assert.equal(diagnostic.socket.address, "127.0.0.1");
  assert.equal(diagnostic.socket.port, 1);
  assert.doesNotMatch(result.stderr, /super-secret-password|another-secret/);
  assert.doesNotMatch(result.stderr, /postgresql:\/\/diagnostic-user/);

  const runnerSource = fs.readFileSync(
    path.join(repoRoot, "scripts/apply-main-mirror-indexes.mjs"),
    "utf8",
  );
  assert.match(runnerSource, /UNABLE_TO_VERIFY_LEAF_SIGNATURE/);
  assert.match(runnerSource, /certificate chain trusted by Node\.js/);
});

test("mirror index tooling can scope production DDL to Antifraud", () => {
  const source = fs.readFileSync(
    path.join(repoRoot, "scripts/apply-main-mirror-indexes.mjs"),
    "utf8",
  );
  assert.match(source, /--antifraud-only/);
  assert.match(
    source,
    /scope === "--antifraud-only"\s*\?\s*sourceStatements/,
  );
});

test("query modules cannot request the writable MAIN client", () => {
  const files = execFileSync("git", ["ls-files", "src/lib/queries/**/*.ts"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .split(/\r?\n/)
    .filter(Boolean);

  for (const file of files) {
    const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
    assert.doesNotMatch(source, /getPrimaryDrizzleDb|primaryDrizzleForEnv/, file);
  }
});

test("read clients are not used for direct MAIN mutations", () => {
  const violations: string[] = [];

  for (const file of trackedRuntimeFiles()) {
    const absolutePath = path.join(repoRoot, file);
    const sourceText = fs.readFileSync(absolutePath, "utf8");
    if (![...readResolvers].some((name) => sourceText.includes(name))) continue;

    const sourceFile = ts.createSourceFile(
      file,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const readBindings = new Set<string>();

    function collect(node: ts.Node): void {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isCallExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression) &&
        readResolvers.has(node.initializer.expression.text)
      ) {
        readBindings.add(node.name.text);
      }
      ts.forEachChild(node, collect);
    }

    function inspect(node: ts.Node): void {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        readBindings.has(node.expression.expression.text)
      ) {
        const method = node.expression.name.text;
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        if (method === "insert" || method === "update" || method === "delete") {
          violations.push(`${file}:${line} uses ${node.expression.expression.text}.${method}`);
        }
        if (
          method === "execute" &&
          node.arguments.some((argument) =>
            /\b(insert|update|delete|alter|create|drop|truncate)\b/i.test(
              argument.getText(sourceFile),
            ),
          )
        ) {
          violations.push(`${file}:${line} executes a mutation through a read client`);
        }
      }
      ts.forEachChild(node, inspect);
    }

    collect(sourceFile);
    inspect(sourceFile);
  }

  assert.deepEqual(violations, []);
});
