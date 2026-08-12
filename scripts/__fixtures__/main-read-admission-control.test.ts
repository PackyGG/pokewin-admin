import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  withMainReadSlot,
  mainReadLimiterSnapshot,
} from "../../src/lib/main-read-limiter";
import { withTimeout } from "../../src/lib/errors/safe-query";

const repoRoot = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(repoRoot, p), "utf8");

/**
 * Regression: "Couldn't load this section" on the dashboard.
 *
 * The mirror pool is max:2 while `statement_timeout` is 30s and
 * `connectionTimeoutMillis` is 10s. node-postgres applies the connect timeout
 * to QUEUE WAIT, so one slow query holding a slot for up to 30s made every
 * reader queued behind it reject after 10s with
 * `timeout exceeded when trying to connect`. That is not a QueryTimeoutError,
 * so `safeQuery` classified it as a hard error and the tile rendered
 * "Couldn't load this section" — on a different tile each reload, because the
 * loser of the race varies.
 *
 * Admission control moves the waiting into JavaScript, where it is untimed and
 * cannot manufacture a connect failure.
 */

test("admission control never admits more readers than the pool can serve", async () => {
  const permits = 2;
  let concurrent = 0;
  let peak = 0;

  await Promise.all(
    Array.from({ length: 25 }, () =>
      withMainReadSlot("test:cap", permits, async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await new Promise((r) => setTimeout(r, 5));
        concurrent -= 1;
      }),
    ),
  );

  assert.equal(
    peak <= permits,
    true,
    `peak concurrency ${peak} exceeded ${permits}`,
  );
  assert.equal(concurrent, 0, "every slot must be returned");
});

test("a rejected read still returns its slot", async () => {
  const permits = 1;
  // Fail repeatedly; if the permit leaked even once the next acquire hangs.
  for (let i = 0; i < 5; i += 1) {
    await assert.rejects(
      withMainReadSlot("test:release", permits, async () => {
        throw new Error("boom");
      }),
      /boom/,
    );
  }

  // Must still be able to acquire — proves nothing leaked.
  const ok = await withMainReadSlot("test:release", permits, async () => "ok");
  assert.equal(ok, "ok");
  assert.equal(mainReadLimiterSnapshot()["test:release"].inFlight, 0);
});

test("all queued readers eventually run (no starvation)", async () => {
  const completed: number[] = [];
  await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      withMainReadSlot("test:fifo", 2, async () => {
        await new Promise((r) => setTimeout(r, 1));
        completed.push(i);
      }),
    ),
  );
  assert.equal(completed.length, 12, "every queued reader must run");
});

test("a slow reader delays but does not fail its siblings", async () => {
  const permits = 2;
  const outcomes: string[] = [];

  const slow = withMainReadSlot("test:slow", permits, async () => {
    await new Promise((r) => setTimeout(r, 60));
    outcomes.push("slow");
  });
  const fast = Array.from({ length: 6 }, (_, i) =>
    withMainReadSlot("test:slow", permits, async () => {
      await new Promise((r) => setTimeout(r, 1));
      outcomes.push(`fast-${i}`);
    }),
  );

  // The key property: nothing rejects. Previously the siblings queued behind a
  // slow slot-holder rejected with a connect timeout.
  await assert.doesNotReject(Promise.all([slow, ...fast]));
  assert.equal(outcomes.length, 7);
});

test("a timed-out queued reader is removed and never runs later", async () => {
  const key = "test:cancel-queued";
  let releaseHolder!: () => void;
  let queuedOperationStarted = false;

  const holder = withMainReadSlot(
    key,
    1,
    () =>
      new Promise<void>((resolve) => {
        releaseHolder = resolve;
      }),
  );
  // Let the holder acquire before enqueueing the time-boxed sibling.
  await new Promise((resolve) => setImmediate(resolve));

  await assert.rejects(
    withTimeout(
      () =>
        withMainReadSlot(key, 1, async () => {
          queuedOperationStarted = true;
        }),
      10,
    ),
    /Query exceeded 10ms/,
  );
  assert.equal(mainReadLimiterSnapshot()[key].queued, 0);

  releaseHolder();
  await holder;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    queuedOperationStarted,
    false,
    "deadline-expired work must not reach PostgreSQL after its caller left",
  );

  // Cancellation must not consume or leak the next permit.
  assert.equal(await withMainReadSlot(key, 1, async () => "ok"), "ok");
});

