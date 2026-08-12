import assert from "node:assert/strict";
import test from "node:test";

import {
  discordAccountCreatedAt,
  isOauthSignupProvider,
  signupAuthProvider,
} from "../src/types.js";

function discordSnowflake(createdAt: Date): string {
  return (
    (BigInt(createdAt.getTime()) - 1_420_070_400_000n) << 22n
  ).toString();
}

test("Discord snowflakes expose account creation without an API call", () => {
  const createdAt = new Date("2026-07-01T12:34:56.789Z");
  assert.equal(
    discordAccountCreatedAt(discordSnowflake(createdAt))?.toISOString(),
    createdAt.toISOString(),
  );
  assert.equal(discordAccountCreatedAt("invalid"), null);
  assert.equal(discordAccountCreatedAt(null), null);
});

test("signup auth providers distinguish credential and supported OAuth identities", () => {
  assert.equal(signupAuthProvider("credential"), "credential");
  assert.equal(signupAuthProvider("credentials"), "credential");
  assert.equal(signupAuthProvider("email"), "credential");
  assert.equal(signupAuthProvider("google"), "google");
  assert.equal(signupAuthProvider("discord"), "discord");
  assert.equal(signupAuthProvider("steam"), "steam");
  assert.equal(signupAuthProvider("future-oauth"), "other");
  assert.equal(signupAuthProvider(null), "unknown");

  assert.equal(isOauthSignupProvider("credential"), false);
  assert.equal(isOauthSignupProvider("google"), true);
  assert.equal(isOauthSignupProvider("discord"), true);
  assert.equal(isOauthSignupProvider("steam"), true);
  assert.equal(isOauthSignupProvider("future-oauth"), true);
  assert.equal(isOauthSignupProvider(null), false);
});
