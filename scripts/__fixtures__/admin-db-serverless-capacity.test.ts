import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("serverless Admin pools retain only one database session per instance", () => {
  const source = readFileSync("src/lib/admin-db.ts", "utf8");
  assert.match(source, /max: process\.env\.VERCEL \? 1 : 5/);
  assert.match(source, /ADMIN_DATABASE_URL_POOLED/);
});
