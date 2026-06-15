import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

/**
 * CQRS import-boundary guard for the ClickHouse read layer.
 *
 * The ClickHouse read path must never pull a Postgres / Prisma DB CLIENT into
 * its module graph — neither DIRECTLY (a string import in a `src/lib/clickhouse`
 * file) NOR TRANSITIVELY (reached through any chain of value imports). The
 * canonical example this test was strengthened to catch: the old
 * `window-metrics.ts -> @/lib/queries/ggr -> getDb` chain, where the CH twin
 * value-imported a pure date helper out of the `server-only` `@/lib/queries/ggr`
 * module, which itself imports `getDb` from `@/lib/db`. The plain regex sweep
 * (still asserted below) only inspects DIRECT imports, so that chain slipped
 * through. The transitive graph walk closes the gap.
 *
 * Three properties are asserted:
 *   1. DIRECT — no `src/lib/clickhouse/**` file imports a forbidden module.
 *   2. TRANSITIVE — walking the value-import graph from every CH module reaches
 *      no forbidden module.
 *   3. NEGATIVE CONTROL — re-introducing the `-> @/lib/queries/ggr -> getDb`
 *      chain (against the REAL `ggr.ts`, which really value-imports `getDb`)
 *      DOES trip the walk, proving the guard has teeth; the post-extraction
 *      form (importing the client-safe `@/lib/metrics/ggr-window`) stays clean.
 *
 * Plus the two structural read-only invariants that keep ClickHouse writable
 * never: the client's `readonly:"2"` session setting, and the single-`query()`
 * export shape of `clickhouseRead` (no `insert`/`command`/`exec`).
 */

const ROOT = process.cwd();
const SRC = join(ROOT, "src");
const CH_DIR = join(SRC, "lib", "clickhouse");

// ── Forbidden modules: the Postgres / Prisma DB clients ───────────────────────
// Reaching any of these (directly or transitively) breaks CQRS isolation: the
// CH analytics path would then be able to open a Postgres/Prisma connection.
const FORBIDDEN: { match: (spec: string) => boolean; label: string }[] = [
  { match: (s) => s === "@/lib/db", label: "@/lib/db (Postgres game client)" },
  { match: (s) => s === "@/lib/admin-db", label: "@/lib/admin-db (Postgres admin client)" },
  { match: (s) => s === "pg" || s.startsWith("pg/"), label: "pg" },
  { match: (s) => s.startsWith("@prisma/"), label: "@prisma/*" },
  {
    match: (s) => /^@\/generated\/(admin-)?prisma(\b|\/)/.test(s),
    label: "generated Prisma client (@/generated/prisma*)",
  },
];

function forbiddenLabel(spec: string): string | null {
  for (const f of FORBIDDEN) if (f.match(spec)) return f.label;
  return null;
}

// ── Sanctioned control-plane boundary helper ──────────────────────────────────
// The comparison ORCHESTRATOR (comparison.ts) is allowed to fetch ONE piece of
// control data — the excluded-users blacklist — and pass it as plain data
// (string[]) into the PURE ClickHouse reads. The read modules under
// `queries/**` never reach Postgres themselves; only an opaque id list crosses
// the boundary, never a Postgres query result or client. This single helper is
// treated as a graph LEAF (the walk does not descend into its admin-DB read),
// matching the long-documented design ("reusing a tiny higher-level control
// helper for the blacklist is allowed by design — pure analytics never reads
// Postgres") and the architecture's comparison pattern.
const SANCTIONED_LEAVES = new Set<string>(["@/lib/excluded-users/fetch"]);

type ParsedImport = { spec: string; typeOnly: boolean };

/** Strip block + line comments so a commented-out import is never matched. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

/**
 * Is this import clause type-only (erased at compile time, so it never pulls
 * the target into the runtime graph)? Handles `import type {…}`,
 * `export type {…}`, and the per-specifier `import { type A, type B }` form
 * (only type-only when EVERY named specifier is a `type` specifier and there is
 * no default/namespace import).
 */
