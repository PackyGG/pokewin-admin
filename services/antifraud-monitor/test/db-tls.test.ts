import assert from "node:assert/strict";
import test from "node:test";

import { sourceSslFor } from "../src/db.js";

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
