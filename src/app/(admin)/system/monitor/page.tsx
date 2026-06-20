import { requirePageAccess } from "@/lib/dal";
import {
  getMonitorOverview,
  getAntifraudSystem,
  getMonitorEvents,
  getMonitorApiEndpoints,
  getMonitorApiKeys,
  getMonitorChannels,
} from "@/lib/backend-api/monitor";
import { MonitorView } from "./monitor-view";

/**
 * Backend Monitor — health/overview surface for the standalone
 * `backend-monitor` service (a separate Railway app from the game backend).
 *
 * Server-side fetches `${MONITOR_API_URL}/v1/admin/overview` with a bearer
 * token (both env-only; the token NEVER reaches the client). Live health
 * data → no caching + force-dynamic so every visit / refresh re-reads.
 *
 * The fetch helper never throws: it returns a discriminated `MonitorResult`
 * (unconfigured / error / ok) and the view renders a clean state for each,
 * so a missing env var or an unreachable service degrades gracefully instead
 * of crashing the route.
 */

export const dynamic = "force-dynamic";

export const metadata = { title: "Monitor" };

export default async function MonitorPage() {
  await requirePageAccess("/system/monitor");

  // All reads are lightweight external calls — fetch them in parallel so the
  // tabs (Overview / Antifraud / Events / Channels / Endpoints / API Keys)
  // are ready together.
  const [result, antifraud, events, endpoints, apiKeys, channels] =
    await Promise.all([
      getMonitorOverview(),
      getAntifraudSystem(),
      getMonitorEvents(),
      getMonitorApiEndpoints(),
      getMonitorApiKeys(),
      getMonitorChannels(),
    ]);
  // Stamp the fetch instant on the server so the "Last fetched" indicator is
  // accurate to when the data was actually read (not when the client mounts).
  const fetchedAt = new Date().toISOString();

  return (
    <MonitorView
      result={result}
      antifraud={antifraud}
      events={events}
      endpoints={endpoints}
      apiKeys={apiKeys}
      channels={channels}
      fetchedAt={fetchedAt}
    />
  );
}
