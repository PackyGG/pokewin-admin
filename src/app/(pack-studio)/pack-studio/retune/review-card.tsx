"use client";

import * as React from "react";
import {
  Activity,
  ArrowRight,
  Check,
  ChevronLeft,
  Gauge,
  Info,
  Layers,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
  Target,
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
import { SectionHeading } from "@/components/modern-panels";
import { InfoHint } from "@/app/(admin)/creators/_components/info-hint";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import {
  computePackRisk,
  shapeWeights,
  type PackRisk,
  type RiskTier,
} from "@/app/(admin)/insights/edge-calc/risk";
import { DEFAULT_MAX_MULT_CEILING } from "@/app/(admin)/packs/_lib/auto-targets";

import type { EditApprovePayload, ReviewItem } from "./retune-review";
import { PoolEditor, type EditorTargets } from "./pool-editor";
import { formatDeltaPp, formatPercent } from "./format-percent";

/**
 * The single review card — ONE pack's full BEFORE→AFTER comparison. A complete
 * redesign for readability: a tagged-hit-rate header (the leading `X%` in a
 * pack's name is its INTENDED win/profit rate — "1% 18 PLUS" means ~1% of opens
 * hit a profit card, NOT 20%), a big house-edge comparison, a PROMINENT risk
 * profile panel (risk score gauge + CV + tier, each explained), explained key
 * metrics with per-row tooltips, and the FULL list of every card's weight change
 * (no "top 5" truncation). The inline Adjust panel + Approve / Decline / Back
 * controls live in this card's footer; the parent (`retune-review.tsx`) wraps the
 * stack in a generously-padded scroll container so the sticky progress bar never
 * crowds the content. This card focuses on EXPLAINING the proposed retune.
 *
 * House-POV coloring (CLAUDE.md): a healthy house edge (≥ target) reads emerald;
 * a low edge (house giving away margin) reads rose. A rising win-rate / max-win
 * means the PLAYER wins more (our cost up) so it tints rose when it climbs;
 * falling tints emerald. Neutral facts (CV, tier, near-miss, risk score) stay
 * tier/severity-colored. Numbers animate via the serializable-`formatKind`
 * `AnimatedNumber` (NO function props cross the RSC boundary).
 */

function pct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(2)}%`;
}

/**
 * Render a `{ min, max }` USD range for the "+ Add a card in $X–$Y" button.
 * Mirrors `formatCurrency`'s decimal style without forcing the symbol twice
 * (`$1.25–$6.25`). A `min` of 0 collapses to "$0–$Y" rather than printing
 * "$0.00–$Y" so the bound for ev-too-low / no-dust hints reads naturally.
 */
function formatRange(range: { min: number; max: number }): string {
  const lo =
    range.min <= 0 ? "$0" : formatCurrency(range.min);
  const hi = formatCurrency(range.max);
  return `${lo}–${hi}`;
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

const TIER_BG: Record<RiskTier, string> = {
  T1: "border-emerald-500/30 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  T2: "border-emerald-500/30 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  T3: "border-amber-500/30 bg-amber-500/15 text-amber-600 dark:text-amber-400",
  T4: "border-orange-500/30 bg-orange-500/15 text-orange-600 dark:text-orange-400",
  T5: "border-rose-500/30 bg-rose-500/15 text-rose-600 dark:text-rose-400",
};

/** Plain-English one-liner describing what a volatility tier means. */
const TIER_BLURB: Record<RiskTier, string> = {
  T1: "very calm — steady, low-swing payouts",
  T2: "calm — modest payout swings",
  T3: "medium — noticeable payout swings",
  T4: "lottery-leaning — swingy, jackpot-driven payouts",
  T5: "lottery — extreme swings, rare big hits",
};

/** Severity word + tone + bar color for a 0–100 risk score. */
function riskSeverity(score: number): {
  word: string;
  tone: string;
  bar: string;
} {
  if (score < 25)
    return {
      word: "low",
      tone: "text-emerald-600 dark:text-emerald-400",
      bar: "bg-emerald-500",
    };
  if (score < 50)
    return {
      word: "moderate",
      tone: "text-amber-600 dark:text-amber-400",
      bar: "bg-amber-500",
    };
  if (score < 70)
    return {
      word: "elevated",
      tone: "text-orange-600 dark:text-orange-400",
      bar: "bg-orange-500",
    };
  return {
    word: "high",
    tone: "text-rose-600 dark:text-rose-400",
    bar: "bg-rose-500",
  };
}

/**
 * Best-effort hypothetical "After" risk when the authoritative re-shape is
 * infeasible. The owner wants to SEE the number even when retune is blocked —
 * not "No after". Strategy: re-run the shaper with the soft levers fully
 * relaxed (win-rate tolerance opened to 100%, near-miss floor dropped to 0)
 * so the only HARD failures left are the truly impossible cases (empty pool,
 * no win cards, EV genuinely outside the pool's value range). When even that
 * fails, returns null and the UI falls back to the clearer "Infeasible at
 * current pool — fix limit above to compute" text.
 *
 * This NEVER affects the authoritative `feasible` / `after` carried by the
 * proposal — it's a display-only preview, badged "infeasible — preview only"
 * in the UI to make the relaxation visible. The actual approve path still
 * uses the strict server-side `shapeWeights` + asserts.
 */
function hypotheticalAfter(
  cards: { value: number; weight: number }[],
  price: number,
  targets: {
    targetEdge: number;
    targetWinRate: number;
    maxWinCap: number | undefined;
  },
): PackRisk | null {
  const shaped = shapeWeights({
    cards: cards.map((c) => ({ value: c.value })),
    price,
    targetEdge: targets.targetEdge,
    targetWinRate: targets.targetWinRate,
    maxWinCap: targets.maxWinCap,
    // Drop the soft levers entirely so only HARD limits can block the preview.
    nearMissMin: 0,
    winRateTol: 1,
  });
  if ("error" in shaped) return null;
  return computePackRisk({
    cards: cards.map((c, i) => ({
      value: c.value,
      weight: shaped.weights[i]!,
    })),
    price,
  });
}

/** Plain-English one-liner for a coefficient-of-variation value. */
function cvBlurb(cv: number): string {
  if (cv < 1.4) return "steady payouts";
  if (cv < 3) return "mild swings";
  if (cv < 6) return "swingy payouts";
  if (cv < 12) return "very swingy payouts";
  return "extreme, jackpot-driven swings";
}

export function ReviewCard({
  item,
  index,
  total,
  applying,
  portfolioMode,
  editorTargets,
  editing,
  onApprove,
  onDecline,
  onBack,
  onAdjust,
  onResetAdjust,
  onOpenEditor,
  onCloseEditor,
  onApplyEdit,
  onReload,
  reloadPending,
}: {
  item: ReviewItem;
  index: number;
  total: number;
  applying: boolean;
  /** True when system-balance mode is on (proposals are portfolio-targeted). */
  portfolioMode: boolean;
  /** Targets the inline pool editor's "Re-shape to targets" shapes onto. */
  editorTargets: EditorTargets;
  /** True when this card's inline pool editor is open. */
  editing: boolean;
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
  /** Open / close the inline card-pool editor. */
  onOpenEditor: () => void;
  onCloseEditor: () => void;
  /** Approve an explicit edited pool (writes via `applyPackEdit`). */
  onApplyEdit: (payload: EditApprovePayload) => void;
  /** Re-fetch the server proposals (clears the infeasibility banner if the
   *  operator's edits resolved the limit). Triggered manually via the
   *  "Recheck pool" button on the error AND automatically when the editor's
   *  card picker closes after cards were added during the session. */
  onReload: () => void;
  /** True while a `onReload` re-fetch is in-flight (drives the spinner). */
  reloadPending: boolean;
}) {
  const [showAdjust, setShowAdjust] = React.useState(false);

  // Programmatic control over the inline pool editor's BuilderCardPicker. The
  // "+ Add a card in $X–$Y range" button below the infeasibility error opens
  // the editor (if not already open) AND the picker, with the suggested range
  // pre-filled. `pendingPickerRange` is the range we want the picker to show;
  // we apply it on the open transition rather than continuously, so the owner
  // can edit the Min/Max filter once it's open without us clobbering them.
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [pickerRange, setPickerRange] = React.useState<
    { min: number; max: number } | null
  >(null);

  // Reset the picker control when the card changes (a new pack).
  React.useEffect(() => {
    setPickerOpen(false);
    setPickerRange(null);
  }, [item.proposal.packId]);

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

  /**
   * One-click handler for the "Add a card in $X–$Y range" button on the
   * infeasibility error. Opens the inline pool editor (if not already open)
   * AND the card picker, with the suggested range pre-filled. The pool editor
   * then forwards the range to `<BuilderCardPicker initialPriceMin/Max>` and
   * the controlled `open` flag, so the dialog opens straight into a filtered
   * list of candidates — no manual range entry by the owner.
   */
  function openPickerWithRange(range: { min: number; max: number }) {
    setPickerRange(range);
    if (!editing) onOpenEditor();
    setPickerOpen(true);
  }

  // Apply the CURRENT field values to a fresh local re-shape.
  function applyAdjust() {
    if (!leversValid) return;
    onAdjust({
      targetWinRate: winRate!,
      maxWinCap: maxWinCap ?? undefined,
      nearMissMin: nearMissMin!,
    });
  }

  const { proposal } = item;
  const targetEdge = proposal.autoTargets.targetEdge;
  const targetWinRate = proposal.autoTargets.targetWinRate;
  const intendedHitRate = proposal.intendedHitRate;
  const isTagged = intendedHitRate != null;
  // Lottery-tagged packs (≤10% hit-rate, e.g. "1% 18 PLUS") are binary by
  // design — jackpot or dust — and have no meaningful near-miss tier. Mirrors
  // the `isLotteryTag` predicate in `packs/_lib/portfolio.ts` that skips the
  // win-rate nudge for the same reason. We hide the "Near-miss relaxed" banner
  // for these packs because relaxing to 0 is expected behavior, not noise.
  const isLotteryTag = intendedHitRate !== null && intendedHitRate <= 0.10;

  const before = proposal.before;
  // The active "after": a local adjustment supersedes the server proposal.
  const after = active ? active.after : proposal.after;
  const feasible = active ? active.feasible : proposal.feasible;
  const limit = active ? active.limit : proposal.limit;
  const rawRelaxations = active ? active.relaxations : proposal.relaxations;
  // Drop the near-miss banner entirely on lottery-tagged packs (see comment
  // above on `isLotteryTag`). Other levers (winRate, floor) still surface.
  const relaxations = isLotteryTag
    ? rawRelaxations.filter((r) => r.lever !== "nearMiss")
    : rawRelaxations;
  const weightDiff = active ? active.weightDiff : proposal.weightDiff;
  const canApprove = feasible && after != null && item.status !== "approved";

  // Display-only hypothetical preview when the strict retune is infeasible —
  // re-shape with the soft levers fully relaxed so the owner sees a number
  // rather than "No after". Falls through to null (clearer text in EdgeCompare)
  // when even the relaxed shape can't run. Memoized on the inputs that drive
  // it; not in scope when `after` is non-null (the authoritative number wins).
  const hypotheticalActiveWinRate =
    active?.targetWinRate ?? proposal.autoTargets.targetWinRate;
  const hypothetical = React.useMemo<PackRisk | null>(() => {
    if (after != null) return null;
    return hypotheticalAfter(
      proposal.cards.map((c) => ({ value: c.value, weight: c.weight })),
      proposal.price,
      {
        targetEdge,
        targetWinRate: hypotheticalActiveWinRate,
        maxWinCap: active?.maxWinCap ?? proposal.autoTargets.maxWinCap,
      },
    );
  }, [
    after,
    proposal.cards,
    proposal.price,
    proposal.autoTargets.maxWinCap,
    targetEdge,
    hypotheticalActiveWinRate,
    active?.maxWinCap,
  ]);

  return (
    <div className="flex flex-col rounded-xl border bg-card shadow-sm">
      {/* ── Header: identity + tag + plain-English summary ───────────── */}
      <div className="space-y-2.5 border-b px-4 py-3.5 sm:px-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate text-base font-semibold sm:text-lg">
                {proposal.name}
              </h3>
              <StatusBadge status={item.status} />
              {active && (
                <Badge
                  variant="outline"
                  className="h-5 shrink-0 border-amber-500/30 bg-amber-500/15 px-1.5 text-[10px] text-amber-600 dark:text-amber-400"
                >
                  Adjusted
                </Badge>
              )}
              {portfolioMode && (
                <Badge
                  variant="outline"
                  className="h-5 shrink-0 border-primary/30 bg-primary/10 px-1.5 text-[10px] text-primary"
                >
                  System-targeted
                </Badge>
              )}
            </div>
            {/* Tag chip — the intended hit-rate parsed from the pack name. */}
            <TagChip
              intendedHitRate={intendedHitRate}
              targetWinRate={targetWinRate}
            />
          </div>
          <div className="shrink-0 text-right text-xs text-muted-foreground">
            <p className="font-medium tabular-nums text-foreground">
              {formatCurrency(proposal.price)}
            </p>
            <p className="tabular-nums">{proposal.cards.length} cards</p>
            <p className="tabular-nums">
              {index + 1} / {total}
            </p>
          </div>
        </div>
        {/* Lottery-pack explainer: visible whenever a tagged pack has a hit-rate
            ≤ 10% (1% / 5% / 10%). Makes the auto-retune's intentional jackpot
            preservation visible to the owner — what was loosened, why, and how
            to change it — rather than silently keeping a huge top card. */}
        <LotteryAcknowledgment
          intendedHitRate={intendedHitRate}
          price={proposal.price}
          actualCap={proposal.autoTargets.maxWinCap}
          maxWin={(after ?? before).maxWin}
        />
        {/* One plain-English line describing the pack + what we're targeting. */}
        <p className="text-xs leading-relaxed text-muted-foreground">
          {describePack({
            isTagged,
            intendedHitRate,
            targetWinRate,
            targetEdge,
          })}
        </p>
      </div>

      <div className="space-y-5 px-4 py-5 sm:px-5">
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
                  <span className="font-medium">How to fix:</span>{" "}
                  {limit.suggestion}
                </span>
              </div>
            )}
            {/* One-click "Add a card in $X–$Y range" — only shows when the
                limit carries an explicit `suggestedRange` (no-win-cards,
                no-win-band-card, ev-out-of-range, no-dust-cards). Opens the
                pool editor + the card picker pre-filtered to the band, so the
                owner doesn't have to parse the suggestion text and re-enter
                the range by hand. House-POV emerald: actively fixing the
                infeasibility is the healthy direction (out of the rose-tinted
                "can't retune" state into a feasible pool). */}
            {limit?.suggestedRange && (
              <Button
                size="sm"
                onClick={() => openPickerWithRange(limit.suggestedRange!)}
                disabled={applying}
                className="mt-0.5 bg-emerald-600 text-white hover:bg-emerald-600/90 dark:bg-emerald-600 dark:hover:bg-emerald-600/90"
              >
                <Plus className="mr-1 size-3.5" />
                Add a card in {formatRange(limit.suggestedRange)} range
              </Button>
            )}
            {/* Never a dead end — open the editor to add a card ≥ price / fix
                the pool right here. */}
            {!editing && !limit?.suggestedRange && (
              <Button
                size="sm"
                onClick={onOpenEditor}
                disabled={applying}
                className="mt-0.5"
              >
                <Pencil className="mr-1 size-3.5" />
                Edit pool / add a card ≥ {formatCurrency(proposal.price)}
              </Button>
            )}
            {/* Manual re-check — re-runs the server `planAllRetunes` dry-run so
                the infeasibility banner reflects the latest live pool. Useful
                after the operator added cards via the popup but the page
                hasn't auto-refreshed (e.g. the picker close handler didn't
                fire, or the operator wants to force a fresh evaluation). */}
            <Button
              variant="outline"
              size="sm"
              onClick={onReload}
              disabled={reloadPending || applying}
              className="mt-0.5"
              aria-label="Recheck pool"
            >
              {reloadPending ? (
                <Loader2 className="mr-1 size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-1 size-3.5" />
              )}
              {reloadPending ? "Re-checking…" : "Recheck pool"}
            </Button>
          </div>
        )}

        {/* Relaxation banners — feasible-but-relaxed: friendly per-lever info.
            Tagged packs no longer spuriously relax win-rate, so this only shows
            a banner when a soft target was GENUINELY loosened. */}
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
                    {(r.requested * 100).toFixed(r.lever === "winRate" ? 2 : 0)}%
                    → {(r.applied * 100).toFixed(r.lever === "winRate" ? 2 : 0)}%
                  </span>{" "}
                  — {relaxationHint(r.lever, proposal.price, r)}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* ── House edge: the headline BEFORE → AFTER ─────────────────── */}
        <section className="space-y-3">
          <SectionHeading
            icon={Target}
            title={
              <span className="flex items-center gap-1.5">
                House edge
                <InfoHint text="The house's margin per open: 1 − (expected payout ÷ price). Higher = the house keeps more. Each pack has its own target — a 10.99% floor plus a small risk premium for pricier / jackpot-heavy packs. Emerald = at or above target (good for you); rose = below target (you're giving away margin)." />
              </span>
            }
          />
          <EdgeCompare
            before={before}
            after={after}
            hypothetical={hypothetical}
            targetEdge={targetEdge}
          />
        </section>

        {/* ── Risk profile: the "new risk system", made unmissable ────── */}
        <section className="space-y-3">
          <SectionHeading
            icon={ShieldAlert}
            title={
              <span className="flex items-center gap-1.5">
                Risk profile
                <InfoHint text="How swingy this pack's payouts are. Driven mostly by the coefficient of variation (CV) — the spread of payouts relative to the average — plus how big the top jackpot is. The score buckets into tiers T1 (calm) → T5 (lottery)." />
              </span>
            }
          />
          <RiskProfile
            before={before}
            after={after}
            price={proposal.price}
            intendedHitRate={intendedHitRate}
          />
        </section>

        {/* ── Key metrics: explained before→after rows ───────────────── */}
        <section className="space-y-3">
          <SectionHeading
            icon={Activity}
            title={
              <span className="flex items-center gap-1.5">
                Key metrics
                <InfoHint text="The play-feel levers. Hover any row's info icon for what it means and which way is good for the house." />
              </span>
            }
          />
          <KeyMetrics
            before={before}
            after={after}
            intendedHitRate={intendedHitRate}
            targetWinRate={targetWinRate}
          />
        </section>

        {/* ── All card weight changes (no truncation) ────────────────── */}
        <section className="space-y-3">
          <SectionHeading
            icon={Layers}
            title={
              <span className="flex items-center gap-1.5">
                Card weight changes
                <InfoHint text="Every card's draw probability, before → after. The probability is the card's weight divided by the pool's total weight. Sorted by the biggest move. Rose = the change makes the player win more (worse for the house); emerald = better for the house." />
              </span>
            }
          />
          {feasible && after != null ? (
            <AllCardChanges
              cards={proposal.cards}
              weightDiff={weightDiff}
              price={proposal.price}
            />
          ) : (
            <p className="rounded-lg border border-dashed bg-muted/20 px-3 py-4 text-center text-xs text-muted-foreground">
              No weight changes to show — this pack is infeasible (see the limit
              above).
            </p>
          )}
        </section>

        {/* ── Adjust panel (inline) ──────────────────────────────────── */}
        {showAdjust && (
          <>
            <Separator />
            <section className="space-y-3">
              <SectionHeading icon={SlidersHorizontal} title="Adjust targets" />
              <div className="space-y-3 rounded-lg border bg-muted/10 p-3">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label
                      htmlFor={`adj-win-${proposal.packId}`}
                      className="flex items-center gap-1.5 text-xs"
                    >
                      Win-rate
                      <InfoHint text="The share of opens that hit a profit card (value ≥ price). For a tagged pack this should match the pack tag." />
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
                    <Label
                      htmlFor={`adj-cap-${proposal.packId}`}
                      className="flex items-center gap-1.5 text-xs"
                    >
                      Max-win cap ($)
                      <InfoHint text="Drop any card worth more than this. Lowers the jackpot ceiling and the house's worst-case exposure." />
                    </Label>
                    <Input
                      id={`adj-cap-${proposal.packId}`}
                      type="number"
                      step="0.01"
                      value={maxWinCapUsd}
                      onChange={(e) => setMaxWinCapUsd(e.target.value)}
                      aria-invalid={
                        maxWinCapUsd.trim() !== "" && maxWinCap == null
                      }
                      className="h-8"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label
                      htmlFor={`adj-nm-${proposal.packId}`}
                      className="flex items-center gap-1.5 text-xs"
                    >
                      Near-miss floor (%)
                      <InfoHint text="Minimum share of opens that land just below the price (a 'so close' outcome). A feel dial — keeps the pack from feeling dead." />
                    </Label>
                    <Input
                      id={`adj-nm-${proposal.packId}`}
                      type="number"
                      step="0.1"
                      value={nearMissPct}
                      onChange={(e) => setNearMissPct(e.target.value)}
                      aria-invalid={
                        nearMissMin == null ||
                        nearMissMin < 0 ||
                        nearMissMin >= 1
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
            </section>
          </>
        )}

        {/* ── Edit pool (inline card-pool editor) ────────────────────── */}
        {editing && (
          <>
            <Separator />
            <section className="space-y-3">
              <SectionHeading
                icon={Pencil}
                title={
                  <span className="flex items-center gap-1.5">
                    Edit pool
                    <InfoHint text="Edit this pack's card pool by hand — re-weight, remove, reorder, or add cards — with a live after-preview. Approving here writes the EXACT pool shown (history-snapshotted) instead of an auto re-shape." />
                  </span>
                }
              />
              <PoolEditor
                packId={proposal.packId}
                price={proposal.price}
                targets={editorTargets}
                applying={applying}
                onCancel={onCloseEditor}
                onApprove={onApplyEdit}
                onApproveAutoTune={onApplyEdit}
                pickerOpen={pickerOpen}
                onPickerOpenChange={setPickerOpen}
                pickerInitialPriceMin={pickerRange?.min}
                pickerInitialPriceMax={pickerRange?.max}
                onCardsAdded={onReload}
              />
            </section>
          </>
        )}

        {/* ── Legend / glossary ──────────────────────────────────────── */}
        <Legend />
      </div>

      {/* ── Card-local controls (Back / Adjust / Decline / Approve) ──── */}
      <div className="flex flex-wrap items-center gap-2 border-t px-4 py-3 sm:px-5">
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
          {showAdjust ? "Hide adjust" : "Adjust"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={editing ? onCloseEditor : onOpenEditor}
          disabled={applying}
          aria-pressed={editing}
        >
          <Pencil className="mr-1 size-3.5" />
          {editing ? "Hide editor" : "Edit pool"}
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

// ─── Tag chip + pack description ──────────────────────────────────────

/**
 * The pack's intended-hit-rate tag. A pack whose NAME starts with a percentage
 * is a TAGGED hit-rate pack: the leading X% is the designed gold/profit hit
 * rate. Tagged → a clear chip ("1% pack — top 1% is the gold / profit hit");
 * untagged → a muted "standard pack" chip naming the default win-rate.
 */
function TagChip({
  intendedHitRate,
  targetWinRate,
}: {
  intendedHitRate: number | null;
  targetWinRate: number;
}) {
  if (intendedHitRate != null) {
    const tagPct = (intendedHitRate * 100).toFixed(
      intendedHitRate < 0.01 ? 2 : 0,
    );
    return (
      <Badge
        variant="outline"
        className="h-6 gap-1.5 border-purple-500/30 bg-purple-500/10 px-2 text-[11px] font-medium text-purple-600 dark:text-purple-400"
      >
        <Sparkles className="size-3" />
        {tagPct}% pack — top {tagPct}% is the gold / profit hit
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="h-6 gap-1.5 border-muted-foreground/20 bg-muted/40 px-2 text-[11px] font-medium text-muted-foreground"
    >
      <Target className="size-3" />
      Standard pack — default {(targetWinRate * 100).toFixed(0)}% win-rate
    </Badge>
  );
}

/**
 * The lottery-pack acknowledgment panel — only renders for a TAGGED pack with a
 * hit-rate ≤ 10% (1% / 5% / 10% packs). Makes the auto-retune's intentional
 * jackpot preservation visible to the owner: the leading `X%` tag in the pack
 * name is what tells the tool to LOOSEN the max-win cap so the big top card
 * survives the shaper (a low hit-rate needs a big jackpot to hold ~11% edge —
 * the math requires it). Without this panel the tool silently keeps the
 * jackpot; with it the owner can see the recognition + the loosened cap + the
 * top card it preserved, and how to revert if they want a normal pack.
 *
 * House-POV: emerald — preserving the lottery-style jackpot is the INTENDED
 * design (not a warning), matching the existing colour rule for "good for the
 * house / acting as designed".
 */
function LotteryAcknowledgment({
  intendedHitRate,
  price,
  actualCap,
  maxWin,
}: {
  intendedHitRate: number | null;
  price: number;
  /** The hit-rate-aware cap from `autoMaxWinCap(price, cfg, hitRate)`. */
  actualCap: number;
  /** The pack's actual top card value (max-win), before or after shaping. */
  maxWin: number;
}) {
  if (intendedHitRate == null || intendedHitRate > 0.10) return null;
  const tagPct = (intendedHitRate * 100).toFixed(
    intendedHitRate < 0.01 ? 2 : 0,
  );
  // Baseline cap = price × 100× (the untagged default, `DEFAULT_MAX_MULT_CEILING`).
  const baselineCap = price * DEFAULT_MAX_MULT_CEILING;
  const loosened = actualCap > baselineCap + 1e-6;
  return (
    <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5 text-xs text-emerald-700 dark:text-emerald-400">
      <div className="flex items-start gap-2">
        <Sparkles className="mt-0.5 size-3.5 shrink-0" />
        <div className="min-w-0 space-y-1.5">
          <p className="font-semibold">
            Lottery pack detected — jackpot preserved
          </p>
          <p className="leading-relaxed">
            Name tag <span className="font-medium">{tagPct}%</span> → tool keeps
            the max-win cap loosened to allow your top card.
          </p>
          <p className="leading-relaxed tabular-nums">
            {loosened ? (
              <>
                Baseline cap (untagged):{" "}
                <span className="font-medium">{formatCurrency(baselineCap)}</span>{" "}
                · Lottery cap (in use):{" "}
                <span className="font-medium">{formatCurrency(actualCap)}</span>{" "}
                · Top card kept:{" "}
                <span className="font-medium">{formatCurrency(maxWin)}</span>
              </>
            ) : (
              <>
                Cap unchanged (already permissive enough): baseline{" "}
                <span className="font-medium">{formatCurrency(baselineCap)}</span>{" "}
                = lottery cap{" "}
                <span className="font-medium">{formatCurrency(actualCap)}</span>{" "}
                · Top card kept:{" "}
                <span className="font-medium">{formatCurrency(maxWin)}</span>
              </>
            )}
          </p>
          <p className="leading-relaxed">
            A <span className="font-medium">{tagPct}%</span> win-rate needs a big
            jackpot to hit ~11% edge — math requires it. Without the loosened cap
            this pack would go infeasible.
          </p>
          <p className="text-[11px] leading-relaxed text-emerald-700/80 dark:text-emerald-400/80">
            To make it a normal pack: remove the{" "}
            <span className="font-medium">{tagPct}%</span> from the name. To pick
            a custom max-win: edit the cap in the pack edit form.
          </p>
        </div>
      </div>
    </div>
  );
}

/** The one plain-English line under the header. */
function describePack({
  isTagged,
  intendedHitRate,
  targetWinRate,
  targetEdge,
}: {
  isTagged: boolean;
  intendedHitRate: number | null;
  targetWinRate: number;
  targetEdge: number;
}): string {
  const edgeStr = `${(targetEdge * 100).toFixed(2)}% house edge`;
  if (isTagged && intendedHitRate != null) {
    const tagStr = (intendedHitRate * 100).toFixed(
      intendedHitRate < 0.01 ? 2 : 0,
    );
    const flavour =
      intendedHitRate <= 0.02
        ? "Lottery-style"
        : intendedHitRate <= 0.1
          ? "Spicy"
          : "Frequent-hit";
    return `${flavour}: ~${tagStr}% of opens hit a profit card. Targeting a ${tagStr}% win-rate at ${edgeStr} — matching the pack tag.`;
  }
  return `Standard pack: targeting the default ${(targetWinRate * 100).toFixed(0)}% win-rate at ${edgeStr}.`;
}

// ─── House edge BEFORE → AFTER ────────────────────────────────────────

function EdgeCompare({
  before,
  after,
  hypothetical,
  targetEdge,
}: {
  before: PackRisk;
  after: PackRisk | null;
  /**
   * Best-effort "After" computed with the soft levers fully relaxed
   * (`hypotheticalAfter`). Used ONLY when `after` is null — gives the owner a
   * preview number to look at instead of "No after". Display-only; the
   * authoritative `after` + `feasible` are unchanged.
   */
  hypothetical: PackRisk | null;
  targetEdge: number;
}) {
  return (
    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-[1fr_auto_1fr] sm:items-stretch">
      <EdgeTile label="Before" risk={before} targetEdge={targetEdge} />
      <div className="hidden items-center justify-center sm:flex">
        <ArrowRight className="size-5 text-muted-foreground" />
      </div>
      {after ? (
        <EdgeTile label="After" risk={after} targetEdge={targetEdge} animate />
      ) : hypothetical ? (
        <EdgeTile
          label="After"
          risk={hypothetical}
          targetEdge={targetEdge}
          animate
          previewBadge
        />
      ) : (
        <div className="flex items-center justify-center rounded-xl border border-dashed bg-muted/20 px-3 py-6 text-center text-xs text-muted-foreground">
          Infeasible at current pool — fix limit above to compute
        </div>
      )}
    </div>
  );
}

/** The hero edge tile — the headline house-margin number, big + animated. */
function EdgeTile({
  label,
  risk,
  targetEdge,
  animate,
  previewBadge,
}: {
  label: string;
  risk: PackRisk;
  targetEdge: number;
  animate?: boolean;
  /**
   * When true, the tile carries a small "infeasible — preview only" badge.
   * Used for the hypothetical-after fallback so the owner can see a number
   * while still knowing the strict retune path is blocked (see the limit
   * banner above) and the displayed value is from a relaxed shape.
   */
  previewBadge?: boolean;
}) {
  // House-POV: edge ≥ target = healthy margin = emerald; below = rose.
  const healthy = risk.edge >= targetEdge - 1e-9;
  const tone = healthy
    ? "text-emerald-600 dark:text-emerald-400"
    : "text-rose-600 dark:text-rose-400";
  const bg = animate
    ? healthy
      ? "bg-emerald-500/10 border-emerald-500/25"
      : "bg-rose-500/10 border-rose-500/25"
    : "bg-muted/20";
  return (
    <div className={cn("rounded-xl border p-3.5", bg)}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {label} · house edge
        </p>
        {previewBadge && (
          <Badge
            variant="outline"
            className="h-5 shrink-0 border-amber-500/30 bg-amber-500/15 px-1.5 text-[10px] text-amber-600 dark:text-amber-400"
          >
            infeasible — preview only
          </Badge>
        )}
      </div>
      <p
        className={cn(
          "mt-1 text-3xl font-bold tracking-tight tabular-nums",
          tone,
        )}
      >
        {animate ? (
          <AnimatedNumber value={risk.edge * 100} format="percent" />
        ) : (
          pct(risk.edge)
        )}
      </p>
      <p className="mt-1 text-[11px] text-muted-foreground">
        target {(targetEdge * 100).toFixed(2)}%
        {animate ? (
          <span className={cn("ml-1.5 font-medium", tone)}>
            · {healthy ? "at / above target" : "below target"}
          </span>
        ) : null}
      </p>
    </div>
  );
}

// ─── Risk profile panel (the "new risk system") ───────────────────────

/**
 * The prominent, explained risk panel. Always renders the risk-score gauge
 * (0–100 progress bar, before → after). For NON-lottery packs it also renders
 * CV before→after and the tier before→after — each with a one-line plain-English
 * explainer that names concrete payout signal (expected per open, best case,
 * jackpot multiplier) instead of vague "swingy" copy. For LOTTERY-tagged packs
 * (hit-rate ≤ 10%) the CV + tier tiles are HIDDEN — the dedicated tag chip and
 * the lottery acknowledgment above already convey the design (mirrors the
 * `isLotteryTag = hr <= 0.10` predicate used in portfolio.ts).
 */
function RiskProfile({
  before,
  after,
  price,
  intendedHitRate,
}: {
  before: PackRisk;
  after: PackRisk | null;
  price: number;
  intendedHitRate: number | null;
}) {
  const sevB = riskSeverity(before.riskScore0to100);
  const sevA = after ? riskSeverity(after.riskScore0to100) : null;
  const isLotteryTag =
    intendedHitRate != null && intendedHitRate <= 0.10;
  // The active risk we describe in the CV/tier blurbs — the "After" if shaped,
  // otherwise the "Before" (matches how the existing blurbs picked which row).
  const active: PackRisk = after ?? before;
  const evStr = formatCurrency(active.ev);
  const maxWinStr = formatCurrency(active.maxWin);
  const maxMultStr = Number.isFinite(active.maxMult)
    ? `${active.maxMult.toFixed(active.maxMult >= 100 ? 0 : 1)}×`
    : "—";
  const winPctStr = `${(active.winRate * 100).toFixed(
    active.winRate < 0.01 ? 2 : 1,
  )}%`;
  // "1 in N" framing for the win rate (the operator-friendly read).
  const oneInN =
    active.winRate > 0 ? Math.round(1 / active.winRate) : null;
  const oneInStr =
    oneInN != null && Number.isFinite(oneInN) && oneInN > 0
      ? `~1 in ${formatNumber(oneInN)} opens`
      : null;
  return (
    <div className="space-y-3 rounded-xl border bg-card p-3.5">
      {/* Risk score gauge */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Gauge className="size-3.5" />
            Risk score
          </span>
          <span className="flex items-center gap-1.5 text-sm tabular-nums">
            <span className={cn("font-medium", sevB.tone)}>
              {before.riskScore0to100}
            </span>
            <ArrowRight className="size-3 text-muted-foreground" />
            {after ? (
              <span className={cn("font-semibold", sevA!.tone)}>
                {after.riskScore0to100}
                <span className="ml-0.5 text-[11px] font-normal">/100</span>
              </span>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </span>
        </div>
        {/* Before bar (faint) + after bar (bold) so the move is visible. */}
        <div className="space-y-1">
          <ScoreBar value={before.riskScore0to100} bar={sevB.bar} faint />
          {after && <ScoreBar value={after.riskScore0to100} bar={sevA!.bar} />}
        </div>
        <p className="text-[11px] text-muted-foreground">
          {after ? (
            <>
              Risk {after.riskScore0to100}/100 —{" "}
              <span className={cn("font-medium", sevA!.tone)}>{sevA!.word}</span>
              {after.riskScore0to100 !== before.riskScore0to100 && (
                <> (was {before.riskScore0to100} / {sevB.word})</>
              )}
              . 0 = flat payouts, 100 = extreme jackpot lottery.
            </>
          ) : (
            <>
              Risk {before.riskScore0to100}/100 —{" "}
              <span className={cn("font-medium", sevB.tone)}>{sevB.word}</span>.
            </>
          )}
        </p>
      </div>

      {/* CV + Tier side by side — hidden for lottery-tagged packs (≤ 10% hit
          rate): the tag chip + lottery acknowledgment above already convey the
          design, and the cv/tier numbers are noise for that case. Operator
          still sees the risk-score gauge above and the key-metrics block
          below for the actionable signal. */}
      {!isLotteryTag && (
        <>
          <Separator />
          <div className="grid gap-3 sm:grid-cols-2">
            <RiskFact
              label="Coefficient of variation (CV)"
              beforeNode={
                <span className="font-medium tabular-nums">
                  {before.cv.toFixed(2)}
                </span>
              }
              afterNode={
                after ? (
                  <span className="font-semibold tabular-nums">
                    {after.cv.toFixed(2)}
                  </span>
                ) : null
              }
              blurb={
                // Concrete payout signal instead of vague "swingy" copy:
                // expected payout per open + best case + jackpot multiplier.
                // Higher CV = wider spread around the same EV.
                `Expected payout per open: ${evStr} on a ${formatCurrency(price)} ticket. Best case: ${maxWinStr} (${maxMultStr}). Worst case: $0. ${
                  cvBlurb(active.cv).charAt(0).toUpperCase() +
                  cvBlurb(active.cv).slice(1)
                } around that average.`
              }
            />
            <RiskFact
              label="Volatility tier"
              beforeNode={
                <Badge
                  variant="outline"
                  className={cn(
                    "h-5 px-1.5 text-[10px] font-semibold",
                    TIER_BG[before.tier],
                  )}
                >
                  {before.tier}
                </Badge>
              }
              afterNode={
                after ? (
                  <Badge
                    variant="outline"
                    className={cn(
                      "h-5 px-1.5 text-[10px] font-semibold",
                      TIER_BG[after.tier],
                    )}
                  >
                    {after.tier}
                  </Badge>
                ) : null
              }
              blurb={
                // Lead with the operator-actionable read: how often the user
                // wins something worth at least the ticket. The TIER_BLURB is
                // kept as a short qualifier so the tier label still makes
                // sense at a glance.
                oneInStr
                  ? `${oneInStr} return ≥ ticket (${winPctStr} win-rate). Top card ${maxWinStr} (${maxMultStr}). ${TIER_BLURB[active.tier].replace(/ —.*$/, "")}.`
                  : `Top card ${maxWinStr} (${maxMultStr}). ${TIER_BLURB[active.tier].replace(/ —.*$/, "")}.`
              }
            />
          </div>
        </>
      )}
    </div>
  );
}

/** A 0–100 horizontal score bar. */
function ScoreBar({
  value,
  bar,
  faint,
}: {
  value: number;
  bar: string;
  faint?: boolean;
}) {
  const w = Math.max(0, Math.min(100, value));
  return (
    <div
      className="h-2 w-full overflow-hidden rounded-full bg-muted"
      role="img"
      aria-label={`Risk score ${value} of 100`}
    >
      <div
        className={cn(
          "h-full rounded-full motion-safe:transition-all motion-safe:duration-500 motion-safe:ease-out",
          bar,
          faint && "opacity-40",
        )}
        style={{ width: `${w}%` }}
      />
    </div>
  );
}

/** One CV / Tier fact with a before→after row + a plain-English blurb. */
function RiskFact({
  label,
  beforeNode,
  afterNode,
  blurb,
}: {
  label: string;
  beforeNode: React.ReactNode;
  afterNode: React.ReactNode | null;
  blurb: string;
}) {
  return (
    <div className="space-y-1 rounded-lg border bg-muted/10 p-2.5">
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <div className="flex items-center gap-2 text-sm">
        {beforeNode}
        <ArrowRight className="size-3 text-muted-foreground" />
        {afterNode ?? <span className="text-muted-foreground">—</span>}
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">{blurb}</p>
    </div>
  );
}

// ─── Key metrics ──────────────────────────────────────────────────────

/**
 * The play-feel metrics as explained before→after rows. Each row has an info
 * tooltip; the win-rate row references the pack tag when the pack is tagged.
 */
function KeyMetrics({
  before,
  after,
  intendedHitRate,
  targetWinRate,
}: {
  before: PackRisk;
  after: PackRisk | null;
  intendedHitRate: number | null;
  targetWinRate: number;
}) {
  const tagged = intendedHitRate != null;
  const tagPct = tagged
    ? (intendedHitRate! * 100).toFixed(intendedHitRate! < 0.01 ? 2 : 0)
    : null;
  return (
    <div className="overflow-hidden rounded-xl border">
      <MetricRow
        term="Win rate"
        tip="The share of opens that hit a profit card (value ≥ price) — the hit / gold rate. A higher win-rate means players win more often, which costs the house, so a rise tints rose."
        note={
          tagged
            ? `target ${tagPct}% — matches the pack tag`
            : `target ${(targetWinRate * 100).toFixed(0)}% (default)`
        }
        beforeVal={before.winRate}
        afterVal={after?.winRate ?? null}
        kind="pct"
        favour="player"
      />
      <MetricRow
        term="Near-miss"
        tip="The share of opens that land just below the price (between half-price and full price) — a 'so close' outcome. A feel dial that keeps the pack from feeling dead; neutral for the house."
        beforeVal={before.nearMiss}
        afterVal={after?.nearMiss ?? null}
        kind="pct"
      />
      <MetricRow
        term="Max win"
        tip="The single highest card value in the pool — the jackpot. A bigger jackpot is a bigger payout the player can win (and the house's worst-case exposure), so a rise tints rose."
        beforeVal={before.maxWin}
        afterVal={after?.maxWin ?? null}
        kind="usd"
        favour="player"
      />
      <MetricRow
        term="Max multiplier"
        tip="The jackpot as a multiple of the ticket price (max win ÷ price) — the headline 'Nx' a lucky open can return, bounded by the pack's max-multiplier cap. Higher = a juicier top prize for the player, so a rise tints rose."
        beforeVal={before.maxMult}
        afterVal={after?.maxMult ?? null}
        kind="mult"
        favour="player"
      />
    </div>
  );
}

function MetricRow({
  term,
  tip,
  note,
  beforeVal,
  afterVal,
  kind,
  favour,
}: {
  term: string;
  tip: string;
  note?: string;
  beforeVal: number;
  afterVal: number | null;
  kind: "pct" | "usd" | "mult";
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
    }
  };

  let tone = "text-foreground";
  let deltaLabel: string | null = null;
  if (afterVal != null && favour === "player") {
    const diff = afterVal - beforeVal;
    if (Math.abs(diff) > 1e-9) {
      tone =
        diff > 0
          ? "text-rose-600 dark:text-rose-400"
          : "text-emerald-600 dark:text-emerald-400";
      deltaLabel = `${diff > 0 ? "+" : "−"}${fmt(Math.abs(diff))}`;
    }
  }

  return (
    <div className="flex items-center justify-between gap-3 border-b px-3 py-2.5 last:border-b-0">
      <div className="min-w-0 space-y-0.5">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          {term}
          <InfoHint text={tip} />
        </span>
        {note && (
          <span className="block text-[11px] text-muted-foreground">{note}</span>
        )}
      </div>
      <div className="flex items-center gap-2 text-sm tabular-nums">
        <span className="text-muted-foreground">{fmt(beforeVal)}</span>
        <ArrowRight className="size-3 text-muted-foreground" />
        {afterVal == null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span className="flex items-center gap-1.5">
            <span className={cn("font-semibold", tone)}>{fmt(afterVal)}</span>
            {deltaLabel && (
              <span className={cn("text-[11px]", tone)}>{deltaLabel}</span>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

// ─── All card weight changes (no truncation) ──────────────────────────

type CardRow = {
  cardId: string;
  name: string;
  imageUrl: string;
  value: number;
  fromP: number;
  toP: number;
  /** Signed share move in percentage points (toP − fromP). */
  delta: number;
  /** Absolute share move (for the bar scale). */
  move: number;
  /**
   * Impact score = `|delta| × value`. Used as the primary sort key — a 0.07pp
   * shift on a $810 card matters more than the same shift on a $0.08 card.
   */
  impact: number;
  changed: boolean;
  /** True when this is a win/profit card (value ≥ price). */
  isWinCard: boolean;
};

/**
 * The FULL list of every card's weight change — replaces the old plain text rows.
 *
 * Layout per row: tiny thumbnail · card name + price subtitle · before% → after%
 * monospace numbers · centered horizontal delta bar scaled to the biggest move
 * in the list (left = decrease, right = increase) · big signed delta number.
 *
 * Sort: **most impactful first** — primary key is `|delta_pp| × cardValue` DESC
 * (a small probability shift on a high-value card moves EV more than the same
 * shift on dust). Unchanged cards fall to the bottom, muted.
 *
 * House-POV color (CLAUDE.md): tone is by the sign of `delta × cardValue` — a
 * positive shift on a high-value card raises player EV → rose; a positive shift
 * on dust saves the house → emerald. Same rule for negatives, inverted. The
 * existing rose/emerald CSS-variable pair from the page's house-POV convention.
 *
 * A "Top 3 most impactful" highlight strip sits above the list — same data,
 * picked from the sorted rows, so the operator's eye lands on what actually
 * moves money before scanning the full list.
 */
function AllCardChanges({
  cards,
  weightDiff,
  price,
}: {
  cards: {
    cardId: string;
    value: number;
    weight: number;
    name: string;
    imageUrl: string;
  }[];
  weightDiff: { cardId: string; from: number; to: number }[] | null;
  price: number;
}) {
  const rows = React.useMemo<CardRow[]>(() => {
    // Map of changed card → its new weight.
    const toByCard = new Map<string, number>();
    if (weightDiff) {
      for (const d of weightDiff) toByCard.set(d.cardId, d.to);
    }
    // The "after" weight for every card: the diff's `to` if it changed, else
    // unchanged (current weight). Totals normalize before% / after%.
    const fromTotal =
      cards.reduce((s, c) => s + (c.weight > 0 ? c.weight : 0), 0) || 1;
    const afterWeights = cards.map((c) =>
      toByCard.has(c.cardId) ? toByCard.get(c.cardId)! : c.weight,
    );
    const toTotal = afterWeights.reduce((s, w) => s + (w > 0 ? w : 0), 0) || 1;

    return cards
      .map((c, i): CardRow => {
        const fromP = (c.weight / fromTotal) * 100;
        const toP = (afterWeights[i]! / toTotal) * 100;
        const delta = toP - fromP;
        const move = Math.abs(delta);
        return {
          cardId: c.cardId,
          name: c.name,
          imageUrl: c.imageUrl,
          value: c.value,
          fromP,
          toP,
          delta,
          move,
          impact: move * c.value,
          changed: move > 1e-6,
          isWinCard: c.value >= price,
        };
      })
      .sort((a, b) => {
        // Primary: card value DESC — highest-priced card at the top, so the
        // operator's eye lands on the rare jackpots first (pack-design
        // invariant: high $ = low %).
        if (b.value !== a.value) return b.value - a.value;
        // Tiebreak: bigger absolute pp move first.
        if (b.move !== a.move) return b.move - a.move;
        // Final tiebreak: name asc for stable, readable order.
        return (a.name ?? "").localeCompare(b.name ?? "");
      });
  }, [cards, weightDiff, price]);

  // Scale the delta bar to the biggest move in the list so the visual
  // magnitude is comparable across rows in the same pack. A tiny epsilon keeps
  // a list of all-unchanged rows from dividing by zero.
  const maxMove = Math.max(...rows.map((r) => r.move), 1e-6);
  const changedRows = rows.filter((r) => r.changed);
  const changedCount = changedRows.length;
  // Top-3 stays sorted by impact (|Δ| × value) — it's literally "most
  // impactful". The main list above is now sorted by $ DESC, so we re-derive.
  const top3 = [...changedRows]
    .sort((a, b) => {
      if (b.impact !== a.impact) return b.impact - a.impact;
      if (b.move !== a.move) return b.move - a.move;
      return b.value - a.value;
    })
    .slice(0, 3);

  return (
    <div className="space-y-3">
      {/* Top-3 most impactful — quick-scan card before the full list. */}
      {top3.length > 0 && (
        <div className="rounded-xl border bg-muted/10 p-3">
          <p className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            <Sparkles className="size-3" />
            Top {top3.length} most impactful change{top3.length === 1 ? "" : "s"}
          </p>
          <div className="grid gap-2 sm:grid-cols-3">
            {top3.map((r) => (
              <TopImpactChip key={r.cardId} row={r} />
            ))}
          </div>
        </div>
      )}

      {/* Full list — same rows, sorted by impact DESC. */}
      <div className="overflow-hidden rounded-xl border">
        <div className="flex items-center justify-between gap-2 border-b bg-muted/20 px-3 py-2">
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            All {rows.length} cards · {changedCount} change
            {changedCount === 1 ? "" : "s"}
          </span>
          <span className="hidden text-[11px] text-muted-foreground sm:inline">
            sorted by card value
          </span>
        </div>
        {/* Scrollable so a big pool stays comfortable. */}
        <div className="max-h-[28rem] divide-y overflow-y-auto">
          {rows.map((r) => (
            <WeightChangeRow key={r.cardId} row={r} maxMove={maxMove} />
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Tone for one card-weight change row. Reuses the same house-POV rule as the
 * rest of the page: a win card gaining share, or a dust card losing share,
 * raises player EV → rose; the inverse → emerald. Driven by the SIGN of
 * `delta × value` so both cases collapse to one expression.
 */
function houseToneForRow(row: CardRow): {
  text: string;
  bg: string;
  border: string;
  bar: string;
} {
  if (!row.changed) {
    return {
      text: "text-muted-foreground",
      bg: "bg-muted/40",
      border: "border-border",
      bar: "bg-muted-foreground/40",
    };
  }
  const up = row.delta > 0;
  const playerFavorable = row.isWinCard === up;
  return playerFavorable
    ? {
        text: "text-rose-600 dark:text-rose-400",
        bg: "bg-rose-500/10",
        border: "border-rose-500/25",
        bar: "bg-rose-500",
      }
    : {
        text: "text-emerald-600 dark:text-emerald-400",
        bg: "bg-emerald-500/10",
        border: "border-emerald-500/25",
        bar: "bg-emerald-500",
      };
}

/** Format a card's display name with a graceful fallback. */
function cardNameLabel(row: CardRow): string {
  const t = (row.name ?? "").trim();
  return t.length > 0 ? t : "Unnamed card";
}

/** One row in the full weight-change list. */
function WeightChangeRow({
  row,
  maxMove,
}: {
  row: CardRow;
  maxMove: number;
}) {
  const tone = houseToneForRow(row);
  // Half-width on each side; we anchor the bar at the centerline of the track
  // and let it grow left (negative delta) or right (positive delta).
  const widthPct = Math.min(100, (row.move / maxMove) * 100);
  const isUp = row.delta > 0;
  return (
    <div
      className={cn(
        "flex items-center gap-3 px-3 py-2.5 sm:gap-4",
        !row.changed && "opacity-60",
      )}
    >
      {/* Thumbnail + identity */}
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <CardThumb row={row} />
        <div className="min-w-0 flex-1">
          <p
            className="truncate text-sm font-medium text-foreground"
            title={cardNameLabel(row)}
          >
            {cardNameLabel(row)}
          </p>
          <p className="flex items-center gap-1.5 text-[11px] tabular-nums text-muted-foreground">
            <span>{formatCurrency(row.value)}</span>
            {row.isWinCard && (
              <span
                className="inline-block size-1.5 rounded-full bg-amber-500"
                title="Profit card (value ≥ price)"
              />
            )}
          </p>
        </div>
      </div>

      {/* Before → after probability */}
      <div className="hidden shrink-0 items-center gap-1.5 text-xs tabular-nums sm:flex">
        <span className="text-muted-foreground">{formatPercent(row.fromP)}</span>
        <ArrowRight className="size-3 text-muted-foreground" />
        <span className={cn("font-semibold", tone.text)}>
          {formatPercent(row.toP)}
        </span>
      </div>

      {/* Delta bar — centered, grows L or R. Shrinks gracefully on narrow. */}
      <div className="hidden w-32 shrink-0 lg:block">
        <div className="relative h-2 w-full rounded-full bg-muted">
          {/* Centerline tick */}
          <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border" />
          {row.changed && (
            <div
              className={cn(
                "absolute top-0 h-2 rounded-full motion-safe:transition-all motion-safe:duration-500 motion-safe:ease-out",
                tone.bar,
              )}
              style={
                isUp
                  ? { left: "50%", width: `${widthPct / 2}%` }
                  : { right: "50%", width: `${widthPct / 2}%` }
              }
            />
          )}
        </div>
      </div>

      {/* Big signed delta — primary visual weight on the right. */}
      <div className="w-20 shrink-0 text-right sm:w-24">
        {row.changed ? (
          <span
            className={cn(
              "text-base font-semibold tabular-nums sm:text-lg",
              tone.text,
            )}
          >
            {isUp ? "+" : "−"}
            {formatDeltaPp(row.move)}
            <span className="ml-0.5 text-[10px] font-normal text-muted-foreground">
              pp
            </span>
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">unchanged</span>
        )}
      </div>
    </div>
  );
}

/**
 * A small square thumbnail for the card. Falls back to a tinted placeholder
 * tile with the card's first letter when the `image_url` is missing — packs
 * shouldn't ship without one, but we keep the row readable either way.
 */
function CardThumb({ row }: { row: CardRow }) {
  const src = (row.imageUrl ?? "").trim();
  if (src.length === 0) {
    const initial = cardNameLabel(row).charAt(0).toUpperCase();
    return (
      <div
        aria-hidden="true"
        className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted text-[11px] font-semibold text-muted-foreground"
      >
        {initial}
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      className="size-9 shrink-0 rounded-md border bg-muted object-contain"
    />
  );
}

/** The top-3-impact chip — a denser thumb + name + delta tile. */
function TopImpactChip({ row }: { row: CardRow }) {
  const tone = houseToneForRow(row);
  const isUp = row.delta > 0;
  return (
    <div
      className={cn(
        "flex items-center gap-2.5 rounded-lg border px-2.5 py-2",
        tone.bg,
        tone.border,
      )}
    >
      <CardThumb row={row} />
      <div className="min-w-0 flex-1">
        <p
          className="truncate text-xs font-medium text-foreground"
          title={cardNameLabel(row)}
        >
          {cardNameLabel(row)}
        </p>
        <p className="text-[10px] tabular-nums text-muted-foreground">
          {formatCurrency(row.value)} · {formatPercent(row.fromP)} →{" "}
          {formatPercent(row.toP)}
        </p>
      </div>
      <span
        className={cn(
          "shrink-0 text-sm font-bold tabular-nums",
          tone.text,
        )}
      >
        {isUp ? "+" : "−"}
        {formatDeltaPp(row.move)}
        <span className="ml-0.5 text-[9px] font-normal text-muted-foreground">
          pp
        </span>
      </span>
    </div>
  );
}

// ─── Legend ───────────────────────────────────────────────────────────

/** A compact glossary for every term + the House-POV color convention. */
function Legend() {
  return (
    <div className="space-y-2 rounded-lg border bg-muted/10 p-3 text-[11px] leading-relaxed text-muted-foreground">
      <p className="font-medium uppercase tracking-wider">Legend</p>
      <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
        <p>
          <span className="font-medium text-foreground">House edge</span> — the
          house&apos;s margin per open (higher = house keeps more).
        </p>
        <p>
          <span className="font-medium text-foreground">Win-rate</span> — share
          of opens that hit a profit card (the tag rate on tagged packs).
        </p>
        <p>
          <span className="font-medium text-foreground">CV</span> — payout
          spread vs the average (higher = swingier).
        </p>
        <p>
          <span className="font-medium text-foreground">Tier T1–T5</span> —
          volatility bucket (T1 calm → T5 lottery).
        </p>
        <p>
          <span className="font-medium text-foreground">Risk score</span> — 0
          (flat) to 100 (extreme jackpot lottery).
        </p>
        <p>
          <span className="font-medium text-foreground">Max mult</span> — jackpot
          as a multiple of the ticket price.
        </p>
      </div>
      <p className="border-t pt-2">
        Colors are from the{" "}
        <span className="font-medium text-foreground">house</span>&apos;s point of
        view:{" "}
        <span className="font-medium text-rose-600 dark:text-rose-400">rose</span>{" "}
        = the player wins more / the house gives away margin;{" "}
        <span className="font-medium text-emerald-600 dark:text-emerald-400">
          emerald
        </span>{" "}
        = healthy for the house.
      </p>
    </div>
  );
}

// ─── Relaxation hints + status badge ──────────────────────────────────

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
