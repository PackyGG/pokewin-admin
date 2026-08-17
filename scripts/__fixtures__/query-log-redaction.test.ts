import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { safeQuery } from "@/lib/errors/safe-query";

test("recoverable database logs redact SQL and bound parameters", async () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...parts: unknown[]) => {
    lines.push(parts.map(String).join(" "));
  };

  try {
    const cause = Object.assign(new Error("too many connections for role"), {
      code: "53300",
    });
    const error = Object.assign(
      new Error(
        "Failed query: SELECT private_email FROM user WHERE id = $1\nparams: secret-user-id",
      ),
      { cause },
    );

    const result = await safeQuery(
      async () => {
        throw error;
      },
      null,
      "test.redaction",
    );

    assert.equal(result.kind, "error");
  } finally {
    console.error = original;
  }

  const output = lines.join("\n");
  assert.match(
    output,
    /Database error \(SQLSTATE 53300: too many connections\)/,
  );
  assert.match(output, /code=53300/);
  assert.doesNotMatch(output, /SELECT private_email|secret-user-id|params:/);
});

test("non-Error throwable objects are never serialized into logs", async () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...parts: unknown[]) =>
    lines.push(parts.map(String).join(" "));

  try {
    await safeQuery(
      async () => {
        throw {
          query: "SELECT email FROM users WHERE id = $1",
          params: ["private-user-id"],
          token: "private-api-token",
        };
      },
      null,
      "test.object-redaction",
    );
  } finally {
    console.error = original;
  }

  const output = lines.join("\n");
  assert.match(output, /non-Error throwable redacted/);
  assert.doesNotMatch(output, /SELECT email|private-user-id|private-api-token/);
});

test("logger redacts identifiers from controlled context and message fields", async () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...parts: unknown[]) =>
    lines.push(parts.map(String).join(" "));

  try {
    const { logError } = await import("@/lib/errors/logger");
    logError(
      "users.123456789012345678",
      "ban transaction failed for 123456789012345678",
      new Error("lookup failed userId=123456789012345678"),
    );
  } finally {
    console.error = original;
  }

  const output = lines.join("\n");
  assert.match(output, /redacted-id/);
  assert.doesNotMatch(output, /123456789012345678/);
});

test("API and backend-cache catch paths use the safe logger", () => {
  const repoRoot = process.cwd();
  const sources = [
    "src/lib/api-auth/with-api-key.ts",
    "src/app/api/v1/discord/rewards/route.ts",
    "src/lib/refresh-site-config.ts",
    "src/lib/invalidate-country-restrictions-cache.ts",
    "src/lib/queries/_voucher-origins.ts",
    "src/lib/queries/_ledger-tx-types.ts",
  ].map((file) => fs.readFileSync(path.join(repoRoot, file), "utf8"));

  for (const source of sources) {
    assert.match(source, /log(?:Error|Warn)/);
    assert.doesNotMatch(source, /console\.(?:error|warn)/);
    assert.doesNotMatch(source, /JSON\.stringify\([^)]*payload/);
  }
});
