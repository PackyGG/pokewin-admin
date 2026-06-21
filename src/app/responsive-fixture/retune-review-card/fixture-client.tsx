"use client";

import * as React from "react";

import {
  computePackRisk,
  shapeWeights,
} from "@/app/(admin)/insights/edge-calc/risk";
import {
  autoRetuneTargets,
  DEFAULT_EDGE_CURVE,
  type ResolvedAutoTargetCfg,
} from "@/app/(pack-studio)/pack-studio/_lib/auto-targets";
import type { PortfolioPackTargets } from "@/app/(pack-studio)/pack-studio/_lib/portfolio";
import type {
  PlanAllProposal,
  PlanAllCard,
} from "@/app/(pack-studio)/pack-studio/doctor/retune-actions";

import { ReviewCard } from "@/app/(pack-studio)/pack-studio/retune/review-card";
import type { ReviewItem } from "@/app/(pack-studio)/pack-studio/retune/retune-review";

/**
 * Builds a representative `ReviewItem` the SAME way `planAllRetunes` does — pure
 * `autoRetuneTargets` (tag-aware via the pack name) + `computePackRisk` (before)
 * + `shapeWeights` (after) — then renders the production `ReviewCard`. No DB, no
 * server action; this only exercises the redesigned presentation.
 */

const CFG: ResolvedAutoTargetCfg = {
  globalCap: 25000,
  maxMultCeiling: 100,
  edgeCurve: DEFAULT_EDGE_CURVE,
};

function makeProposal(
  name: string,
  price: number,
  values: number[],
  weights: number[],
): PlanAllProposal {
  const cards: PlanAllCard[] = values.map((value, i) => ({
    cardId: `card-${i}`,
    value,
    weight: weights[i]!,
  }));
  const autoTargets: PortfolioPackTargets = autoRetuneTargets(price, CFG, name);
  const before = computePackRisk({
    cards: cards.map((c) => ({ value: c.value, weight: c.weight })),
    price,
  });
  const shaped = shapeWeights({
    cards: cards.map((c) => ({ value: c.value })),
    price,
    targetEdge: autoTargets.targetEdge,
    targetWinRate: autoTargets.targetWinRate,
    maxWinCap: autoTargets.maxWinCap,
    nearMissMin: autoTargets.nearMissMin,
  });

  if ("error" in shaped) {
    return {
      packId: name,
      name,
      slug: name,
      price,
      cards,
      currentWeights: cards.map((c) => ({ cardId: c.cardId, weight: c.weight })),
      autoTargets,
      intendedHitRate: autoTargets.intendedHitRate,
      targetWinRate: autoTargets.targetWinRate,
      before,
      after: null,
      weightDiff: null,
      feasible: false,
      relaxations: [],
      error: shaped.error,
      limit: shaped.limit,
    };
  }

  const weightDiff = cards
    .map((c, i) => ({ cardId: c.cardId, from: c.weight, to: shaped.weights[i]! }))
    .filter((d) => d.from !== d.to);

  return {
    packId: name,
    name,
    slug: name,
    price,
    cards,
    currentWeights: cards.map((c) => ({ cardId: c.cardId, weight: c.weight })),
    autoTargets,
    intendedHitRate: autoTargets.intendedHitRate,
    targetWinRate: autoTargets.targetWinRate,
    before,
    after: shaped.risk,
    weightDiff,
    feasible: true,
    relaxations: shaped.relaxations,
    limit: null,
  };
}

export function RetuneReviewCardFixtureClient() {
  // A tagged "1% 18 PLUS" lottery pack: one big jackpot card + a spread of dust.
  const taggedProposal = React.useMemo(
    () =>
      makeProposal(
        "1% Divine Order",
        25,
        [2000, 200, 60, 30, 26, 18, 13.5, 10, 5, 2, 1, 0.5],
        [1, 6, 30, 60, 120, 240, 400, 600, 1200, 2000, 3000, 4000],
      ),
    [],
  );
  // An untagged standard pack.
  const standardProposal = React.useMemo(
    () =>
      makeProposal(
        "Blazing Light",
        10,
        [250, 80, 30, 15, 11, 6, 5.5, 4, 2, 1, 0.5],
        [2, 8, 30, 60, 100, 200, 220, 400, 800, 1600, 2400],
      ),
    [],
  );

  const [item, setItem] = React.useState<ReviewItem>({
    proposal: taggedProposal,
    status: "pending",
    adjusted: null,
  });
  const [which, setWhich] = React.useState<"tagged" | "standard">("tagged");

  function pick(next: "tagged" | "standard") {
    setWhich(next);
    setItem({
      proposal: next === "tagged" ? taggedProposal : standardProposal,
      status: "pending",
      adjusted: null,
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-2 text-sm">
        <button
          type="button"
          onClick={() => pick("tagged")}
          className={`rounded-md border px-3 py-1.5 ${which === "tagged" ? "bg-accent" : ""}`}
        >
          1% tagged pack
        </button>
        <button
          type="button"
          onClick={() => pick("standard")}
          className={`rounded-md border px-3 py-1.5 ${which === "standard" ? "bg-accent" : ""}`}
        >
          Standard pack
        </button>
      </div>
      <ReviewCard
        item={item}
        index={0}
        total={5}
        applying={false}
        portfolioMode={false}
        editorTargets={{
          targetEdge: item.proposal.autoTargets.targetEdge,
          targetWinRate: item.proposal.autoTargets.targetWinRate,
          maxWinCap: item.proposal.autoTargets.maxWinCap,
          nearMissMin: item.proposal.autoTargets.nearMissMin,
        }}
        editing={false}
        onApprove={() => {}}
        onDecline={() => {}}
        onBack={() => {}}
        onAdjust={() => {}}
        onResetAdjust={() => {}}
        onOpenEditor={() => {}}
        onCloseEditor={() => {}}
        onApplyEdit={() => {}}
      />
    </div>
  );
}