function isTypeOnlyClause(clause: string): boolean {
  const c = clause.trim();
  if (c === "type" || c.startsWith("type ") || c.startsWith("type{")) return true;
  const open = c.indexOf("{");
  if (open === -1) return false; // default or `* as X` import → value
  const close = c.lastIndexOf("}");
  if (close <= open) return false;
  const beforeBrace = c.slice(0, open).replace(/,\s*$/, "").trim();
  if (beforeBrace.length > 0) return false; // `Default, { … }` → value
  const named = c
    .slice(open + 1, close)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (named.length === 0) return false;
  return named.every((n) => n === "type" || n.startsWith("type "));
}

/** Parse the module specifiers a source file imports (value + type-only). */
function parseImports(src: string): ParsedImport[] {
  const text = stripComments(src);
  const out: ParsedImport[] = [];

  // `import …/export … from "spec"` — clause excludes ; and quotes so it can
  // never run across a statement boundary.
  const fromRe = /\b(?:import|export)\s+([^;'"]*?)\s*from\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(text)) !== null) {
    out.push({ spec: m[2], typeOnly: isTypeOnlyClause(m[1]) });
  }

  // Side-effect imports: `import "spec";`
  const sideRe = /\bimport\s*["']([^"']+)["']/g;
  while ((m = sideRe.exec(text)) !== null) {
    out.push({ spec: m[1], typeOnly: false });
  }

  return out;
}

/** Resolve a local (`@/` or relative) specifier to an on-disk module id. */
function resolveLocal(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else return null; // bare npm specifier — not part of our source graph

  const candidates = [
    base + ".ts",
    base + ".tsx",
    base + ".js",
    join(base, "index.ts"),
    join(base, "index.tsx"),
    join(base, "index.js"),
  ];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

const importCache = new Map<string, ParsedImport[]>();
function getImportsReal(file: string): ParsedImport[] {
  const cached = importCache.get(file);
  if (cached) return cached;
  let parsed: ParsedImport[] = [];
  try {
    parsed = parseImports(readFileSync(file, "utf8"));
  } catch {
    parsed = [];
  }
  importCache.set(file, parsed);
  return parsed;
}

function rel(id: string): string {
  return id.startsWith(ROOT) ? id.slice(ROOT.length + 1).replace(/\\/g, "/") : id;
}

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTsFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

type Violation = { label: string; chain: string[] };

/**
 * Walk the value-import graph from `entries`, following every non-type-only
 * import, and collect any path that reaches a FORBIDDEN module. `getImports`
 * and `resolveId` are injected so the negative control can seed a synthetic
 * entry while still walking the REAL source graph.
 */
function findForbiddenReach(
  entries: string[],
  getImports: (id: string) => ParsedImport[],
  resolveId: (spec: string, fromId: string) => string | null,
): Violation[] {
  const violations: Violation[] = [];
  const visited = new Set<string>();
  const stack: { id: string; chain: string[] }[] = entries.map((id) => ({ id, chain: [] }));

  while (stack.length > 0) {
    const { id, chain } = stack.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const here = [...chain, rel(id)];

    for (const { spec, typeOnly } of getImports(id)) {
      if (typeOnly) continue;
      const label = forbiddenLabel(spec);
      if (label) {
        violations.push({ label, chain: [...here, spec] });
        continue;
      }
      if (SANCTIONED_LEAVES.has(spec)) continue;
      const next = resolveId(spec, id);
      if (next && !visited.has(next)) stack.push({ id: next, chain: here });
    }
  }

  return violations;
}

function formatViolations(violations: Violation[]): string {
  return violations.map((v) => `  ${v.label} via ${v.chain.join(" -> ")}`).join("\n");
}

test("clickhouse read layer never DIRECTLY imports a Postgres/Prisma client", () => {
  const files = collectTsFiles(CH_DIR);
  assert.ok(files.length > 0, "expected ClickHouse modules in src/lib/clickhouse");
  for (const file of files) {
    for (const { spec } of getImportsReal(file)) {
      const label = forbiddenLabel(spec);
      assert.ok(!label, `${rel(file)} must not import ${label} (got "${spec}")`);
    }
  }
});

test("clickhouse read layer reaches no Postgres/Prisma client (TRANSITIVE walk)", () => {
  const files = collectTsFiles(CH_DIR);
  assert.ok(files.length > 0, "expected ClickHouse modules in src/lib/clickhouse");
  const violations = findForbiddenReach(files, getImportsReal, resolveLocal);
  assert.equal(
    violations.length,
    0,
    `transitive CQRS boundary violation(s) — the CH read graph reaches a Postgres/Prisma client:\n${formatViolations(
      violations,
    )}`,
  );
});

test("negative control: reintroducing window-metrics -> @/lib/queries/ggr -> getDb FAILS the walk", () => {
  // A synthetic CH read module that re-introduces the OLD coupling: importing
  // the server-only @/lib/queries/ggr (which value-imports getDb from
  // @/lib/db). Resolved against the REAL ggr.ts, so this proves the walk
  // catches the exact chain the m1 helper-extraction removed.
  const SYNTHETIC = join(CH_DIR, "queries", "__negative_control_window_metrics__.ts");

  const couplingViolations = findForbiddenReach(
    [SYNTHETIC],
    (id) =>
      id === SYNTHETIC
        ? [{ spec: "@/lib/queries/ggr", typeOnly: false }]
        : getImportsReal(id),
    resolveLocal,
  );
  const couplingReport = formatViolations(couplingViolations);
  assert.ok(
    couplingViolations.length > 0,
    "expected the reintroduced ggr coupling to trip the boundary walk, but it reported nothing",
  );
  assert.ok(
    /ggr/.test(couplingReport) && /@\/lib\/db/.test(couplingReport),
    `expected the reintroduced chain to reach @/lib/db via ggr, got:\n${couplingReport}`,
  );

  // And the post-extraction form (the client-safe pure helper) stays clean —
  // documenting that the helper extraction is what removed the coupling.
  const cleanViolations = findForbiddenReach(
    [SYNTHETIC],
    (id) =>
      id === SYNTHETIC
        ? [{ spec: "@/lib/metrics/ggr-window", typeOnly: false }]
        : getImportsReal(id),
    resolveLocal,
  );
  assert.equal(
    cleanViolations.length,
    0,
    `importing the client-safe @/lib/metrics/ggr-window must NOT trip the boundary, got:\n${formatViolations(
      cleanViolations,
    )}`,
  );
});

test("ClickHouse client stays read-only (readonly:\"2\", no writable override)", () => {
  const clientSrc = readFileSync(join(CH_DIR, "client.ts"), "utf8");
  assert.match(
    clientSrc,
    /readonly:\s*["']2["']/,
    'client.ts must set clickhouse_settings.readonly to "2"',
  );
  // No file in the CH layer may downgrade readonly to a writable value (0/1).
  for (const file of collectTsFiles(CH_DIR)) {
    const src = stripComments(readFileSync(file, "utf8"));
    assert.ok(
      !/readonly\s*:\s*["']?[01]["']?/.test(src),
      `${rel(file)} must not downgrade clickhouse_settings.readonly to a writable value`,
    );
  }
});

test("clickhouseRead exposes only query() — no insert/command/exec", () => {
  const readonlySrc = readFileSync(join(CH_DIR, "readonly-query.ts"), "utf8");
  assert.match(
    readonlySrc,
    /clickhouseRead\s*=\s*\{\s*query\s*\}/,
    "clickhouseRead must export only { query }",
  );
  // No CH module may bypass the guard via a write-capable client method.
  for (const file of collectTsFiles(CH_DIR)) {
    const src = readFileSync(file, "utf8");
    for (const method of [".insert(", ".command(", ".exec("]) {
      assert.ok(
        !src.includes(method),
        `${rel(file)} must not call ${method} on the ClickHouse client`,
      );
    }
  }
});
