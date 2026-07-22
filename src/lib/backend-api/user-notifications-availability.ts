import "server-only";

import { resolveBackendApiConfig } from "./config";
import type { DbEnv } from "@/lib/db-env";

/**
 * Which backend the per-user notification endpoints would actually hit, and
 * whether sending is allowed against it.
 *
 * Why this exists rather than reading the `admin_db_env` cookie directly:
 * `resolveBackendApiConfig` runs the cookie through `resolveEffectiveEnv`,
 * which FALLS BACK to the other environment when the requested one has no
 * URL + key configured. A cookie saying "dev" on a deploy with no dev backend
 * therefore resolves to PROD. Gating on the cookie would have let that
 * through — gating on the resolved config means the guard and the request
 * target are the same value by construction.
 *
 * Used by both the server actions (as the hard gate) and the page (to decide
 * between the composer and the "Backend not updated yet" card), so the UI can
 * never claim a different target than the one a send would use.
 */

/** Owner directive, 2026-07-22: "this is for dev db and site only atm".
 * The endpoints (PackyGG/backend#461) are merged to `dev`; prod hasn't taken
 * them. Flip to false once they ship to prod — nothing else has to change. */
export const DIRECT_NOTIFICATIONS_DEV_ONLY = true;

export type DirectNotificationAvailability = {
  /** The env a send would actually go to, or null when nothing is configured. */
  backendEnv: DbEnv | null;
  /** True when a send is permitted against that env. */
  ready: boolean;
  /** Operator-facing reason when `ready` is false. */
  reason: string | null;
};

export async function getDirectNotificationAvailability(): Promise<DirectNotificationAvailability> {
  let backendEnv: DbEnv | null = null;
  try {
    backendEnv = (await resolveBackendApiConfig()).env;
  } catch {
    // No URL / key configured for either env — the client would throw on the
    // first request anyway. Fail closed with a readable reason.
    return {
      backendEnv: null,
      ready: false,
      reason:
        "No backend API URL or admin key is configured on this deploy, so there is nothing to send to.",
    };
  }

  if (DIRECT_NOTIFICATIONS_DEV_ONLY && backendEnv !== "dev") {
    return {
      backendEnv,
      ready: false,
      reason:
        "The per-user notification endpoints only exist on the dev backend deploy. Switch the environment toggle in the header to DEV to use them.",
    };
  }

  return { backendEnv, ready: true, reason: null };
}
