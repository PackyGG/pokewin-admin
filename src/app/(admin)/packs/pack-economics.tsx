"use client";

/**
 * ONE shared economics read for a pack — used by both the /packs/[id]
 * OVERVIEW and the EDIT form, so the numbers an operator reads before an edit
 * and the numbers they steer with during the edit come from the same math and
 * render in the same tiles. Previously the overview showed a realized-RTP-only
 * strip of eight cramped tiles (no theoretical edge at all) while the editor
 * hid the edge in a 6-decimal footnote — two different answers to "what is this
 * pack's edge?".
 *
 * The math is the existing dep-free engine: `computePackEv` (EV / RTP / edge
 * from the pool) and `autoTargetEdge` (the per-pack target edge curve — floor
 * 10.99% + risk premium). Nothing new is invented here; this module only
 * derives display values and lays them out.
 *
 * House-POV colors (CLAUDE.md): a POSITIVE house edge is the house winning →
 * emerald; a negative edge (we pay out more than we take) → rose. EV / payout /
 * max win are money flowing to the PLAYER → rose.
 */

import {
  Boxes,
  Coins,
  DollarSign,
  Layers,
  Percent,
  Target,
  TrendingUp,
  Trophy,
} from "lucide-react";
import { KpiTile, MetricTile, SectionHeading } from "@/components/modern-panels";
import { formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { computePackEv } from "@/app/(admin)/insights/edge-calc/math";
import { autoTargetEdge } from "./_lib/auto-targets";

export type PackEconomicsInput = {
  priceUsd: number;
  cardsPerOpen: number;
  packType: string | null;
  /** The pack's pool. `weight` may be raw weights OR odds-% — only ratios matter. */
  pool: { weight: number; priceUsd: number }[];
};

export type PackEconomics = {
  priceUsd: number;
  cardsPerOpen: number;
  poolSize: number;
  hasPool: boolean;
  /** Reward packs are given away — an "edge" on them is meaningless. */
  isReward: boolean;
  /** True when an edge/RTP figure can actually be computed and shown. */
  showEdge: boolean;
  evPerCard: number;
  evPerOpen: number;
  edgePct: number;
  rtpPct: number;
  /** Per-pack target edge from the edge curve (floor + risk premium), in %. */
  targetEdgePct: number;
  /** edgePct − targetEdgePct, in percentage points. */
  deltaPp: number;
  /** Highest single-card value in the pool (the jackpot exposure). */
  maxWin: number;
  /** maxWin / price — the top payout as a multiple of the ticket. */
  maxMultiple: number;
  /** P(drawn card value ≥ pack price) — the profit/hit rate, in %. */
  winRatePct: number;
};

export function computePackEconomics(input: PackEconomicsInput): PackEconomics {
  const { priceUsd, cardsPerOpen, packType, pool } = input;
  const totalWeight = pool.reduce((sum, c) => sum + c.weight, 0);
  const weightedPriceSum = pool.reduce((sum, c) => sum + c.weight * c.priceUsd, 0);
  const hasPool = pool.length > 0 && totalWeight > 0;

  const ev = computePackEv({
    pricePerOpen: priceUsd,
    cardsPerOpen,
    totalWeight,
    weightedPriceSum,
  });

  const maxWin = pool.reduce((max, c) => Math.max(max, c.priceUsd), 0);
  const winWeight = pool.reduce(
    (sum, c) => (priceUsd > 0 && c.priceUsd >= priceUsd ? sum + c.weight : sum),
    0,
  );
  const isReward = packType === "reward";
  const showEdge = hasPool && priceUsd > 0 && !isReward;
  const targetEdge = autoTargetEdge({ price: priceUsd, maxWin });
  const edgePct = ev.houseEdge * 100;

  return {
    priceUsd,
    cardsPerOpen,
    poolSize: pool.length,
    hasPool,
    isReward,
    showEdge,
    evPerCard: ev.expectedCardValue,
    evPerOpen: ev.expectedPayoutPerOpen,
    edgePct,
    rtpPct: ev.rtp * 100,
    targetEdgePct: targetEdge * 100,
    deltaPp: edgePct - targetEdge * 100,
    maxWin,
    maxMultiple: priceUsd > 0 ? maxWin / priceUsd : 0,
    winRatePct: hasPool ? (winWeight / totalWeight) * 100 : 0,
  };
}

/** "on target" / "+0.42pp vs target" — the one-line verdict under the edge. */
function edgeVerdict(econ: PackEconomics): { label: string; tone: string } {
  if (!econ.showEdge) {
    return {
      label: econ.isReward ? "Reward pack — no edge" : "Needs a price + card pool",
      tone: "text-muted-foreground",
    };
  }
  const target = `target ${econ.targetEdgePct.toFixed(2)}%`;
  if (Math.abs(econ.deltaPp) < 0.05) {
    return { label: `On target (${target})`, tone: "text-emerald-600 dark:text-emerald-400" };
  }
  const sign = econ.deltaPp > 0 ? "+" : "−";
  const delta = `${sign}${Math.abs(econ.deltaPp).toFixed(2)}pp vs ${target}`;
  // Under target = we earn less than this pack's risk warrants → warn (amber),
  // and a NEGATIVE edge (we lose money per open) is a hard rose.
  if (econ.edgePct < 0) {
    return { label: delta, tone: "text-rose-600 dark:text-rose-400" };
  }
  return {
    label: delta,
    tone:
      econ.deltaPp < 0
        ? "text-amber-600 dark:text-amber-400"
        : "text-emerald-600 dark:text-emerald-400",
  };
}

/**
 * The headline economics read: price, expected payout, house edge vs its
 * target, and RTP — four large tiles, plus a compact pool row underneath.
 * `title`/`hint` let the edit form label it "Live economics" while the
 * overview keeps the static label.
 */
export function PackEconomicsPanel({
  econ,
  title = "Economics",
  hint = "Theoretical — from the price + card pool",
}: {
  econ: PackEconomics;
  title?: string;
  hint?: string;
}) {
  const verdict = edgeVerdict(econ);
  const dash = "—";
  return (
    <section className="space-y-3">
      <SectionHeading
        icon={Percent}
        title={title}
        action={
          <span className="text-xs text-muted-foreground">{hint}</span>
        }
      />
      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-4">
        <MetricTile
          label="Price"
          value={formatCurrency(econ.priceUsd)}
          icon={DollarSign}
          accent="blue"
          sub={`${econ.cardsPerOpen} card${econ.cardsPerOpen === 1 ? "" : "s"} per open`}
        />
        <MetricTile
          label="EV / open"
          value={econ.hasPool ? formatCurrency(econ.evPerOpen) : dash}
          icon={Coins}
          accent="rose"
          sub={
            econ.hasPool
              ? `${formatCurrency(econ.evPerCard)} per card`
              : "No cards in the pool"
          }
        />
        <MetricTile
          label="House edge"
          value={econ.showEdge ? `${econ.edgePct.toFixed(2)}%` : dash}
          icon={TrendingUp}
          accent={econ.edgePct < 0 ? "rose" : "emerald"}
        />
        <MetricTile
          label="RTP"
          value={econ.showEdge ? `${econ.rtpPct.toFixed(2)}%` : dash}
          icon={Target}
          accent={econ.rtpPct > 100 ? "rose" : "purple"}
          sub="Player return per open"
        />
      </div>
      {/* Edge verdict on its own line — the single sentence an operator needs
          ("is this pack priced right?") rather than a 6-decimal footnote. */}
      <p className={cn("text-xs font-medium", verdict.tone)}>{verdict.label}</p>

      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-4">
        <KpiTile
          label="Cards in pool"
          value={String(econ.poolSize)}
          icon={Boxes}
          accent="orange"
        />
        <KpiTile
          label="Cards / open"
          value={String(econ.cardsPerOpen)}
          icon={Layers}
          accent="pink"
        />
        <KpiTile
          label="Max win"
          value={econ.hasPool ? formatCurrency(econ.maxWin) : dash}
          icon={Trophy}
          accent="rose"
          sub={
            econ.hasPool && econ.maxMultiple > 0
              ? `${econ.maxMultiple.toFixed(1)}× the price`
              : undefined
          }
        />
        <KpiTile
          label="Win rate"
          value={econ.showEdge ? `${econ.winRatePct.toFixed(2)}%` : dash}
          icon={Percent}
          accent="cyan"
          sub="Chance a card beats the price"
        />
      </div>
    </section>
  );
}
