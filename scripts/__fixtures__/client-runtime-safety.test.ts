import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import RootError from "../../src/app/error";
import {
  normalizeStringArray,
  parseBooleanRecord,
  readBrowserStorage,
  removeBrowserStorage,
  toValidIso,
  writeBrowserStorage,
} from "../../src/lib/client-runtime-safety";

test("root route error renders a self-contained fallback without leaking details", () => {
  const html = renderToStaticMarkup(
    createElement(RootError, {
      error: Object.assign(new Error("SELECT secret FROM private_table"), {
        digest: "test-digest",
      }),
      reset: () => {},
    }),
  );

  assert.match(html, /This page could not load/);
  assert.match(html, /Digest test-digest/);
  assert.doesNotMatch(html, /private_table/);
  assert.match(html, /href="\/dashboard"/);
});

test("normalizeStringArray contains nullable and malformed server payloads", () => {
  assert.deepEqual(normalizeStringArray(null), []);
  assert.deepEqual(normalizeStringArray({}), []);
  assert.deepEqual(
    normalizeStringArray(["dashboard", null, 42, "", "users"]),
    ["dashboard", "users"],
  );
});

test("parseBooleanRecord accepts only allowed boolean entries", () => {
  const result = parseBooleanRecord(
    JSON.stringify({
      Dashboard: true,
      Users: false,
      stale: true,
      invalid: "yes",
    }),
    new Set(["Dashboard", "Users"]),
  );

  assert.deepEqual(result, { Dashboard: true, Users: false });
});

test("parseBooleanRecord rejects values that cannot represent UI state", () => {
  assert.equal(parseBooleanRecord(null), null);
  assert.equal(parseBooleanRecord("not-json"), null);
  assert.equal(parseBooleanRecord("[]"), null);
  assert.equal(parseBooleanRecord("null"), null);
  assert.equal(parseBooleanRecord('"true"'), null);
});

test("parseBooleanRecord does not materialize prototype keys", () => {
  const result = parseBooleanRecord('{"__proto__":true,"constructor":false}');
  assert.deepEqual(result, {});
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal((result as Record<string, unknown>).polluted, undefined);
});

test("toValidIso normalizes valid values and fails closed on invalid input", () => {
  assert.equal(
    toValidIso("2026-07-26T12:30:00Z"),
    "2026-07-26T12:30:00.000Z",
  );
  assert.equal(
    toValidIso(new Date("2026-07-26T12:30:00Z")),
    "2026-07-26T12:30:00.000Z",
  );
  assert.equal(toValidIso("not-a-date"), null);
  assert.equal(toValidIso(""), null);
});

test("browser persistence failures remain non-fatal", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    get() {
      throw new DOMException("Storage denied", "SecurityError");
    },
  });

  try {
    assert.equal(readBrowserStorage("key"), null);
    assert.equal(writeBrowserStorage("key", "value"), false);
    assert.equal(removeBrowserStorage("key"), false);
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
