import type { EditPool } from "../../doctor/retune-actions";

/**
 * Client transport for the READ-ONLY pool: GETs the concurrent
 * `/pack-studio/retune/pool` route instead of invoking the `getPackEditPool`
 * server action. React serializes server actions per client, so a slow plan
 * (post-push fresh re-plan, refused-pool wide probe) used to queue EVERY
 * later pool call behind it — the "card images/values don't load after a
 * push" incident. Same pool shape, same server-side gate
 * (`getPackEditPool` re-auths inside); errors surface as thrown
 * `Error(message)` exactly like the action did, so callers are unchanged.
 */
export async function fetchPoolOverWire(packId: string): Promise<EditPool> {
  const res = await fetch(
    `/pack-studio/retune/pool?packId=${encodeURIComponent(packId)}`,
  );
  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    /* non-JSON body (proxy error page) — the status check below reports it */
  }
  if (!res.ok) {
    const message =
      payload !== null &&
      typeof payload === "object" &&
      "error" in payload &&
      typeof (payload as { error: unknown }).error === "string"
        ? (payload as { error: string }).error
        : `Pool fetch failed (HTTP ${res.status}).`;
    throw new Error(message);
  }
  return (payload as { pool: EditPool }).pool;
}
