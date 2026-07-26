import assert from "node:assert/strict";
import test from "node:test";

import { storedSignals } from "../src/monitor.js";

const signal = {
  key: "proxy",
  title: "Proxy detected",
  detail: "The signup IP is a proxy.",
  points: 25,
};

test("stored signals accept native json arrays", () => {
  assert.deepEqual(storedSignals([signal]), [signal]);
});

test("stored signals recover legacy double-encoded arrays", () => {
  assert.deepEqual(storedSignals(JSON.stringify([signal])), [signal]);
});

test("stored signals reject malformed values", () => {
  assert.deepEqual(storedSignals({ signal }), []);
  assert.deepEqual(storedSignals("not json"), []);
});
