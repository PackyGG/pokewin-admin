import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { repositoryFiles } from "./repository-files";

test("repository file discovery falls back to a source-upload filesystem", (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "repository-files-"));
  context.after(() => rmSync(root, { force: true, recursive: true }));

  for (const file of [
    ".git/config",
    ".next/server/app.js",
    ".vercel/project.json",
    "node_modules/package/index.js",
    "src/app/page.tsx",
    "src/app/admin/layout.tsx",
    "src/app/admin/page.tsx",
    "src/lib/db.ts",
    "src/lib/queries/dashboard.ts",
    "src/lib/queries/insights/overview.ts",
    "vercel.json",
  ]) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), "fixture");
  }
  rmSync(path.join(root, ".git"), { recursive: true });

  assert.deepEqual(
    repositoryFiles({
      root,
      pathspecs: ["src/app/**/page.tsx", "src/app/**/layout.tsx"],
    }),
    ["src/app/admin/layout.tsx", "src/app/admin/page.tsx"],
  );
  assert.deepEqual(
    repositoryFiles({ root, pathspecs: ["src/lib/queries/**/*.ts"] }),
    ["src/lib/queries/insights/overview.ts"],
  );
  assert.deepEqual(repositoryFiles({ root }), [
    "src/app/admin/layout.tsx",
    "src/app/admin/page.tsx",
    "src/app/page.tsx",
    "src/lib/db.ts",
    "src/lib/queries/dashboard.ts",
    "src/lib/queries/insights/overview.ts",
    "vercel.json",
  ]);
});
