import type { FullConfig } from "@playwright/test";
import { loadEnvFiles } from "./helpers/env";
import { closePools, sweepStaleScratchUsers } from "./helpers/db";

/**
 * Runs once before the test suite starts.
 *
 * Responsibilities (in order):
 *   1. Load .env files so fixtures can read DATABASE_URL / E2E_* vars.
 *   2. Sweep any stale `_e2e_*` users from a previous crashed run so
 *      unique-constraint collisions don't cascade across suites.
 */
export default async function globalSetup(_config: FullConfig) {
  loadEnvFiles();

  if (!process.env.DATABASE_URL || !process.env.ADMIN_DATABASE_URL) {
    // Surface the reason early — tests will fail anyway once they try to
    // hit the DB, but this log keeps the root cause visible.
    console.warn(
      "[e2e] DATABASE_URL / ADMIN_DATABASE_URL missing. The DB-dependent " +
        "fixtures will fail. Set them in .env.local or the CI env.",
    );
    return;
  }

  try {
    const swept = await sweepStaleScratchUsers();
    if (swept > 0) {
      console.log(`[e2e] swept ${swept} stale scratch user(s) from a previous run`);
    }
  } finally {
    await closePools();
  }
}
