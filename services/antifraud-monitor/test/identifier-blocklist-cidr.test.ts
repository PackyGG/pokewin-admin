import assert from "node:assert/strict";
import test from "node:test";

import {
  MIN_IPV4_PREFIX_BITS,
  MIN_IPV6_PREFIX_BITS,
  validateIdentifierInput,
} from "../src/identifier-blocklists.js";

test("a near-zero CIDR is rejected before it can become a site-wide lock", () => {
  // `0.0.0.0/0` matched every signup. A `block` rule scores 100 points under hard policy, so
  // one accepted rule was a withdrawal lock plus staff review for the entire player base.
  for (const value of ["0.0.0.0/0", "10.0.0.0/1", "192.168.0.0/7"]) {
    assert.equal(
      validateIdentifierInput("ip", value, "cidr"),
      false,
      `${value} must be rejected`,
    );
  }
  for (const value of ["::/0", "2001:db8::/8", "2001:db8::/31"]) {
    assert.equal(
      validateIdentifierInput("ip", value, "cidr"),
      false,
      `${value} must be rejected`,
    );
  }
});

test("ranges an operator could plausibly mean still validate", () => {
  assert.equal(MIN_IPV4_PREFIX_BITS, 8);
  assert.equal(MIN_IPV6_PREFIX_BITS, 32);
  for (const value of ["10.0.0.0/8", "203.0.113.0/24", "203.0.113.7/32"]) {
    assert.equal(
      validateIdentifierInput("ip", value, "cidr"),
      true,
      `${value} must stay valid`,
    );
  }
  for (const value of ["2001:db8::/32", "2001:db8::/64", "2001:db8::1/128"]) {
    assert.equal(
      validateIdentifierInput("ip", value, "cidr"),
      true,
      `${value} must stay valid`,
    );
  }
});

test("exact and fingerprint validation is unchanged by the CIDR floor", () => {
  assert.equal(validateIdentifierInput("ip", "203.0.113.7", "exact"), true);
  assert.equal(validateIdentifierInput("ip", "203.0.113.7/24", "exact"), false);
  assert.equal(validateIdentifierInput("ip", "not-an-ip", "exact"), false);
  assert.equal(validateIdentifierInput("ip", "203.0.113.0/999", "cidr"), false);
  assert.equal(validateIdentifierInput("ip", "203.0.113.0/33", "cidr"), false);
  assert.equal(validateIdentifierInput("fingerprint", "abcd1234", "exact"), true);
  assert.equal(validateIdentifierInput("fingerprint", "abc", "exact"), false);
  assert.equal(validateIdentifierInput("fingerprint", "ab cd", "exact"), false);
  assert.equal(validateIdentifierInput("fingerprint", "abcd1234", "cidr"), false);
});
