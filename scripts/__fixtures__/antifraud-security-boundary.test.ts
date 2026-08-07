import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const auditSource = readFileSync(
  "src/lib/antifraud/security-audit.ts",
  "utf8",
);
const middlewareSource = readFileSync("src/middleware.ts", "utf8");
const migration = readFileSync(
  "drizzle/admin/migrations/20260730_antifraud_security_audit.sql",
  "utf8",
);
const auditIndexMigration = readFileSync(
  "drizzle/admin/migrations/20260807_audit_query_indexes.sql",
  "utf8",
);
const accessSource = readFileSync("src/lib/antifraud/access.ts", "utf8");
const gateSource = readFileSync("src/lib/require-antifraud-access.ts", "utf8");
const stepUpSource = readFileSync("src/lib/require-2fa.ts", "utf8");

test("rate-limit denial is thrown only after its audit transaction commits", () => {
  const transaction = auditSource.indexOf(
    "const rateLimited = await adminDrizzle.transaction",
  );
  const transactionEnd = auditSource.indexOf(
    "if (rateLimited)",
    transaction,
  );
  assert.ok(transaction >= 0);
  assert.ok(transactionEnd > transaction);
  const transactionBody = auditSource.slice(transaction, transactionEnd);
  assert.match(transactionBody, /return limited/);
  assert.doesNotMatch(transactionBody, /throw new Error/);
});

