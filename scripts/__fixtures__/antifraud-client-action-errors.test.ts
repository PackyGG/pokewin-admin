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

test("staff-triggered Fraud mutations return typed results", () => {
  const actionFiles = [
    "banned-users/actions.ts",
    "risky-locations/actions.ts",
    "email-blacklist/actions.ts",
    "flows/actions.ts",
    "settings/actions.ts",
    "settings/signup-failure-actions.ts",
    "_components/identifier-blocklist-actions.ts",
    "reviews/actions.ts",
  ];
  for (const relative of actionFiles) {
    const source = readFileSync(path.join(antifraudRoot, relative), "utf8");
    assert.match(
      source,
      /Promise<ServerActionResult/,
      `${relative} must return typed client-action failures`,
    );
  }

  const clients = sourceFiles(antifraudRoot)
    .map((file) => readFileSync(file, "utf8"))
    .filter((source) => source.startsWith('"use client"'))
    .join("\n");
  assert.match(clients, /if \(!result\.success\)/);
});

test("unexpected Fraud mutation failures enter the Discord error queue", () => {
  const source = readFileSync(
    path.resolve("src/lib/antifraud/action-error-message.ts"),
    "utf8",
  );
  assert.match(source, /isExpectedAntifraudActionError/);
  assert.match(source, /enqueueDiscordEvent\(\{/);
  assert.match(source, /eventKey: "antifraud\.error\.webapp"/);
  assert.match(source, /dedupeKey: `server-action:/);
  assert.match(source, /Raw messages, inputs, and stack traces were excluded/);
});
