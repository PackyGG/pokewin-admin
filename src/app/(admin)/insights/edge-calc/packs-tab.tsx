import Image from "next/image";
import { Package, Sigma, Coins, Gauge, Sparkles } from "lucide-react";

import {
  KpiTile,
  SectionHeading,
  StatPanel,
  PanelRow,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { MIN_SAMPLE } from "@/lib/metrics/formulas";

import type { PackEdgeRow } from "@/lib/queries/insights-edge-calc";
import { formatPct } from "./math";

/**
 * Realized (empirical) house edge for a pack, sample-guarded.
 *
 *   Real Edge = 1 − Empirical RTP
 *
 * This is the house edge IMPLIED BY ACTUAL OPENS, not the catalog math.
 * The row already carries `empiricalHouseEdge` (= 1 − empiricalRtp), but
 * that field is computed unconditionally in the query — it has no
 * sample-size gate. Empirical RTP runs hot on low open counts (variance),
 * which would make Real Edge come out NEGATIVE / >100% RTP for a handful
 * of opens (the M7/M8 audit finding). So we gate here on the SAME
 * canonical `MIN_SAMPLE` (30) the upgrader tab uses: below the threshold
 * we return `null` and the cell renders "—" with a low-sample tooltip,
 * rather than a confident-but-meaningless negative edge.
 *
 * Returns `null` when the pack has never been opened (no empirical data
 * at all) OR when it has been opened fewer than `MIN_SAMPLE` times.
 */
function realEdge(row: PackEdgeRow): number | null {
  if (row.empiricalRtp === null) return null;
  if (row.totalOpenings < MIN_SAMPLE) return null;
  return 1 - row.empiricalRtp;
}

/** Low-sample tooltip copy for the Real Edge cell, shaped per-row. */
function realEdgeTooltip(row: PackEdgeRow): string | undefined {
  if (row.empiricalRtp === null) return "No opens yet — no empirical data.";
  if (row.totalOpenings < MIN_SAMPLE) {
    return `Low sample: ${formatNumber(row.totalOpenings)} open${
      row.totalOpenings === 1 ? "" : "s"
    } (< ${MIN_SAMPLE}). Empirical RTP is dominated by variance on small samples, so the realized edge isn't shown until the pack clears ${MIN_SAMPLE} opens.`;
  }
  return undefined;
}

/**
 * Packs tab — table of every pack with theoretical RTP (computed from
 * the pool composition) next to empirical RTP (backend-maintained
 * lifetime numbers). The drift between the two columns is the read:
 *   • theoretical > empirical → realized volume has run favorably for
 *     the house (rose-tinted "Drift" badge)
 *   • theoretical < empirical → realized volume has run against the
 *     house (emerald-tinted; usually variance on low open counts)
 *
 * Server-rendered — no interactivity needed beyond what the page
 * shell already provides (search/sort can be added later but the
 * pack catalog is small enough that a single dense table is fine
 * for the initial pass).
 */
export function PacksTab({ rows }: { rows: PackEdgeRow[] }) {
  // Aggregate header KPIs across the active catalog. `getPackEdgeRows`
  // already filters to `active = true` AND `pack_type <> 'reward'`, so
  // every row here is a live, paid pack — inactive packs and free
  // daily/reward packs are not part of the edge-calc surface.
  const total = rows.length;
  // Average theoretical RTP across packs with a populated pool. Weighted
  // equally per-pack (catalog-level "what's the math saying overall");
  // a volume-weighted variant would just reproduce the empirical column
  // which is already on the dashboard's pack KPI strip.
  const populated = rows.filter((r) => r.theoreticalRtp !== null);
  const avgTheoRtp =
    populated.length > 0
      ? populated.reduce((sum, r) => sum + (r.theoreticalRtp ?? 0), 0) /
        populated.length
      : 0;
  const avgTheoEdge = 1 - avgTheoRtp;
  // House-POV color on the catalog-level edge tile: positive edge =
  // emerald (we win on the math), negative = rose (we'd be giving
  // value away on the math).
  const avgEdgeAccent = avgTheoEdge >= 0 ? "emerald" : "rose";

  // Find the highest / lowest theoretical edge — surfaced in the
  // overview panel so admins can spot the outliers fast.
  let bestForHouse: PackEdgeRow | null = null;
  let worstForHouse: PackEdgeRow | null = null;
  for (const r of populated) {
    if (
      bestForHouse === null ||
      (r.theoreticalHouseEdge ?? 0) > (bestForHouse.theoreticalHouseEdge ?? 0)
    )
      bestForHouse = r;
    if (
      worstForHouse === null ||
      (r.theoreticalHouseEdge ?? 0) < (worstForHouse.theoreticalHouseEdge ?? 0)
    )
      worstForHouse = r;
  }

  return (
    <div className="space-y-6">
      {/* ── KPI strip ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <KpiTile
          label="Active Packs"
          value={formatNumber(total)}
          sub="paid, live in catalog"
          icon={Package}
          accent="blue"
        />
        <KpiTile
          label="With Pool Math"
          value={formatNumber(populated.length)}
          sub={
            total > 0
              ? `${Math.round((populated.length / total) * 100)}% configured`
              : undefined
          }
          icon={Sigma}
          accent="cyan"
        />
        <KpiTile
          label="Avg. Theoretical RTP"
          value={formatPct(avgTheoRtp)}
          sub="per pack mean"
          icon={Gauge}
          accent="purple"
        />
        <KpiTile
          label="Avg. House Edge"
          value={formatPct(avgTheoEdge)}
          sub="theoretical"
          icon={Coins}
          accent={avgEdgeAccent}
        />
        <KpiTile
          label="Highest Edge Pack"
          value={
            bestForHouse?.theoreticalHouseEdge != null
              ? formatPct(bestForHouse.theoreticalHouseEdge)
              : "—"
          }
          sub={bestForHouse?.name ?? "no pool math available"}
          icon={Sparkles}
          accent="emerald"
        />
      </div>

      {/* ── Best / worst pair ─────────────────────────────────────── */}
      {(bestForHouse || worstForHouse) && (
        <FadeIn>
          <div className="grid gap-4 md:grid-cols-2">
            {bestForHouse && (
              <StatPanel
                title="Highest Theoretical Edge"
                icon={Sparkles}
                accent="emerald"
              >
                <p className="text-xl font-bold tracking-tight">
                  {bestForHouse.name}
                </p>
                <p className="text-xs text-muted-foreground">
                  {formatCurrency(bestForHouse.priceUsd)} ·{" "}
                  {bestForHouse.cardsPerOpen} cards/open
                </p>
                <div className="mt-3 space-y-1">
                  <PanelRow
                    label="Theoretical RTP"
                    value={formatPct(bestForHouse.theoreticalRtp ?? 0)}
                  />
                  <PanelRow
                    label="House edge"
                    value={formatPct(bestForHouse.theoreticalHouseEdge ?? 0)}
                    valueClassName="text-emerald-600 dark:text-emerald-400"
                  />
                  <PanelRow
                    label="E[V] per card"
                    value={formatCurrency(
                      bestForHouse.expectedCardValue ?? 0,
                    )}
                  />
                </div>
              </StatPanel>
            )}
            {worstForHouse && (
              <StatPanel
                title="Lowest Theoretical Edge"
                icon={Sparkles}
                // House-POV: a pack with a low theoretical edge gives
                // more value back to the user → rose for "house disfavored".
                accent={
                  (worstForHouse.theoreticalHouseEdge ?? 0) >= 0
                    ? "amber"
                    : "rose"
                }
              >
                <p className="text-xl font-bold tracking-tight">
                  {worstForHouse.name}
                </p>
                <p className="text-xs text-muted-foreground">
                  {formatCurrency(worstForHouse.priceUsd)} ·{" "}
                  {worstForHouse.cardsPerOpen} cards/open
                </p>
                <div className="mt-3 space-y-1">
                  <PanelRow
                    label="Theoretical RTP"
                    value={formatPct(worstForHouse.theoreticalRtp ?? 0)}
                  />
                  <PanelRow
                    label="House edge"
                    value={formatPct(worstForHouse.theoreticalHouseEdge ?? 0)}
                    valueClassName={cn(
                      (worstForHouse.theoreticalHouseEdge ?? 0) >= 0
                        ? "text-amber-600 dark:text-amber-400"
                        : "text-rose-600 dark:text-rose-400",
                    )}
                  />
                  <PanelRow
                    label="E[V] per card"
                    value={formatCurrency(
                      worstForHouse.expectedCardValue ?? 0,
                    )}
                  />
                </div>
              </StatPanel>
            )}
          </div>
        </FadeIn>
      )}

      {/* ── Pack table ────────────────────────────────────────────── */}
      <SectionHeading icon={Package} title="Pack EV Table" />
      <FadeIn>
        <div className="overflow-hidden rounded-2xl border bg-card">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="bg-muted/50 text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 text-left font-semibold">Pack</th>
                  <th className="px-4 py-3 text-right font-semibold">Price</th>
                  <th className="px-4 py-3 text-right font-semibold">
                    Cards / Open
                  </th>
                  <th className="px-4 py-3 text-right font-semibold">Pool</th>
                  <th className="px-4 py-3 text-right font-semibold">
                    E[V] / Card
                  </th>
                  <th className="px-4 py-3 text-right font-semibold">
                    E[V] / Open
                  </th>
                  <th className="px-4 py-3 text-right font-semibold">
                    Theoretical RTP
                  </th>
                  <th className="px-4 py-3 text-right font-semibold">
                    Edge (theoretical)
                  </th>
                  <th className="px-4 py-3 text-right font-semibold">
                    Real Edge (empirical)
                  </th>
                  <th className="px-4 py-3 text-right font-semibold">
                    Empirical RTP
                  </th>
                  <th className="px-4 py-3 text-right font-semibold">Drift</th>
                  <th className="px-4 py-3 text-right font-semibold">Opens</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={12}
                      className="px-4 py-12 text-center text-sm text-muted-foreground"
                    >
                      No packs in the catalog yet.
                    </td>
                  </tr>
                ) : (
                  rows.map((p) => {
                    const noPool = p.theoreticalRtp === null;
                    const theoEdge = p.theoreticalHouseEdge ?? 0;
                    const empRtp = p.empiricalRtp;
                    const drift =
                      empRtp !== null && p.theoreticalRtp !== null
                        ? p.theoreticalRtp - empRtp
                        : null;
                    // Realized house edge from actual opens (1 − empirical
                    // RTP), gated on MIN_SAMPLE so a handful of opens can't
                    // print a misleading negative edge (see `realEdge`).
                    const rEdge = realEdge(p);
                    const rEdgeTip = realEdgeTooltip(p);
                    return (
                      <tr key={p.id} className="hover:bg-muted/30">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2.5">
                            {p.imageUrl ? (
                              <div className="relative size-8 shrink-0 overflow-hidden rounded-md border bg-muted/30">
                                <Image
                                  src={p.imageUrl}
                                  alt={p.name}
                                  fill
                                  sizes="32px"
                                  className="object-cover"
                                  unoptimized
                                />
                              </div>
                            ) : (
                              <div className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted/30">
                                <Package className="size-4 text-muted-foreground" />
                              </div>
                            )}
                            <div className="min-w-0">
                              <p className="truncate font-medium">{p.name}</p>
                              <p className="truncate text-[11px] text-muted-foreground">
                                {p.slug}
                              </p>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {formatCurrency(p.priceUsd)}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {p.cardsPerOpen}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {p.poolSize}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {p.expectedCardValue !== null
                            ? formatCurrency(p.expectedCardValue)
                            : "—"}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {p.expectedPayoutPerOpen !== null
                            ? formatCurrency(p.expectedPayoutPerOpen)
                            : "—"}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {noPool ? "—" : formatPct(p.theoreticalRtp ?? 0)}
                        </td>
                        <td
                          className={cn(
                            "px-4 py-3 text-right tabular-nums font-medium",
                            !noPool &&
                              (theoEdge >= 0
                                ? "text-emerald-600 dark:text-emerald-400"
                                : "text-rose-600 dark:text-rose-400"),
                          )}
                        >
                          {noPool ? "—" : formatPct(theoEdge)}
                        </td>
                        <td
                          className={cn(
                            "px-4 py-3 text-right tabular-nums font-medium",
                            // House-POV: realized edge positive = house
                            // green, negative = house red. Below sample /
                            // no opens → neutral muted "—" (no confident
                            // sign on small samples).
                            rEdge === null
                              ? "text-muted-foreground"
                              : rEdge >= 0
                                ? "text-emerald-600 dark:text-emerald-400"
                                : "text-rose-600 dark:text-rose-400",
                          )}
                          title={rEdgeTip}
                        >
                          {rEdge !== null ? formatPct(rEdge) : "—"}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {empRtp !== null ? formatPct(empRtp) : "—"}
                        </td>
                        <td
                          className={cn(
                            "px-4 py-3 text-right tabular-nums",
                            drift !== null &&
                              // House-POV: theoretical > empirical = the
                              // realized RTP has run below the math →
                              // good for the house → emerald.
                              (drift >= 0
                                ? "text-emerald-600 dark:text-emerald-400"
                                : "text-rose-600 dark:text-rose-400"),
                          )}
                        >
                          {drift !== null
                            ? `${drift >= 0 ? "+" : ""}${formatPct(drift)}`
                            : "—"}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                          {formatNumber(p.totalOpenings)}
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

      {/* ── Method note ────────────────────────────────────────────── */}
      <FadeIn>
        <div className="rounded-xl border border-dashed bg-muted/20 p-4 text-xs leading-relaxed text-muted-foreground">
          <p className="mb-1 font-semibold text-foreground">How the math works</p>
          <ul className="list-disc space-y-1 pl-4">
            <li>
              <span className="font-medium text-foreground">E[V] per card</span>{" "}
              = SUM(pack_cards.weight × cards.price) / SUM(weight). Each open
              draws cards_per_open independent cards from this weighted pool.
            </li>
            <li>
              <span className="font-medium text-foreground">E[V] per open</span>{" "}
              = E[V] per card × cards_per_open. Theoretical RTP = E[V] per open
              / sticker price.
            </li>
            <li>
              <span className="font-medium text-foreground">
                Edge (theoretical)
              </span>{" "}
              = 1 − theoretical RTP — the house edge the catalog math
              implies. Exact (computed from the pool), so no sample gate.
            </li>
            <li>
              <span className="font-medium text-foreground">
                Real Edge (empirical)
              </span>{" "}
              = 1 − empirical RTP — the house edge implied by the pack&apos;s
              actual opens. Gated at{" "}
              <code className="rounded bg-muted px-1">{MIN_SAMPLE}</code> opens:
              below that, empirical RTP is dominated by variance (it can run
              over 100%, which would flip the edge negative), so the cell
              shows &ldquo;—&rdquo; with a low-sample note instead of a
              misleading figure.
            </li>
            <li>
              <span className="font-medium text-foreground">Drift</span> =
              theoretical RTP − empirical RTP. House-POV: emerald = realized
              has run below the math (house favored), rose = above (user
              favored).
            </li>
            <li>
              <span className="font-medium text-foreground">Empirical RTP</span>{" "}
              is the backend-maintained{" "}
              <code className="rounded bg-muted px-1">packs.actual_rtp</code>{" "}
              column (lifetime).
            </li>
          </ul>
        </div>
      </FadeIn>
    </div>
  );
}