test("the mirror pool is admission-controlled at the checkout, not per statement", () => {
  const source = read("src/lib/db.ts");

  assert.match(source, /const MIRROR_POOL_MAX = \d+;/);
  assert.match(
    source,
    /max: isReadMirror \? MIRROR_POOL_MAX : 3,/,
    "the limiter must be sized from the same constant as the pool",
  );
  assert.match(
    source,
    /return isReadMirror \? withReadAdmissionControl\(pool, env\) : pool;/,
    "only the read mirror is admission-controlled; the primary is untouched",
  );

  // `connect` is the single acquisition path — `Pool.prototype.query` calls it
  // internally. Wrapping `query` too makes a statement hold one permit while
  // waiting for a second, which deadlocks the isolate at `permits` concurrent
  // reads (see the behavioural regression below).
  assert.match(source, /Reflect\.set\(pool, "connect"/);
  assert.doesNotMatch(
    source,
    /Reflect\.set\(pool, "query"/,
    "wrapping pool.query re-introduces the self-deadlock",
  );

  // A checkout must hold its permit for the whole checkout, released via
  // client.release(), and must never leak it on a failed checkout.
  assert.match(source, /returnPermit\(\)/);
  assert.match(source, /if \(released\) return undefined;/);
});

/**
 * Minimal stand-in for node-postgres' Pool that reproduces the ONE detail that
 * matters here: `query()` acquires its client through `this.connect(cb)`, so
 * anything wrapped around `connect` is also on the path of every statement.
 */
function makeFakePool(max: number) {
  let leased = 0;
  const waiters: Array<() => void> = [];
  const pool = {
    async connect(cb?: (e: unknown, c: unknown, done: unknown) => void) {
      const lease = async () => {
        if (leased >= max) {
          await new Promise<void>((r) => waiters.push(r));
        }
        leased += 1;
        const client = {
          release() {
            leased -= 1;
            waiters.shift()?.();
          },
          async query() {
            return { rows: [] };
          },
        };
        return client;
      };
      const checkout = lease();
      if (!cb) return checkout;
      void checkout.then((c) => cb(undefined, c, c.release));
      return undefined;
    },
    // Mirrors pg-pool: query is connect + client.query + release.
    query(): Promise<unknown> {
      return new Promise((resolve, reject) => {
        void (pool.connect as (cb: (e: unknown, c: never) => void) => void)(
          (error, client: { query(): Promise<unknown>; release(): void }) => {
            if (error) return reject(error);
            client.query().then(
              (res) => {
                client.release();
                resolve(res);
              },
              (err) => {
                client.release();
                reject(err);
              },
            );
          },
        );
      });
    },
  };
  return pool;
}

test("concurrent statements never deadlock the admission limiter", async () => {
  // Regression for 2026-08-12: `query` and `connect` were BOTH wrapped, so a
  // statement held one of the two permits while its internal connect waited for
  // the other. Two concurrent dashboard reads hung the isolate's MAIN pool
  // forever and every tile fell back to "timeout exceeded when trying to
  // connect" while the mirror answered in milliseconds.
  const { withReadAdmissionControl } = await import("../../src/lib/db");
  const fake = makeFakePool(2);
  const pool = withReadAdmissionControl(
    fake as unknown as Parameters<typeof withReadAdmissionControl>[0],
    "dev",
  ) as unknown as { query(): Promise<unknown> };

  const results = await Promise.race([
    Promise.all(Array.from({ length: 12 }, () => pool.query())),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("admission control deadlocked")),
        5_000,
      ),
    ),
  ]);
  assert.equal((results as unknown[]).length, 12);
});

test("the checkout watchdog destroys a leaked pool client", async () => {
  const { withReadAdmissionControl } = await import("../../src/lib/db");
  const releaseArguments: unknown[][] = [];
  const fakePool = {
    async connect() {
      return {
        release(...args: unknown[]) {
          releaseArguments.push(args);
        },
      };
    },
  };
  const pool = withReadAdmissionControl(
    fakePool as unknown as Parameters<typeof withReadAdmissionControl>[0],
    "prod",
    10,
  );

  await pool.connect();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(
    releaseArguments,
    [[true]],
    "a leaked checkout must be destroyed, not merely return its permit",
  );
});

test("the limiter is shared across module instances via globalThis", () => {
  const source = read("src/lib/main-read-limiter.ts");
  assert.match(source, /globalForLimiter\.mainReadLimiters = limiters;/);
  // Must NOT be dev-only: a per-instance limiter in production defeats it.
  assert.doesNotMatch(
    source,
    /NODE_ENV !== "production"[\s\S]{0,120}mainReadLimiters/,
    "admission control must be shared in production too",
  );
  // The permit must be returned in a finally block.
  assert.match(source, /\} finally \{[\s\S]{0,240}this\.release\(\);/);
});
