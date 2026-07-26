import assert from "node:assert/strict";
import test from "node:test";

import { runTelemetrySafely } from "../../src/lib/errors/logger";

test("telemetry failures cannot escape an application error handler", () => {
  assert.doesNotThrow(() =>
    runTelemetrySafely(() => {
      throw new Error("telemetry unavailable");
    }),
  );
});
