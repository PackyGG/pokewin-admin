import assert from "node:assert/strict";
import test from "node:test";

import {
  isOauthSignupProvider,
  signupAuthProvider,
} from "../src/types.js";

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
