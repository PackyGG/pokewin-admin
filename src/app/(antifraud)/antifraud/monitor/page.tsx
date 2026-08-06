import { Suspense } from "react";

import { safeQuery } from "@/lib/errors/safe-query";
import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";
import {
  buildAntifraudMonitorSnapshot,
  type AntifraudMonitorSnapshot,
} from "@/lib/antifraud/monitor-snapshot";

import { MonitorConsole } from "./monitor-console";
import { MonitorConsoleSkeleton } from "./monitor-skeleton";

export const metadata = { title: "Live Monitor" };

/** The snapshot must never hold the shell hostage — the stream is the point. */
const SNAPSHOT_TIMEOUT_MS = 6_000;

/**
 * Antifraud → Live behaviour monitor.
 *
 * The console is a client island driven by the SSE stream, but its FIRST paint
 * comes from one snapshot. Producing that snapshot here — behind a Suspense
 * boundary rendering the same skeleton as `loading.tsx` — means the operator
 * sees loading affordances until real data exists, instead of a shell that
 * resolves instantly and then hydrates into seven "—" tiles and an amber
 * "Sessions unavailable — reload the page" panel while the mount fetch is
 * still in flight.
 *
 * `safeQuery` bounds the wait: a slow or broken monitor degrades to `null`,
 * the console falls back to its own mount fetch, and the page still renders.
 */
export default async function AntifraudMonitorPage() {
  await requireAntifraudPageAccess();

  return (
    <div className="space-y-4">
      <Suspense fallback={<MonitorConsoleSkeleton />}>
        <MonitorConsoleSection />
      </Suspense>
    </div>
  );
}

async function MonitorConsoleSection() {
  const snapshot = await safeQuery<AntifraudMonitorSnapshot | null>(
    () => buildAntifraudMonitorSnapshot(),
    null,
    "antifraud.monitor-snapshot",
    SNAPSHOT_TIMEOUT_MS,
  );

  // Plain JSON only — `buildAntifraudMonitorSnapshot` returns parsed upstream
  // payloads and numbers, never a function or class instance, so this crosses
  // the Server → Client boundary safely.
  return <MonitorConsole initialSnapshot={snapshot.error ? null : snapshot.data} />;
}
