import assert from "node:assert/strict";
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
  assert.match(output, /too many connections for role/);
  assert.match(output, /code=53300/);
  assert.doesNotMatch(output, /SELECT private_email|secret-user-id|params:/);
});
