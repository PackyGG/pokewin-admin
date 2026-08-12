import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * Root guardrails run on Vercel with ONLY the root package's dependencies
 * installed. `services/antifraud-monitor` is a separate package with its own
 * lockfile and its own node_modules, so a root fixture that RUNTIME-imports
 * monitor source drags in dependencies that do not exist in the root install.
 *
 * That passes locally — anyone who has run `npm --prefix services/antifraud-monitor`
 * has those modules on disk — and then fails the production build with
 * `Cannot find module`, which is exactly how it reached main once.
 *
 * Reading monitor source with readFileSync is fine and is the established
 * pattern; only a runtime import is forbidden. Behavioural tests of monitor
 * code belong in services/antifraud-monitor/test/, where its deps resolve.
 */
test("root guardrails never runtime-import antifraud-monitor source", () => {
  const dir = path.resolve(
    path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
  );
  const offenders: string[] = [];

  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".test.ts")) continue;
    const source = readFileSync(path.join(dir, entry), "utf8");
    for (const m of source.matchAll(
      /^\s*import\s+(?!type\b)[^;]*?from\s+["'][^"']*services\/antifraud-monitor\/[^"']*["']/gm,
    )) {
      offenders.push(`${entry}: ${m[0].trim().slice(0, 100)}`);
    }
    for (const m of source.matchAll(
      /\bawait\s+import\(\s*["'][^"']*services\/antifraud-monitor\/[^"']*["']/g,
    )) {
      offenders.push(`${entry}: ${m[0].trim().slice(0, 100)}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "these root fixtures runtime-import monitor source, which breaks the " +
      "Vercel build where only root dependencies are installed — read the " +
      "source with readFileSync, or move the test into " +
      "services/antifraud-monitor/test/",
  );
});