test("middleware replaces untrusted antifraud audit context", () => {
  for (const header of [
    "x-antifraud-path",
    "x-antifraud-method",
    "x-antifraud-search-keys",
  ]) {
    assert.match(
      middlewareSource,
      new RegExp(`forwardedHeaders\\.delete\\("${header}"\\)`),
    );
  }
  assert.match(
    middlewareSource,
    /forwardedHeaders\.set\("x-antifraud-path", pathname/,
  );
  assert.match(
    middlewareSource,
    /forwardedHeaders\.set\("x-antifraud-method", request\.method/,
  );
});

test("security audit tables reject update, delete, and truncate", () => {
  assert.match(migration, /BEFORE UPDATE OR DELETE/);
  assert.match(migration, /BEFORE TRUNCATE/);
  assert.match(migration, /append-only/);
});

test("security audit pagination follows its keyset index", () => {
  assert.match(
    auditSource,
    /ORDER BY created_at DESC, id DESC[\s\S]*LIMIT \$\{limit \+ 1\}/,
  );
  assert.match(
    auditIndexMigration,
    /antifraud_security_audit_events \(created_at DESC, id DESC\)/,
  );
});

test("dashboard authorization is role based and never uses Discord ids", () => {
  assert.match(accessSource, /getEffectiveRoles/);
  assert.match(gateSource, /isAntifraudAllowed/);
  assert.doesNotMatch(accessSource, /discord/i);
  assert.doesNotMatch(gateSource, /discord/i);
});

test("step-up replay storage failures fail closed", () => {
  assert.doesNotMatch(stepUpSource, /failed \(allowing\)/);
  assert.match(
    stepUpSource,
    /Verification replay protection is unavailable\. Try again later\./,
  );
});

test("new KYC requirements lock deposits, withdrawals and tips themselves, behind owner/admin + fresh 2FA", () => {
  const kycActions = readFileSync(
    "src/app/(antifraud)/antifraud/kyc/actions.ts",
    "utf8",
  );
  const fiatActions = readFileSync(
    "src/app/(antifraud)/antifraud/fiat-deposits/actions.ts",
    "utf8",
  );

  assert.match(kycActions, /requireAntifraudManager\(/);
  assert.match(kycActions, /require2FA\(/);
  assert.match(kycActions, /lockFiatAndWithdrawals\(/);
  assert.match(kycActions, /updateUserRewardLocks\(/);
  assert.doesNotMatch(fiatActions, /requireUserKyc|backend-api\/kyc/);
});

test("historical blacklist matches open review without automatic containment", () => {
  const monitor = readFileSync(
    "services/antifraud-monitor/src/fiat-email-domains.ts",
    "utf8",
  );
  const routes = readFileSync(
    "services/antifraud-monitor/src/fiat-email-domain-routes.ts",
    "utf8",
  );
  const ingest = readFileSync(
    "src/app/api/antifraud/ingest/route.ts",
    "utf8",
  );

  assert.doesNotMatch(routes, /expires_at, backfill_completed_at/);
  assert.match(monitor, /\{ reviewOnly: true \}/);
  assert.match(
    monitor,
    /CASE WHEN \$12::boolean THEN now\(\) ELSE NULL END/,
  );
  assert.match(ingest, /signal\.payload\?\.reviewOnly !== true/);
});

/** Index of the `{` that opens a function body, starting at its name. */
function functionBodyStart(source: string, fromIndex: number): number {
  let index = source.indexOf("(", fromIndex);
  let parens = 0;
  for (; index < source.length; index++) {
    const char = source[index];
    if (char === "(") parens++;
    else if (char === ")") {
      parens--;
      if (parens === 0) {
        index++;
        break;
      }
    }
  }
  // Skip the return-type annotation. Braces inside a generic (e.g.
  // `Promise<{ ok: true }>`) are type braces, not the body.
  let angles = 0;
  let typeBraces = 0;
  for (; index < source.length; index++) {
    const char = source[index];
    if (char === "<") angles++;
    else if (char === ">") {
      if (source[index - 1] === "=") continue;
      angles = Math.max(0, angles - 1);
    } else if (char === "{") {
      if (angles > 0 || typeBraces > 0) typeBraces++;
      else return index;
    } else if (char === "}") typeBraces = Math.max(0, typeBraces - 1);
  }
  return -1;
}

function matchingBrace(source: string, open: number): number {
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === "{") depth++;
    else if (source[index] === "}") {
      depth--;
      if (depth === 0) return index;
    }
  }
  return source.length;
}

const MODULE_USE_SERVER =
  /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*(["'])use server\1/;

test("every antifraud Server Action has a live gate before its first await", () => {
  const root = "src/app/(antifraud)/antifraud";
  const GATE = /^requireAntifraud(?:Access|Manager)\(/;

  // Read every .ts/.tsx, not just `*actions.ts`. A `"use server"` block is
  // what turns code into a Server Action, and it can sit in a `.tsx` (or in
  // a renamed `*-action.tsx`) where a filename-only walk never sees it.
  const sourceFiles: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (
        /\.tsx?$/.test(entry.name) ||
        /actions\.ts$/.test(entry.name) ||
        /-action\.tsx$/.test(entry.name)
      ) {
        sourceFiles.push(path);
      }
    }
  };
  walk(root);

  const serverModules: string[] = [];
  // { file, label, bodyOpen } for every function that Next will expose.
  const targets: { file: string; label: string; body: string }[] = [];

  for (const file of sourceFiles) {
    const source = readFileSync(file, "utf8");
    if (MODULE_USE_SERVER.test(source)) {
      serverModules.push(file);
      // Module-level directive: every export is a Server Action.
      const exported = /export\s+async\s+function\s+([A-Za-z0-9_$]+)/g;
      let match: RegExpExecArray | null;
      while ((match = exported.exec(source))) {
        const open = functionBodyStart(source, match.index);
        assert.ok(open > 0, `${file}: cannot locate body of ${match[1]}`);
        targets.push({
          file,
          label: match[1],
          body: source.slice(open, matchingBrace(source, open) + 1),
        });
      }
      continue;
    }
    // Inline `"use server"` inside a component/handler file. The directive is
    // the first statement of the body, so the previous non-space char is `{`.
    const inline = /(["'])use server\1/g;
    let directive: RegExpExecArray | null;
    while ((directive = inline.exec(source))) {
      let back = directive.index - 1;
      while (back >= 0 && /\s/.test(source[back])) back--;
      if (source[back] !== "{") continue;
      targets.push({
        file,
        label: `inline "use server" @${directive.index}`,
        body: source.slice(back, matchingBrace(source, back) + 1),
      });
    }
  }

  assert.ok(
    serverModules.length >= 12,
    `expected the antifraud Server Action modules to be found, got ${serverModules.length}`,
  );
  assert.ok(targets.length >= 30, `only found ${targets.length} actions`);

  for (const target of targets) {
    const where = `${target.file} :: ${target.label}`;
    assert.match(
      target.body,
      /requireAntifraud(?:Access|Manager)\(/,
      `${where} must enforce the live Antifraud gate`,
    );
    // Per action, not per file: the gate has to be the FIRST thing awaited,
    // so no read, mutation, or backend call can run ahead of authorization.
    const firstAwait = target.body.search(/\bawait\s/);
    if (firstAwait < 0) continue;
    const awaited = target.body.slice(firstAwait).replace(/^await\s+/, "");
    assert.ok(
      GATE.test(awaited),
      `${where} awaits ${JSON.stringify(
        awaited.slice(0, 60),
      )} before the Antifraud gate`,
    );
  }
});
