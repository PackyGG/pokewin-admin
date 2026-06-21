"use client";

import * as React from "react";
import {
  ArrowRight,
  Check,
  ChevronLeft,
  Loader2,
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
 * House-POV coloring (CLAUDE.md): a healthy house edge (≥ target) reads emerald;
 * a low edge (house giving away margin) reads rose. A rising win-rate / max-win
 * means the PLAYER wins more (our cost up) so the "after" tints rose when it
 * climbs; a falling one tints emerald. Neutral facts (CV, tier, near-miss) stay
 * muted.
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
  const error = active ? active.error : proposal.error;
  const weightDiff = active ? active.weightDiff : proposal.weightDiff;
  const canApprove = feasible && after != null && item.status !== "approved";

  return (
    <div className="flex flex-col rounded-xl border bg-card shadow-sm">
      {/* Header: identity + position + status */}
      <div className="flex items-start justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-base font-semibold">{proposal.name}</h3>
            <StatusBadge status={item.status} />
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
        {/* Infeasible banner */}
        {!feasible && (
          <div className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-400">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>
              <span className="font-medium">Infeasible:</span>{" "}
              {error ?? "This pool can't hit the requested targets."} Decline it,
              or Adjust the levers to find a feasible target.
            </span>
          </div>
        )}

        {/* BEFORE → AFTER comparison */}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_1fr] sm:items-stretch">
          <RiskColumn label="Before" risk={before} targetEdge={targetEdge} />
          <div className="hidden items-center justify-center sm:flex">
            <ArrowRight className="size-5 text-muted-foreground" />
          </div>
          <RiskColumn
            label="After"
            risk={after}
            targetEdge={targetEdge}
            compareTo={before}
            highlight
          />
        </div>

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

/**
 * A column of risk stats (edge / win-rate / near-miss / max-win / max-mult / CV /
 * tier). The "after" column tints each row by direction vs. the before column,
 * House-POV: edge up = emerald, edge down = rose; win-rate / max-win up = rose
 * (player wins more = our cost up), down = emerald.
 */
function RiskColumn({
  label,
  risk,
  targetEdge,
  compareTo,
  highlight,
}: {
  label: string;
  risk: PackRisk | null;
  targetEdge: number;
  compareTo?: PackRisk;
  highlight?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border p-3",
        highlight ? "bg-muted/30" : "bg-muted/10",
      )}
    >
      <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      {risk == null ? (
        <p className="py-6 text-center text-xs text-muted-foreground">
          No feasible result
        </p>
      ) : (
        <dl className="space-y-1.5">
          <Stat
            term="Edge"
            value={pct(risk.edge)}
            tone={risk.edge >= targetEdge ? "emerald" : "rose"}
          />
          <Stat
            term="Win rate"
            value={pct(risk.winRate)}
            tone={
              compareTo ? dirTone(risk.winRate, compareTo.winRate, "player") : undefined
            }
          />
          <Stat term="Near-miss" value={pct(risk.nearMiss)} />
          <Stat
            term="Max win"
            value={formatCurrency(risk.maxWin)}
            tone={
              compareTo ? dirTone(risk.maxWin, compareTo.maxWin, "player") : undefined
            }
          />
          <Stat term="Max mult" value={`${formatNumber(risk.maxMult)}×`} />
          <Stat term="CV" value={risk.cv.toFixed(2)} />
          <Stat
            term="Risk"
            value={String(risk.riskScore0to100)}
          />
          <Stat
            term="Tier"
            value={risk.tier}
            toneClass={TIER_TONE[risk.tier]}
          />
        </dl>
      )}
    </div>
  );
}

/**
 * Direction tone for a player-favouring metric (win-rate, max-win): a higher
 * value means the player wins more = OUR cost up = rose; lower = emerald.
 */
function dirTone(
  next: number,
  prev: number,
  favour: "player",
): "emerald" | "rose" | undefined {
  void favour;
  if (Math.abs(next - prev) < 1e-9) return undefined;
  return next > prev ? "rose" : "emerald";
}

function Stat({
  term,
  value,
  tone,
  toneClass,
}: {
  term: string;
  value: string;
  tone?: "emerald" | "rose";
  toneClass?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-xs text-muted-foreground">{term}</dt>
      <dd
        className={cn(
          "text-sm font-medium tabular-nums",
          tone === "emerald" && "text-emerald-600 dark:text-emerald-400",
          tone === "rose" && "text-rose-600 dark:text-rose-400",
          toneClass,
        )}
      >
        {value}
      </dd>
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
