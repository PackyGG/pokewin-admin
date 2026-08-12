import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { clientActionError } from "../../src/lib/errors/client-action-error";

const antifraudRoot = path.resolve("src/app/(antifraud)/antifraud");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    return /\.tsx?$/.test(entry.name) ? [target] : [];
  });
}

test("Fraud client actions never show opaque Server Action digests", () => {
  assert.equal(
    clientActionError(
      new Error("An error occurred in the Server Components render"),
      "The action failed.",
    ),
    "The action failed.",
  );
  assert.equal(
    clientActionError(new Error("Invalid 2FA code"), "The action failed."),
    "Invalid 2FA code",
  );

  for (const file of sourceFiles(antifraudRoot)) {
    const source = readFileSync(file, "utf8");
    if (!source.startsWith('"use client"')) continue;
    assert.doesNotMatch(
      source,
      /\b(?:error|err)\.message\b/,
      `${path.relative(antifraudRoot, file)} must use clientActionError`,
    );
  }
});
