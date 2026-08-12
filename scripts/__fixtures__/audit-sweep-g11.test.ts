import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

const REVIEWS = "src/app/(antifraud)/antifraud/reviews/actions.ts";
const SECURITY_AUDIT = "src/lib/antifraud/security-audit.ts";
const OUTBOX = "services/antifraud-monitor/src/outbox.ts";

test("the quick review ban never overwrites an existing ban", () => {
  const text = source(REVIEWS);
  const ban = text.slice(
    text.indexOf("SET is_banned = TRUE"),
    text.indexOf("DELETE FROM session"),
  );
  assert.ok(ban.length > 0, "quick review ban UPDATE not found");
  // Without the guard the UPDATE rewrote banned_reason/banned_at/banned_by of
  // a ban placed by /users, KYC or automatic containment.
  assert.match(ban, /AND is_banned = FALSE/);
  // An already-banned account must still reach the flagged verdict, so the
  // zero-row branch has to distinguish "gone" from "already banned" rather
  // than throwing for both.
  assert.match(text, /already_banned: previousBan !== null/);
  assert.match(text, /previous_banned_reason/);
});

test("the withdrawal-lock trail note cannot fail the containment action", () => {
  const text = source(REVIEWS);
  const note = text.slice(text.indexOf("Locked crypto and item withdrawals"));
  assert.match(note.slice(0, 400), /withdrawal-lock note failed/);
  // The three audit events stay mandatory; only the cosmetic note left the
  // Promise.all, so a rejected note no longer rejects the whole batch.
  const lockStart = text.indexOf("const lockMetadata");
  const promiseAll = text.slice(lockStart, text.indexOf("]);", lockStart));
  assert.ok(promiseAll.includes("antifraud_withdrawals_locked"));
  assert.doesNotMatch(promiseAll, /antifraud_review_notes/);
});

test("audit metadata hashing distinguishes structured values", () => {
  const text = source(SECURITY_AUDIT);
  // `String(nested)` collapsed every object under a PII key to the HMAC of
  // "[object Object]" — one constant standing in for every distinct value.
  assert.doesNotMatch(text, /hashSensitive\(String\(nested\)\)/);
  assert.match(text, /hashSensitive\(sensitiveText\(nested\)\)/);
  for (const family of ["visitor", "fingerprint", "device", "passport", "ssn"]) {
    assert.ok(
      text.includes(`|${family}`),
      `PII_KEY_PATTERN lost the ${family} identifier family`,
    );
  }
});

test("a throwing outbox delivery is reported, not silently retried forever", () => {
  const text = source(OUTBOX);
  const drain = text.slice(text.indexOf("result = await config.attempt(row)"));
  // Binding the error is the whole point: an unbound `catch {}` made a
  // permanent failure indistinguishable from a transient blip.
  assert.match(drain.slice(0, 600), /catch \(error\)/);
  assert.match(drain.slice(0, 600), /\[outbox\] delivery attempt threw/);
  // Control flow must be unchanged: the throw is still a failed delivery.
  assert.match(drain.slice(0, 700), /result = \{ delivered: false \};/);
});
