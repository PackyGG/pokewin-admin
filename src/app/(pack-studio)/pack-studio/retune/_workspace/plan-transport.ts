import type {
  PackTunePlan,
  PackTuneStagedInput,
} from "../../doctor/retune-actions";

/**
 * Client transport for the READ-ONLY plan: POSTs to the concurrent
 * `/pack-studio/retune/plan` route instead of invoking the `planPackTune`
 * server action. React serializes server actions per client, so a slow plan
 * (post-push fresh re-plan, refused-pool wide probe) used to queue EVERY
 * later pool/plan/pre-flight call behind it — the "next pack takes minutes
 * or never loads after a push" incident. Same payload, same plan shape, same
 * server-side gate (`planPackTune` re-auths inside); errors surface as
 * thrown `Error(message)` exactly like the action did, so `safeQueryOrNull`
 * callers are unchanged.
 */
export async function planPackTuneOverWire(
  packId: string,
  staged: PackTuneStagedInput | null,
  opts: { fresh?: boolean; lite?: boolean } | null,
): Promise<PackTunePlan | null> {
  const res = await fetch("/pack-studio/retune/plan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ packId, staged, opts }),
  });
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
        : `Plan request failed (HTTP ${res.status}).`;
    throw new Error(message);
  }
  return (
    (payload as { plan?: PackTunePlan | null } | null)?.plan ?? null
  );
}
