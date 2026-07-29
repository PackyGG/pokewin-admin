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
export async function reloadPacksInternal(): Promise<void> {
  // Routes through the central backendApi client so env-specific URL+key,
  // CF Access service tokens, and `x-bypass-secret` are all picked up.
  try {
    await backendApi.post("/admin/reload-packs");
  } catch (err) {
    if (err instanceof BackendApiError) {
      logError(
        "packs.reloadPacks",
        `backend error status=${err.status} code=${err.code ?? "none"} payload=${JSON.stringify(err.payload)}`,
      );
      return;
    }
    logError("packs.reloadPacks", "failed to reach backend", err);
  }
}
