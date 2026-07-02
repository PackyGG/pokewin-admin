"use client";

import { Check, Layers, Tags, TrendingDown } from "lucide-react";

import { KpiTile } from "@/components/modern-panels";
import type { RetuneRailRow } from "../_queries/rail";

/**
 * Portfolio strip (§8) — replaces the old SystemBalancePanel. 4 `KpiTile`s
 * computed from the RAIL ROWS ONLY (the 60s ADMIN risk snapshot): zero MAIN
 * reads, no portfolio mode/toggle, no cross-pack balancer. "Pushed this
 * session" is client-updated after each successful write.
 */
export function PortfolioStrip({
  rows,
  pushedCount,
}: {
  rows: RetuneRailRow[];
  pushedCount: number;
}) {
  const belowTarget = rows.filter((r) => r.edge < r.targetEdge - 1e-9).length;
  const offTag = rows.filter((r) => r.offTagLive).length;
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
        label="Pushed this session"
        value={String(pushedCount)}
        sub="written live from this workspace"
        icon={Check}
        accent="emerald"
      />
    </div>
  );
}
