import assert from "node:assert/strict";
import test from "node:test";

import { PollerHealth } from "../src/poller-health.js";
import { nextPollDelayMs } from "../src/poll-scheduler.js";

test("poll cadence waits only when the previous tick finished early", () => {
  assert.equal(nextPollDelayMs(1_000, 250), 750);
  assert.equal(nextPollDelayMs(1_000, 1_000), 0);
  assert.equal(nextPollDelayMs(1_000, 5_800), 0);
  assert.equal(nextPollDelayMs(1_000, -10), 1_000);
});

test("poller health reports success, backlog, and recovery", () => {
  const health = new PollerHealth();
  health.tickStarted(new Date("2026-01-01T00:00:00.000Z"));
  health.tickSucceeded(
    {
      signupsProcessed: 4,
      signupsRecovered: 0,
      signupFailuresPending: 2,
      activitiesProcessed: 7,
      signupBacklogPossible: true,
      signupCursorLagMs: 12_000,
    },
    new Date("2026-01-01T00:00:00.250Z"),
  );

  assert.equal(
    health.snapshot(10_000, new Date("2026-01-01T00:00:01.000Z")).status,
    "degraded",
  );

  health.tickStarted(new Date("2026-01-01T00:00:02.000Z"));
  health.tickSucceeded(
    {
      signupsProcessed: 0,
      signupsRecovered: 2,
      signupFailuresPending: 0,
      activitiesProcessed: 0,
      signupBacklogPossible: false,
      signupCursorLagMs: 5_000,
    },
    new Date("2026-01-01T00:00:02.100Z"),
  );

  const snapshot = health.snapshot(
    10_000,
    new Date("2026-01-01T00:00:03.000Z"),
  );
  assert.equal(snapshot.status, "healthy");
  assert.equal(snapshot.lastTickDurationMs, 100);
  assert.equal(snapshot.signupsRecovered, 2);
  assert.equal(snapshot.signupFailuresPending, 0);
});

test("poller health reports failures and standby replicas", () => {
  const failed = new PollerHealth();
  failed.tickStarted(new Date("2026-01-01T00:00:00.000Z"));
  failed.tickFailed("source unavailable", new Date("2026-01-01T00:00:00.100Z"));
  assert.equal(failed.snapshot(10_000).status, "degraded");
  assert.equal(failed.snapshot(10_000).lastError, "source unavailable");

  const standby = new PollerHealth();
  standby.tickStarted(new Date("2026-01-01T00:00:00.000Z"));
  standby.standby(new Date("2026-01-01T00:00:00.010Z"));
  assert.equal(standby.snapshot(10_000).status, "standby");
});

test("standby takeover marks leadership before work can hang", () => {
  const health = new PollerHealth();
  health.tickStarted(new Date("2026-01-01T00:00:00.000Z"));
  health.standby(new Date("2026-01-01T00:00:00.010Z"));

  health.tickStarted(new Date("2026-01-01T00:00:01.000Z"));
  health.leaderAcquired();
  const snapshot = health.snapshot(
    10_000,
    new Date("2026-01-01T00:00:20.000Z"),
  );
  assert.equal(snapshot.leader, true);
  assert.equal(snapshot.running, true);
});
