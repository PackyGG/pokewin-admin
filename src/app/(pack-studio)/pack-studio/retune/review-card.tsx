"use client";

import * as React from "react";
import {
  ArrowRight,
  Check,
  ChevronLeft,
  Info,
  Loader2,
  RotateCcw,
  SlidersHorizontal,
  TriangleAlert,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { AnimatedNumber } from "@/components/animated-number";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import type { PackRisk, RiskTier } from "@/app/(admin)/insights/edge-calc/risk";

import type { ReviewItem } from "./retune-review";

/**
 * The single review card — ONE pack's BEFORE→AFTER comparison plus the inline
 * Adjust panel + the Approve / Decline / Back controls. Pure presentation +
 * local lever state; the parent (`RetuneReview`) owns the proposal list, the
 * token, the per-pack status, and the write loop.
 *
 * ALWAYS RENDER AN AFTER. A feasible proposal — even one whose soft targets the
 * solver had to RELAX — always shows its AFTER metrics. When the solver relaxed
 * a soft target (`relaxations`), a friendly per-relaxation banner explains what
 * was loosened + how to enable it. Only a genuinely infeasible pack (the error
 * arm) shows the structured `limit` (detail + suggestion) instead of an AFTER —
 * never a blank "no feasible result" for a feasible pack.
 *
 * House-POV coloring (CLAUDE.md): a healthy house edge (≥ target) reads emerald;
 * a low edge (house giving away margin) reads rose. A rising win-rate / max-win
 * means the PLAYER wins more (our cost up) so the "after" tints rose when it
 * climbs; a falling one tints emerald. Neutral facts (CV, tier, near-miss) stay
 * muted. Numbers animate via the serializable-`formatKind` `AnimatedNumber`.
 */

function pct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(2)}%`;
}

/** Parse a percent string ("10.99") to a fraction (0.1099), or null if invalid. */
function parsePct(raw: string): number | null {
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return null;
  return n / 100;
}

/** Parse a USD string to a positive number, or null when blank/invalid. */
function parseUsd(raw: string): number | null {
  const t = raw.trim();
  if (t === "") return null;
  const n = parseFloat(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Friendly per-lever label for a relaxation banner. */
const LEVER_LABEL: Record<string, string> = {
  nearMiss: "Near-miss",
  winRate: "Win-rate",
  floor: "Floor pin",
};

const TIER_TONE: Record<RiskTier, string> = {
  T1: "text-emerald-600 dark:text-emerald-400",
  T2: "text-emerald-600 dark:text-emerald-400",
  T3: "text-amber-600 dark:text-amber-400",
  T4: "text-orange-600 dark:text-orange-400",
  T5: "text-rose-600 dark:text-rose-400",
};

export function ReviewCard({
  item,
  index,
  total,
  targetEdge,
  applying,
  portfolioMode,
  onApprove,
  onDecline,
  onBack,
  onAdjust,
  onResetAdjust,
}: {
  item: ReviewItem;
  index: number;
  total: number;
  targetEdge: number;
  applying: boolean;
  /** True when system-balance mode is on (proposals are portfolio-targeted). */
  portfolioMode: boolean;
  onApprove: () => void;
  onDecline: () => void;
  onBack: () => void;
  /** Re-shape locally with the given lever overrides (instant after-preview). */
  onAdjust: (levers: {
    targetWinRate: number;
    maxWinCap: number | undefined;
    nearMissMin: number;
  }) => void;
  onResetAdjust: () => void;
}) {
  const [showAdjust, setShowAdjust] = React.useState(false);

  // Lever inputs seeded from the proposal's auto-targets (or the active
  // adjustment when one exists). Local string state for the controls.
  const auto = item.proposal.autoTargets;
  const active = item.adjusted;
  const [winRatePct, setWinRatePct] = React.useState(
    ((active?.targetWinRate ?? auto.targetWinRate) * 100).toFixed(0),
  );
  const [maxWinCapUsd, setMaxWinCapUsd] = React.useState(
    String(active?.maxWinCap ?? auto.maxWinCap),
  );
  const [nearMissPct, setNearMissPct] = React.useState(
    ((active?.nearMissMin ?? auto.nearMissMin) * 100).toFixed(1),
  );

  // Re-seed the lever inputs + close the panel when the card changes (new pack).
  React.useEffect(() => {
    const a = item.adjusted;
    setWinRatePct(((a?.targetWinRate ?? auto.targetWinRate) * 100).toFixed(0));
    setMaxWinCapUsd(String(a?.maxWinCap ?? auto.maxWinCap));
    setNearMissPct(((a?.nearMissMin ?? auto.nearMissMin) * 100).toFixed(1));
    setShowAdjust(false);
    // Intentionally keyed on the pack id so switching packs resets the panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.proposal.packId]);

  const winRate = parsePct(winRatePct);
  const maxWinCap = parseUsd(maxWinCapUsd);
  const nearMissMin = parsePct(nearMissPct);
  const leversValid =
    winRate != null &&
    winRate >= 0 &&
    winRate < 1 &&
    (maxWinCapUsd.trim() === "" || maxWinCap != null) &&
    nearMissMin != null &&
    nearMissMin >= 0 &&
    nearMissMin < 1;

  const winRateNum = Math.round((winRate ?? auto.targetWinRate) * 100);

  // Apply the CURRENT field values to a fresh local re-shape. Reads the live
  // parsed levers (winRate / maxWinCap / nearMissMin) so the AFTER panel + the
  // relaxation banners update on every "Re-shape preview" click.
  function applyAdjust() {
    if (!leversValid) return;
    onAdjust({
      targetWinRate: winRate!,
      maxWinCap: maxWinCap ?? undefined,
      nearMissMin: nearMissMin!,
    });
  }

  const { proposal } = item;
  const before = proposal.before;
  // The active "after": a local adjustment supersedes the server proposal.
  const after = active ? active.after : proposal.after;
  const feasible = active ? active.feasible : proposal.feasible;
  const limit = active ? active.limit : proposal.limit;
  const relaxations = active ? active.relaxations : proposal.relaxations;
  const weightDiff = active ? active.weightDiff : proposal.weightDiff;
  const canApprove = feasible && after != null && item.status !== "approved";

  return (
    <div className="flex flex-col rounded-xl border bg-card shadow-sm">
      {/* Header: identity + position + status */}
      <div className="flex items-start justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-base font-semibold">{proposal.name}</h3>
            <StatusBadge status={item.status} />
            {portfolioMode && (
              <Badge
                variant="outline"
                className="h-5 shrink-0 border-primary/30 bg-primary/10 px-1.5 text-[10px] text-primary"
              >
                System-targeted
              </Badge>
            )}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {formatCurrency(proposal.price)} · {proposal.cards.length} cards ·{" "}
            pack {index + 1} / {total}
          </p>
        </div>
        {active && (
          <Badge
            variant="outline"
            className="h-5 shrink-0 border-amber-500/30 bg-amber-500/15 px-1.5 text-[10px] text-amber-600 dark:text-amber-400"
          >
            Adjusted
          </Badge>
        )}
      </div>

      <div className="space-y-4 px-4 py-4">
        {/* Infeasible — structured limit (detail + suggestion), never a dead end */}
        {!feasible && (
          <div className="space-y-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2.5 text-xs">
            <div className="flex items-start gap-2 text-rose-600 dark:text-rose-400">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
              <div className="space-y-1">
                <p className="font-medium">
                  Can&apos;t retune this pack
                  {limit ? ` (${limit.kind})` : ""}
                </p>
                <p className="text-rose-600/90 dark:text-rose-400/90">
                  {limit?.detail ??
                    item.proposal.error ??
                    "This pool can't hit the requested targets."}
                </p>
              </div>
            </div>
            {limit?.suggestion && (
              <div className="flex items-start gap-2 rounded-md bg-rose-500/10 px-2 py-1.5 text-rose-700 dark:text-rose-300">
                <Info className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  <span className="font-medium">How to fix:</span> {limit.suggestion}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Relaxation banners — feasible-but-relaxed: friendly per-lever info */}
        {feasible && relaxations.length > 0 && (
          <div className="space-y-1.5">
            {relaxations.map((r, i) => (
              <div
                key={`${r.lever}-${i}`}
                className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
              >
                <Info className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  <span className="font-medium">
                    {LEVER_LABEL[r.lever] ?? r.lever} relaxed{" "}
                    {(r.requested * 100).toFixed(0)}% → {(r.applied * 100).toFixed(0)}%
                  </span>{" "}
                  — {relaxationHint(r.lever, proposal.price, r)}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* BEFORE → AFTER comparison (tile pairs) */}
        <BeforeAfter before={before} after={after} targetEdge={targetEdge} />

        {/* Top weight movers */}
        {feasible && weightDiff && weightDiff.length > 0 && (
          <TopMovers
            diff={weightDiff}
            cards={proposal.cards}
            price={proposal.price}
          />
        )}

        {/* Adjust panel */}
        {showAdjust && (
          <>
            <Separator />
            <div className="space-y-3">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label htmlFor={`adj-win-${proposal.packId}`} className="text-xs">
                    Win-rate
                  </Label>
                  <span className="text-xs font-medium tabular-nums">
                    {winRateNum}%
                  </span>
                </div>
                <Slider
                  id={`adj-win-${proposal.packId}`}
                  aria-label="Target win-rate"
                  value={winRateNum}
                  min={0}
                  max={60}
                  step={1}
                  onValueChange={(v) => setWinRatePct(String(v))}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor={`adj-cap-${proposal.packId}`} className="text-xs">
                    Max-win cap ($)
                  </Label>
                  <Input
                    id={`adj-cap-${proposal.packId}`}
                    type="number"
                    step="0.01"
                    value={maxWinCapUsd}
                    onChange={(e) => setMaxWinCapUsd(e.target.value)}
                    aria-invalid={maxWinCapUsd.trim() !== "" && maxWinCap == null}
                    className="h-8"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`adj-nm-${proposal.packId}`} className="text-xs">
                    Near-miss floor (%)
                  </Label>
                  <Input
                    id={`adj-nm-${proposal.packId}`}
                    type="number"
                    step="0.1"
                    value={nearMissPct}
                    onChange={(e) => setNearMissPct(e.target.value)}
                    aria-invalid={
                      nearMissMin == null || nearMissMin < 0 || nearMissMin >= 1
                    }
                    className="h-8"
                  />
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={applyAdjust}
                  disabled={!leversValid || applying}
                >
                  <SlidersHorizontal className="mr-1 size-3.5" />
                  Re-shape preview
                </Button>
                {active && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      onResetAdjust();
                      setWinRatePct((auto.targetWinRate * 100).toFixed(0));
                      setMaxWinCapUsd(String(auto.maxWinCap));
                      setNearMissPct((auto.nearMissMin * 100).toFixed(1));
                    }}
                    disabled={applying}
                  >
                    <RotateCcw className="mr-1 size-3.5" />
                    Reset to auto
                  </Button>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2 border-t px-4 py-3">
        <Button
          variant="outline"
          size="sm"
          onClick={onBack}
          disabled={index === 0 || applying}
        >
          <ChevronLeft className="mr-1 size-3.5" />
          Back
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowAdjust((s) => !s)}
          disabled={applying}
          aria-pressed={showAdjust}
        >
          <SlidersHorizontal className="mr-1 size-3.5" />
          Adjust
        </Button>
        <div className="ml-auto flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onDecline}
            disabled={applying}
            className="text-rose-600 hover:text-rose-600 dark:text-rose-400"
          >
            <X className="mr-1 size-3.5" />
            Decline
          </Button>
          <Button
            size="sm"
            onClick={onApprove}
            disabled={!canApprove || applying}
          >
            {applying ? (
              <Loader2 className="mr-1 size-3.5 animate-spin" />
            ) : (
              <Check className="mr-1 size-3.5" />
            )}
            Approve
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * A friendly, human hint for a relaxation, tailored per lever. Falls back to the
 * solver's own `reason` for anything not specially cased.
 */
function relaxationHint(
  lever: string,
  price: number,
  r: { reason: string },
): string {
  if (lever === "nearMiss") {
    const lo = (0.5 * price).toFixed(2);
    const hi = price.toFixed(2);
    return `this pool has no cards worth $${lo}–$${hi}; add a near-miss card in the Builder to enable it.`;
  }
  if (lever === "winRate") {
    return "the pool couldn't host the full win mass while keeping the house edge; the win-rate landed at the achievable value.";
  }
  if (lever === "floor") {
    return "no card met the floor pin, so the modal card falls out naturally.";
  }
  return r.reason;
}

function StatusBadge({ status }: { status: ReviewItem["status"] }) {
  if (status === "approved") {
    return (
      <Badge
        variant="outline"
        className="h-5 border-emerald-500/30 bg-emerald-500/15 px-1.5 text-[10px] text-emerald-600 dark:text-emerald-400"
      >
        Approved
      </Badge>
    );
  }
  if (status === "declined") {
    return (
      <Badge
        variant="outline"
        className="h-5 border-muted-foreground/30 bg-muted px-1.5 text-[10px] text-muted-foreground"
      >
        Declined
      </Badge>
    );
  }
  return null;
}

// ─── BEFORE → AFTER tile grid ─────────────────────────────────────────

/**
 * The headline BEFORE → AFTER diff, rendered as paired metric rows: each row
 * shows the before value, an arrow, and the after value (animated) with a
 * House-POV delta tint. Edge is the hero metric (a big tile pair); the rest are
 * compact rows. When `after` is null (genuinely infeasible) only the BEFORE
 * column shows — but a feasible-but-relaxed pack ALWAYS has an `after`.
 */
function BeforeAfter({
  before,
  after,
  targetEdge,
}: {
  before: PackRisk;
  after: PackRisk | null;
  targetEdge: number;
}) {
  return (
    <div className="space-y-3">
      {/* Hero: edge */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
        <EdgeTile label="Before" risk={before} targetEdge={targetEdge} />
        <div className="hidden items-center justify-center sm:flex">
          <ArrowRight className="size-5 text-muted-foreground" />
        </div>
        {after ? (
          <EdgeTile label="After" risk={after} targetEdge={targetEdge} animate />
        ) : (
          <div className="flex items-center justify-center rounded-xl border border-dashed bg-muted/20 px-3 py-4 text-center text-xs text-muted-foreground">
            No after — see the limit above
          </div>
        )}
      </div>

      {/* Compact metric diff rows */}
      <div className="rounded-lg border">
        <DiffRow
          term="Win rate"
          beforeVal={before.winRate}
          afterVal={after?.winRate ?? null}
          kind="pct"
          favour="player"
        />
        <DiffRow
          term="Near-miss"
          beforeVal={before.nearMiss}
          afterVal={after?.nearMiss ?? null}
          kind="pct"
        />
        <DiffRow
          term="Max win"
          beforeVal={before.maxWin}
          afterVal={after?.maxWin ?? null}
          kind="usd"
          favour="player"
        />
        <DiffRow
          term="Max mult"
          beforeVal={before.maxMult}
          afterVal={after?.maxMult ?? null}
          kind="mult"
          favour="player"
        />
        <DiffRow
          term="CV"
          beforeVal={before.cv}
          afterVal={after?.cv ?? null}
          kind="num2"
        />
        <DiffRow
          term="Risk"
          beforeVal={before.riskScore0to100}
          afterVal={after?.riskScore0to100 ?? null}
          kind="int"
        />
        <TierRow before={before.tier} after={after?.tier ?? null} />
      </div>
    </div>
  );
}

/** The hero edge tile — the headline house-margin number, big + animated. */
function EdgeTile({
  label,
  risk,
  targetEdge,
  animate,
}: {
  label: string;
  risk: PackRisk;
  targetEdge: number;
  animate?: boolean;
}) {
  // House-POV: edge ≥ target = healthy margin = emerald; below = rose.
  const healthy = risk.edge >= targetEdge;
  const tone = healthy
    ? "text-emerald-600 dark:text-emerald-400"
    : "text-rose-600 dark:text-rose-400";
  const bg = healthy
    ? "bg-emerald-500/10 border-emerald-500/20"
    : "bg-rose-500/10 border-rose-500/20";
  return (
    <div className={cn("rounded-xl border p-3", animate ? bg : "bg-muted/20")}>
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label} · house edge
      </p>
      <p className={cn("mt-1 text-2xl font-bold tracking-tight tabular-nums", tone)}>
        {animate ? (
          <AnimatedNumber value={risk.edge * 100} format="percent" />
        ) : (
          pct(risk.edge)
        )}
      </p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">
        target {(targetEdge * 100).toFixed(2)}%
      </p>
    </div>
  );
}

/**
 * One compact before→after diff row. House-POV tint on the AFTER value: for a
 * player-favouring metric (win-rate, max-win, max-mult) a RISE means the player
 * wins more = our cost up = rose; a fall = emerald. Neutral metrics (near-miss,
 * CV, risk) stay muted.
 */
function DiffRow({
  term,
  beforeVal,
  afterVal,
  kind,
  favour,
}: {
  term: string;
  beforeVal: number;
  afterVal: number | null;
  kind: "pct" | "usd" | "mult" | "num2" | "int";
  favour?: "player";
}) {
  const fmt = (v: number): string => {
    switch (kind) {
      case "pct":
        return `${(v * 100).toFixed(2)}%`;
      case "usd":
        return formatCurrency(v);
      case "mult":
        return `${formatNumber(v)}×`;
      case "num2":
        return v.toFixed(2);
      case "int":
        return String(Math.round(v));
    }
  };

  let tone = "text-foreground";
  if (afterVal != null && favour === "player") {
    const diff = afterVal - beforeVal;
    if (Math.abs(diff) > 1e-9) {
      tone = diff > 0
        ? "text-rose-600 dark:text-rose-400"
        : "text-emerald-600 dark:text-emerald-400";
    }
  }

  return (
    <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5 text-sm last:border-b-0">
      <span className="text-xs text-muted-foreground">{term}</span>
      <span className="flex items-center gap-1.5 tabular-nums">
        <span className="text-muted-foreground">{fmt(beforeVal)}</span>
        <ArrowRight className="size-3 text-muted-foreground" />
        {afterVal == null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span className={cn("font-medium", tone)}>{fmt(afterVal)}</span>
        )}
      </span>
    </div>
  );
}

/** Tier diff row — colored per the volatility tier (neutral, no player-favour). */
function TierRow({
  before,
  after,
}: {
  before: RiskTier;
  after: RiskTier | null;
}) {
  return (
    <div className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm">
      <span className="text-xs text-muted-foreground">Tier</span>
      <span className="flex items-center gap-1.5 tabular-nums">
        <span className={cn("font-medium", TIER_TONE[before])}>{before}</span>
        <ArrowRight className="size-3 text-muted-foreground" />
        {after == null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span className={cn("font-medium", TIER_TONE[after])}>{after}</span>
        )}
      </span>
    </div>
  );
}

/**
 * The top weight movers — the cards whose draw weight changes the most (by
 * absolute share of pool weight), so the operator sees at a glance where the
 * odds shifted without scrolling the full pool.
 *
 * House-POV tint: the share change is colored by whether it moves EV toward the
 * player, not by raw direction. A win card (value >= pack price) gaining weight
 * — or a floor card (value < price) losing weight — raises player EV = BAD for
 * the house → rose. The inverse (win card down, floor card up) lowers player EV
 * = GOOD for the house → emerald.
 */
function TopMovers({
  diff,
  cards,
  price,
}: {
  diff: { cardId: string; from: number; to: number }[];
  cards: { cardId: string; value: number }[];
  price: number;
}) {
  const valueById = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const c of cards) m.set(c.cardId, c.value);
    return m;
  }, [cards]);

  const fromTotal = diff.reduce((s, d) => s + d.from, 0) || 1;
  const toTotal = diff.reduce((s, d) => s + d.to, 0) || 1;

  const movers = React.useMemo(() => {
    return diff
      .map((d) => ({
        ...d,
        share: Math.abs(d.to / toTotal - d.from / fromTotal),
      }))
      .sort((a, b) => b.share - a.share)
      .slice(0, 5);
    // fromTotal/toTotal derived from diff; safe to depend on diff alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diff]);

  return (
    <div className="rounded-lg border">
      <p className="border-b px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        Top weight movers · {diff.length} cards change
      </p>
      <div className="divide-y">
        {movers.map((m) => {
          const v = valueById.get(m.cardId);
          const fromP = (m.from / fromTotal) * 100;
          const toP = (m.to / toTotal) * 100;
          const up = toP >= fromP;
          // House-POV: a win card (value >= price) gaining weight, or a floor
          // card (value < price) shedding weight, raises player EV = BAD for
          // us → rose. Otherwise the move lowers player EV → emerald. Cards of
          // unknown value fall back to raw direction (up = rose).
          const isWinCard = v != null ? v >= price : true;
          const playerFavorable = isWinCard === up;
          return (
            <div
              key={m.cardId}
              className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs"
            >
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {v != null ? formatCurrency(v) : "—"}
              </span>
              <span className="flex items-center gap-1.5 tabular-nums">
                <span className="text-muted-foreground">{fromP.toFixed(2)}%</span>
                <ArrowRight className="size-3 text-muted-foreground" />
                <span
                  className={cn(
                    "font-medium",
                    playerFavorable
                      ? "text-rose-600 dark:text-rose-400"
                      : "text-emerald-600 dark:text-emerald-400",
                  )}
                >
                  {toP.toFixed(2)}%
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
