import assert from "node:assert/strict";
import test from "node:test";

import { runWithConcurrency } from "../../src/lib/promise-pool";

test("runWithConcurrency preserves order and enforces its limit", async () => {
  let active = 0;
  let peak = 0;

  const task = (value: number, delayMs: number) => async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    active -= 1;
    return value;
  };

  const result = await runWithConcurrency(
    [task(1, 15), task(2, 1), task(3, 1)] as const,
    2,
  );

  assert.deepEqual(result, [1, 2, 3]);
  assert.equal(peak, 2);
});

test("runWithConcurrency stops scheduling new work after a rejection", async () => {
  const started: number[] = [];
  const tasks = [
    async () => {
      started.push(1);
      throw new Error("boom");
    },
    async () => {
      started.push(2);
      return 2;
    },
  ] as const;

  await assert.rejects(() => runWithConcurrency(tasks, 1), /boom/);
  assert.deepEqual(started, [1]);
});
