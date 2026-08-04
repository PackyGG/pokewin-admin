import "server-only";

import { backendApi, BackendApiError } from "@/lib/backend-api";
import { logError } from "@/lib/errors/logger";

/**
 * Ask the game backend to reload its in-memory pack cache after a pack or
 * reward mutation. NOT a server action — every call site is already
 * auth-gated (`requireCapability` / `requireAdmin`), and the directly
 * invokable `reloadPacks` server action in rewards/actions.ts layers its own
 * `requireAdmin` on top of this helper. Keeping the gate out of THIS function
 * matters: packs/actions.ts fires it post-commit for capability-holding
 * non-admins, where an internal `requireAdmin` would reject with
 * NEXT_REDIRECT and silently leave the backend pack cache stale.
 *
 * Never throws: a cache-reload failure must not fail the committed admin
 * mutation — it logs and the backend's next reload reconciles.
 */
export async function reloadPacksConfirmed(attempts = 1): Promise<boolean> {
  // Routes through the central backendApi client so env-specific URL+key,
  // CF Access service tokens, and `x-bypass-secret` are all picked up.
  const boundedAttempts = Math.min(Math.max(Math.floor(attempts), 1), 3);
  for (let attempt = 1; attempt <= boundedAttempts; attempt += 1) {
    try {
      await backendApi.post("/admin/reload-packs");
      return true;
    } catch (err) {
      if (attempt < boundedAttempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 250));
        continue;
      }
      if (err instanceof BackendApiError) {
        logError(
          "packs.reloadPacks",
          `backend error status=${err.status} code=${err.code ?? "none"} payload=${JSON.stringify(err.payload)}`,
        );
      } else {
        logError("packs.reloadPacks", "failed to reach backend", err);
      }
    }
  }
  return false;
}

/** Compatibility wrapper for callers whose committed mutation is fire-and-forget. */
export async function reloadPacksInternal(): Promise<void> {
  await reloadPacksConfirmed();
}
