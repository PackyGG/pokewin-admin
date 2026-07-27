import assert from "node:assert/strict";
import test from "node:test";

import { sourceConnectionString, sourceSslFor } from "../src/db.js";

test("source database TLS is disabled only when explicitly configured", () => {
  assert.equal(sourceSslFor("disable"), false);
});

test("source database require keeps transport encrypted without a private CA", () => {
  assert.deepEqual(sourceSslFor("require"), {
    rejectUnauthorized: false,
  });
});

test("source database verifies a configured private CA", () => {
  assert.deepEqual(sourceSslFor("require", "line-one\\nline-two"), {
    rejectUnauthorized: true,
    ca: "line-one\nline-two",
  });
});

test("source connection strings cannot override the configured TLS policy", () => {
  const base = "postgresql://user:password@example.com:5432/main";

  const disabled = new URL(sourceConnectionString(`${base}?sslmode=require`, "disable"));
  assert.equal(disabled.searchParams.get("sslmode"), "disable");
  assert.equal(disabled.searchParams.has("uselibpqcompat"), false);

  const encrypted = new URL(sourceConnectionString(base, "require"));
  assert.equal(encrypted.searchParams.get("sslmode"), "require");
  assert.equal(encrypted.searchParams.get("uselibpqcompat"), "true");

  const verified = new URL(sourceConnectionString(base, "require", "private-ca"));
  assert.equal(verified.searchParams.get("sslmode"), "verify-full");
  assert.equal(verified.searchParams.has("uselibpqcompat"), false);
});

test("source connection string errors never expose credentials", () => {
  assert.throws(
    () => sourceConnectionString("not-a-database-url-with-secret", "require"),
    { message: "SOURCE_DATABASE_URL is invalid" },
  );
});
