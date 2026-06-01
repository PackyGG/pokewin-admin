import { ArrowUpCircle, Gauge, Coins, Sigma, Layers, Sparkles } from "lucide-react";

import {
  KpiTile,
  SectionHeading,
  StatPanel,
  PanelRow,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

import type {
  UpgraderTargetRow,
  UpgraderPoolStats,
} from "@/lib/queries/insights-edge-calc";
import { computeUpgraderEv, formatPct } from "./math";

/**
 * Upgrader tab — two halves:
 *   1. Empirical edge per target multiplier (rolled up from
 *      upgrader_games + PF metadata).
 *   2. Theoretical EV matrix for standard bet × target combos at the
 *      site's observed average edge (no model assumed; we use the
 *      volume-weighted realized edge as the "real" house edge so the
 *      matrix is calibrated to the site).
 *
 * Together they let the admin answer "if I let users run X× at $Y bet,
 * what does the math say I'm taking per round and per dollar wagered?"
 * — without leaving the page.
 */

// Standard bet ladder for the EV matrix. Powers-of-2-ish so the table
// stays compact while still covering the realistic ticket-size range
// admins set (typical upgrader bets are $1–$500).
const BET_LADDER = [1, 5, 10, 25, 50, 100, 250, 500] as const;
// Multiplier ladder — the common cashout tiers the UI surfaces, plus a
// couple of extremes so admins can sanity-check the edge at the wings.
const MULTIPLIER_LADDER = [1.5, 2, 3, 5, 10, 25, 50, 100] as const;

export function UpgraderTab({
  rows,
  pool,
}: {
  rows: UpgraderTargetRow[];
  pool: UpgraderPoolStats;
}) {
  // Volume-weighted edge across all empirical rows. Falls back to a
  // textbook fair-game 0% edge when there's no data so the matrix
  // still renders cleanly on a fresh install.
  const totalWager = rows.reduce((sum, r) => sum + r.wager, 0);
  const totalPayout = rows.reduce((sum, r) => sum + r.payouts, 0);
  const realizedEdge =
    totalWager > 0 ? (totalWager - totalPayout) / totalWager : 0;

  const totalBets = rows.reduce((sum, r) => sum + r.bets, 0);
  const totalWins = rows.reduce((sum, r) => sum + r.wins, 0);
  const overallHitRate = totalBets > 0 ? totalWins / totalBets : 0;

  // Find the highest and lowest realized edge buckets.
  let bestForHouse: UpgraderTargetRow | null = null;
  let worstForHouse: UpgraderTargetRow | null = null;
  for (const r of rows) {
    if (r.bets === 0) continue;
    if (
      bestForHouse === null ||
      r.empiricalHouseEdge > bestForHouse.empiricalHouseEdge
    )
      bestForHouse = r;
    if (
      worstForHouse === null ||
      r.empiricalHouseEdge < worstForHouse.empiricalHouseEdge
    )
      worstForHouse = r;
  }

  return (
    <div className="space-y-6">
      {/* ── KPI strip ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <KpiTile
          label="Pool — Enabled"
          value={formatNumber(pool.enabledCount)}
          sub={`of ${pool.poolSize} total`}
          icon={Layers}
          accent="blue"
        />
        <KpiTile
          label="Pool Value"
          value={formatCurrency(pool.enabledValueTotal)}
          sub={`${pool.distinctPrices} distinct prices`}
          icon={Coins}
          accent="cyan"
        />
        <KpiTile
          label="Realized Edge"
          value={formatPct(realizedEdge)}
          sub={`${formatNumber(totalBets)} rounds in sample`}
          icon={Gauge}
          accent={realizedEdge >= 0 ? "emerald" : "rose"}
        />
        <KpiTile
          label="Overall Hit Rate"
          value={formatPct(overallHitRate)}
          sub={`${formatNumber(totalWins)} wins`}
          icon={Sparkles}
          accent="purple"
        />
        <KpiTile
          label="Target Tiers Live"
          value={formatNumber(rows.length)}
          sub="distinct multipliers in sample"
          icon={Sigma}
          accent="amber"
        />
      </div>

      {/* ── Best/worst pair ──────────────────────────────────────── */}
      {(bestForHouse || worstForHouse) && (
        <FadeIn>
          <div className="grid gap-4 md:grid-cols-2">
            {bestForHouse && (
              <StatPanel
                title="Highest Realized Edge"
                icon={Sparkles}
                accent="emerald"
              >
                <p className="text-xl font-bold tracking-tight tabular-nums">
                  {bestForHouse.multiplier}× target
                </p>
                <p className="text-xs text-muted-foreground">
                  {formatNumber(bestForHouse.bets)} rounds ·{" "}
                  {formatCurrency(bestForHouse.wager)} wagered
                </p>
                <div className="mt-3 space-y-1">
                  <PanelRow
                    label="Realized edge"
                    value={formatPct(bestForHouse.empiricalHouseEdge)}
                    valueClassName="text-emerald-600 dark:text-emerald-400"
                  />
                  <PanelRow
                    label="Hit rate"
                    value={formatPct(bestForHouse.hitRate)}
                  />
                  <PanelRow
                    label="Theoretical chance"
                    value={formatPct(bestForHouse.theoreticalChance)}
                  />
                </div>
              </StatPanel>
            )}
            {worstForHouse && (
              <StatPanel
                title="Lowest Realized Edge"
                icon={Sparkles}
                accent={worstForHouse.empiricalHouseEdge >= 0 ? "amber" : "rose"}
              >
                <p className="text-xl font-bold tracking-tight tabular-nums">
                  {worstForHouse.multiplier}× target
                </p>
                <p className="text-xs text-muted-foreground">
                  {formatNumber(worstForHouse.bets)} rounds ·{" "}
                  {formatCurrency(worstForHouse.wager)} wagered
                </p>
                <div className="mt-3 space-y-1">
                  <PanelRow
                    label="Realized edge"
                    value={formatPct(worstForHouse.empiricalHouseEdge)}
                    valueClassName={cn(
                      worstForHouse.empiricalHouseEdge >= 0
                        ? "text-amber-600 dark:text-amber-400"
                        : "text-rose-600 dark:text-rose-400",
                    )}
                  />
                  <PanelRow
                    label="Hit rate"
                    value={formatPct(worstForHouse.hitRate)}
                  />
                  <PanelRow
                    label="Theoretical chance"
                    value={formatPct(worstForHouse.theoreticalChance)}
                  />
                </div>
              </StatPanel>
            )}
          </div>
        </FadeIn>
      )}

      {/* ── Per-target empirical table ─────────────────────────── */}
      <SectionHeading icon={ArrowUpCircle} title="Edge by Target Multiplier" />
      <FadeIn>
        <div className="overflow-hidden rounded-2xl border bg-card">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-muted/50 text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 text-left font-semibold">Target</th>
                  <th className="px-4 py-3 text-right font-semibold">
                    Rounds
                  </th>
                  <th className="px-4 py-3 text-right font-semibold">Wins</th>
                  <th className="px-4 py-3 text-right font-semibold">
                    Hit Rate
                  </th>
                  <th className="px-4 py-3 text-right font-semibold">
                    Theoretical Chance
                  </th>
                  <th className="px-4 py-3 text-right font-semibold">
                    Wager
                  </th>
                  <th className="px-4 py-3 text-right font-semibold">
                    Payouts
                  </th>
                  <th className="px-4 py-3 text-right font-semibold">
                    Realized Edge
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={8}
                      className="px-4 py-12 text-center text-sm text-muted-foreground"
                    >
                      No upgrader rounds tagged with a target multiplier yet.
                    </td>
                  </tr>
                ) : (
                  rows.map((r) => {
                    const drift = r.hitRate - r.theoreticalChance;
                    return (
                      <tr key={r.multiplier} className="hover:bg-muted/30">
                        <td className="px-4 py-3 font-medium tabular-nums">
                          {r.multiplier}×
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {formatNumber(r.bets)}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {formatNumber(r.wins)}
                        </td>
                        <td
                          className={cn(
                            "px-4 py-3 text-right tabular-nums",
                            // House-POV: hit rate above theoretical chance
                            // = users winning more often → user favored
                            // → rose. Below = house favored → emerald.
                            drift > 0.005
                              ? "text-rose-600 dark:text-rose-400"
                              : drift < -0.005
                                ? "text-emerald-600 dark:text-emerald-400"
                                : "",
                          )}
                        >
                          {formatPct(r.hitRate)}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                          {formatPct(r.theoreticalChance)}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {formatCurrency(r.wager)}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {formatCurrency(r.payouts)}
                        </td>
                        <td
                          className={cn(
                            "px-4 py-3 text-right font-medium tabular-nums",
                            r.empiricalHouseEdge >= 0
                              ? "text-emerald-600 dark:text-emerald-400"
                              : "text-rose-600 dark:text-rose-400",
                          )}
                        >
                          {formatPct(r.empiricalHouseEdge)}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </FadeIn>

      {/* ── EV matrix — bets × multipliers at the realized edge ── */}
      <SectionHeading
        icon={Sigma}
        title={`Theoretical EV Matrix — at ${formatPct(realizedEdge)} house edge`}
      />
      <FadeIn>
        <div className="overflow-hidden rounded-2xl border bg-card">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-muted/50 text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold">
                    Bet \ Target
                  </th>
                  {MULTIPLIER_LADDER.map((m) => (
                    <th
                      key={m}
                      className="px-3 py-2 text-right font-semibold tabular-nums"
                    >
                      {m}×
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {BET_LADDER.map((bet) => (
                  <tr key={bet} className="hover:bg-muted/30">
                    <td className="px-3 py-2 font-medium tabular-nums">
                      {formatCurrency(bet)}
                    </td>
                    {MULTIPLIER_LADDER.map((m) => {
                      const ev = computeUpgraderEv({
                        multiplier: m,
                        houseEdge: realizedEdge,
                      });
                      // Expected house take per round = bet × houseEdge
                      // (independent of multiplier in expectation —
                      // shown as the cell value, with chance tooltip).
                      const houseTake = bet * ev.houseEdge;
                      return (
                        <td
                          key={m}
                          className="px-3 py-2 text-right tabular-nums"
                          title={`Win chance ${formatPct(ev.winProbability, 3)} · payout per win ${formatCurrency(bet * m)}`}
                        >
                          <div
                            className={cn(
                              "font-medium",
                              houseTake >= 0
                                ? "text-emerald-600 dark:text-emerald-400"
                                : "text-rose-600 dark:text-rose-400",
                            )}
                          >
                            {formatCurrency(houseTake)}
                          </div>
                          <div className="text-[10px] text-muted-foreground">
                            {formatPct(ev.winProbability, 1)}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </FadeIn>

      {/* ── Method note ──────────────────────────────────────────── */}
      <FadeIn>
        <div className="rounded-xl border border-dashed bg-muted/20 p-4 text-xs leading-relaxed text-muted-foreground">
          <p className="mb-1 font-semibold text-foreground">How the math works</p>
          <ul className="list-disc space-y-1 pl-4">
            <li>
              <span className="font-medium text-foreground">Buckets:</span>{" "}
              rolled up from{" "}
              <code className="rounded bg-muted px-1">upgrader_games</code>{" "}
              joined to the lowest-cursor PF row per game; target multiplier
              parsed defensively from{" "}
              <code className="rounded bg-muted px-1">result_metadata</code>{" "}
              (see{" "}
              <code className="rounded bg-muted px-1">
                upgrader-metadata.ts
              </code>
              ).
            </li>
            <li>
              <span className="font-medium text-foreground">
                Theoretical chance
              </span>{" "}
              = (1 − realized edge) / multiplier. Calibrated to the
              site&apos;s empirical edge so the matrix predicts a real
              round, not a fair-game ideal.
            </li>
            <li>
              <span className="font-medium text-foreground">EV matrix cell</span>{" "}
              = bet × house edge. Independent of multiplier in expectation —
              the multiplier only shifts variance. Tooltip shows the per-win
              payout for sanity.
            </li>
          </ul>
        </div>
      </FadeIn>
    </div>
  );
}
