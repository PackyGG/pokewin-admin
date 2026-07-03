"use client";

import { CircleCheckBig, Layers, Tags, TrendingDown } from "lucide-react";

import { KpiTile } from "@/components/modern-panels";
import type { RetuneRailRow } from "../_queries/rail";

/**
 * Portfolio strip (§8) — 4 `KpiTile`s computed from the RAIL ROWS ONLY (the 60s
 * ADMIN risk snapshot): zero MAIN reads, no portfolio mode/toggle, no cross-pack
 * balancer.
 *
 * The 4th tile is the PERSISTENT "Tuned: X / N · M remaining" progress readout
 * (owner feature, 2026-07-04) — server-derived from the DISTINCT count of packs
 * with an edit/retune snapshot (`getTunedPackCount`), so it survives sessions
 * and browsers instead of the old per-browser "Pushed this session" counter.
 * Packs pushed THIS session are unioned in so a fresh push shows immediately
 * (the server count is 60s-cached and only re-read on the debounced refresh);
 * the count is clamped to the fleet size so "remaining" never goes negative.
 */
export function PortfolioStrip({
  rows,
  pushedThisSession,
  serverTunedCount,
  sessionPushedIds,
}: {
  rows: RetuneRailRow[];
  /** Packs pushed from THIS browser session (drives the immediate union). */
  pushedThisSession: number;
  /** Server distinct-tuned-pack count (persistent across sessions/browsers). */
  serverTunedCount: number;
  /** Ids pushed this session — union with the server count so it can't lag. */
  sessionPushedIds: Set<string>;
}) {
  const belowTarget = rows.filter((r) => r.edge < r.targetEdge - 1e-9).length;
  const offTag = rows.filter((r) => r.offTagLive).length;

  // The fleet size = the active/priced packs the rail loaded (the "/ 183").
  const fleet = rows.length;
  // A session push is guaranteed tuned; the server count already includes all
  // historical tunes. `max` of the two never under-reports (a session push is a
  // subset of all-time tunes, so it can only fill the gap the 60s cache leaves).
  // Clamp to the fleet so a tuned pack no longer in scope can't push it over.
  const tuned = Math.min(
    fleet,
    Math.max(serverTunedCount, sessionPushedIds.size, pushedThisSession),
  );
  const remaining = Math.max(0, fleet - tuned);

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <KpiTile
        label="Packs in scope"
        value={String(rows.length)}
        sub="active, priced — from the risk snapshot"
        icon={Layers}
        accent="blue"
      />
      <KpiTile
        label="Below target"
        value={String(belowTarget)}
        sub="edge under the pack's own curve"
        icon={TrendingDown}
        accent={belowTarget === 0 ? "emerald" : "rose"}
      />
      <KpiTile
        label="Off-tag"
        value={String(offTag)}
        sub="live win-rate misses the tag"
        icon={Tags}
        accent={offTag === 0 ? "emerald" : "rose"}
      />
      <KpiTile
        label="Tuned"
        value={`${tuned} / ${fleet}`}
        sub={
          remaining === 0
            ? "every pack has a workspace push"
            : `${remaining} pack${remaining === 1 ? "" : "s"} remaining`
        }
        icon={CircleCheckBig}
        accent={remaining === 0 ? "emerald" : "purple"}
      />
    </div>
  );
}
