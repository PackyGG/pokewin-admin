"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowRight,
  ClipboardCopy,
  Gauge,
  Layers,
  Loader2,
  PinOff,
  Plus,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Stethoscope,
  Tag,
  Ticket,
  TriangleAlert,
  Trophy,
  Check,
  Wrench,
  X,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AnimatedNumber } from "@/components/animated-number";
import { SectionHeading, TILE_COLORS, type AccentColor } from "@/components/modern-panels";
import { formatCurrency, formatRelative } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import {
  SELECTABLE_TAG_HIT_RATES,
  TAGGED_WRITE_WINRATE_TOLERANCE,
} from "@/app/(admin)/packs/_lib/auto-targets";
import type { PackRisk } from "@/app/(admin)/insights/edge-calc/risk";
import type {
  PackTuneVerdict,
  PinRemedy,
  TagGuidance,
} from "@/app/(admin)/insights/edge-calc/tag-guidance";

import { RiskLevelBar } from "../../_components/risk-level-bar";
import type { RetuneRailRow } from "../_queries/rail";
import type {
  PackTunePlan,
  StagedTagOverride,
} from "../../doctor/retune-actions";
import { LegendPopover } from "./legend-popover";
import { RemedyChips } from "./pool-table";
import {
  type PushedInfo,
  type StagedPool,
  type WorkspaceStatus,
} from "./plan-state";
import {
  CLEAN_BANNER,
  COPY_DETAILS,
  DEGENERATE_LADDER_BANNER,
  F7_DRIFTED,
  F8_REBASED,
  F17_DISCARD,
  F17_KEEP,
  F17_REHYDRATED_DRIFT,
  FIX_LOOP_SUCCESS,
  JACKPOT_NOTE,
  MIN_PUSH_EDGE,
  PINS_ENGINE_DETAIL_SUMMARY,
  PLAN_FAILED_BANNER,
  PLAN_PROGRESS_SLOW_HINT,
  PLAN_PROGRESS_VERY_SLOW_HINT,
  PUSH_BLOCKED_EDGE_FLOOR,
  PUSH_BLOCKED_EDGE_BELOW_TARGET,
  PUSH_DISABLED_DIRTY,
  PUSH_DISABLED_FIX_POOL,
  PUSH_DISABLED_INFEASIBLE,
  PUSH_DISABLED_OFF_TAG,
  PUSH_DISABLED_PUSHING,
  PUSH_DISABLED_REPLANNING,
  PUSH_LABEL,
  RELAXED_FOOTER,
  STALE_BANNER,
  STATUS_BADGE,
  WIN_RATE_ON_TAG,
  WIN_RATE_OVER_TAG,
  GUIDANCE_HEADING,
  SOLVER_VERIFIED_BADGE,
  POOL_EDIT_PRIMARY_HEADING,
  POOL_EDIT_MORE_FIXES,
  UNTAG_CTA_LABEL,
  EDGE_OVERRIDE_CHIP_TITLE,
  EDGE_OVERRIDE_CLEAR_ARIA,
  retagCtaLabel,
  addCardCtaLabel,
  applyPriceCtaLabel,
  applyPriceEdgeCtaLabel,
  edgeOverrideChipLabel,
  clearAllPinsLabel,
  dirtyOddsBanner,
  edgeTargetSub,
  limitHeadline,
  nicePinnedBanner,
  offTagStripRetagStaged,
  offTagStripUntagStaged,
  pinRemedyKindLabel,
  poolEditReasonLine,
  poolEditSummary,
  pushDisabledPendingLabel,
  stagePoolEditCta,
  suggestionKindLabel,
  offTagStrip,
  priceMoveSub,
  pricePinnedSub,
  pushSubLine,
  relaxationLine,
  tagBadgeLabel,
  tagSaturatedBanner,
  TAG_TRIAGE_HEADING,
  TAG_TRIAGE_NO_FIT,
  TAG_TRIAGE_CURRENT,
  TAG_TRIAGE_UNTAG_TITLE,
  tagTriageOutsideTitle,
  tagTriageRetagTitle,
  tagTriageWindowLine,
} from "./plan-copy";

/** Tier badge tint — same escalation the rail rows use. */
const TIER_COLORS_BADGE: Record<string, string> = {
  T1: "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400 border-cyan-500/30",
  T2: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  T3: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
  T4: "bg-orange-500/15 text-orange-600 dark:text-orange-400 border-orange-500/30",
  T5: "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30",
};

function pct(v: number): string {
  return `${(v * 100).toFixed(2)}%`;
}

/**
 * §5b metric tile — the `MetricTile` look (accent border/bg, icon + micro-caps
 * eyebrow, big tabular value) but hosting a before→after NODE with
 * `AnimatedNumber` (the shared primitive only accepts a string value, and its
 * shape is deliberately not changed — it's a cross-route hotspot).
 */
function PlanMetric({
  label,
  icon: Icon,
  accent,
  children,
  sub,
}: {
  label: string;
  icon: React.ElementType;
  accent: AccentColor;
  children: React.ReactNode;
  sub?: React.ReactNode;
}) {
  const colors = TILE_COLORS[accent];
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-xl border p-3",
        colors.bg,
      )}
    >
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0 left-0 w-0.5 bg-current opacity-50",
          colors.icon,
        )}
      />
      <div className="relative flex items-center gap-1.5">
        <Icon className={cn("size-3.5 shrink-0", colors.icon)} />
        <span className="truncate text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          {label}
        </span>
      </div>
      <div
        className={cn(
          "relative mt-1.5 flex flex-wrap items-baseline gap-x-1.5 text-lg font-bold leading-tight tracking-tight tabular-nums",
          colors.text,
        )}
      >
        {children}
      </div>
      {sub && (
        <p className="relative mt-1 truncate text-[11px] text-muted-foreground">
          {sub}
        </p>
      )}
    </div>
  );
}

/** before → after value pair; `after` null renders the before value alone. */
function BeforeAfter({
  before,
  after,
}: {
  before: React.ReactNode;
  after: React.ReactNode | null;
}) {
  if (after === null) return <>{before}</>;
  return (
    <>
      <span className="text-sm font-medium text-muted-foreground">
        {before}
      </span>
      <ArrowRight className="size-3.5 shrink-0 self-center text-muted-foreground" />
      {after}
    </>
  );
}

/**
 * Verdict lead (wave 2c): the server's `plan.verdict` renders FIRST — the
 * payload and the panel can never disagree. Headline resolution: every
 * DEDICATED verdict kind leads with its own headline; ONLY the generic
 * `refused`-with-structured-limit case defers to the plain-words
 * `limitHeadline` map (quantified beats generic — the verdict's detail is the
 * same `limit.detail` either way). For the owner-pins refusal the verdict
 * detail is the server's shortfall copy (shortfall + smallest verified fix),
 * the raw engine detail moves into the collapsed disclosure, and the verified
 * remedies render as chips via the ONE `RemedyChips` renderer.
 */
function VerdictLead({
  verdict,
  limit,
  price,
  tag,
  onApplyPinRemedy,
}: {
  verdict: PackTuneVerdict;
  limit: PackTunePlan["limit"];
  price: number;
  tag: number | null;
  /**
   * Wave 5 one-click: apply a solver-verified pin remedy (adjust/remove the
   * staged pin by `cardId`, or stage the verified pinned price) + re-plan.
   * Omitted ⇒ the chips render display-only (legacy behavior).
   */
  onApplyPinRemedy?: (remedy: PinRemedy) => void;
}) {
  const headline =
    verdict.kind === "refused" && limit !== null
      ? limitHeadline(limit, { price, tag })
      : verdict.headline;
  return (
    <>
      <p className="font-medium">{headline}</p>
      {verdict.detail !== null && verdict.detail !== headline && (
        <p className="text-xs text-muted-foreground">{verdict.detail}</p>
      )}
      {verdict.kind === "pins-infeasible" && limit !== null && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer list-none underline-offset-2 hover:underline">
            {PINS_ENGINE_DETAIL_SUMMARY}
          </summary>
          <p className="pt-0.5">{limit.detail}</p>
        </details>
      )}
      {verdict.pinRemedies !== null && verdict.pinRemedies.length > 0 && (
        <RemedyChips
          chips={verdict.pinRemedies.map((r, i) => ({
            key: `${r.kind}-${i}`,
            label: pinRemedyKindLabel(r.kind),
            detail: r.humanCopy,
          }))}
          {...(onApplyPinRemedy
            ? {
                onApply: (i: number) => {
                  const r = verdict.pinRemedies![i];
                  if (r) onApplyPinRemedy(r);
                },
              }
            : {})}
        />
      )}
    </>
  );
}

/**
 * Tag triage (wave 2c): the LAW T window is THE bound for the retag picker.
 * Renders under the verdict lead on the tag-law refusals (`tag-unreachable` /
 * `monotone-unreachable`) when the fit probe ran: the window-proven lawful
 * interval at the plan price, the four selectable tiers as one-click retag
 * buttons — enabled iff the tier's designed hit-rate falls INSIDE
 * `verdict.fitRange` — plus the always-lawful Untag. Buttons reuse the
 * existing tag-control loop (`onChangeTag` stages the override + re-plans
 * immediately; the push writes `packs.tags`). `fitRange === null` with the
 * probe run = window-proven "no tag fits" — untag or edit the pool.
 */
function TagTriage({
  verdict,
  price,
  tag,
  onChangeTag,
}: {
  verdict: PackTuneVerdict;
  price: number;
  /** The EFFECTIVE tag the plan solved against (marks the failing tier). */
  tag: number | null;
  onChangeTag: (override: StagedTagOverride | undefined) => void;
}) {
  if (!verdict.fitProbed) return null;
  const fitRange = verdict.fitRange;
  return (
    <div className="space-y-1.5 rounded-lg border border-current/25 bg-background/50 p-2.5">
      <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        <Tag className="size-3 shrink-0" aria-hidden />
        {TAG_TRIAGE_HEADING}
      </p>
      <p className="text-xs text-foreground/90">
        {fitRange !== null
          ? tagTriageWindowLine(price, fitRange)
          : TAG_TRIAGE_NO_FIT}
      </p>
      <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
        {SELECTABLE_TAG_HIT_RATES.map((t) => {
          const fits =
            fitRange !== null &&
            t.hitRate >= fitRange.minFit - 1e-9 &&
            t.hitRate <= fitRange.maxFit + 1e-9;
          const current = tag !== null && Math.abs(tag - t.hitRate) <= 1e-9;
          return (
            <Button
              key={t.tag}
              type="button"
              size="sm"
              variant="outline"
              disabled={!fits || current}
              title={
                fits && !current
                  ? tagTriageRetagTitle(t.dbLabel)
                  : tagTriageOutsideTitle(t.dbLabel)
              }
              onClick={() =>
                onChangeTag({ kind: "tag", tag: t.tag, hitRate: t.hitRate })
              }
            >
              <Tag className="size-3.5" />
              {t.dbLabel}
              {current && (
                <span className="text-[10px] text-muted-foreground">
                  · {TAG_TRIAGE_CURRENT}
                </span>
              )}
            </Button>
          );
        })}
        <Button
          type="button"
          size="sm"
          variant="outline"
          title={TAG_TRIAGE_UNTAG_TITLE}
          onClick={() => onChangeTag({ kind: "untag" })}
        >
          <PinOff className="size-3.5" />
          {UNTAG_CTA_LABEL}
        </Button>
      </div>
    </div>
  );
}

/**
 * Live re-planning progress: an animated indeterminate sweep bar + an
 * elapsed-seconds counter, mounted for the WHOLE stale→planning episode
 * (the caller keys it by pack, so switching packs resets the clock while a
 * stale→planning flip keeps it running). Reduced motion: the bar stays
 * static, the counter still ticks — the operator always sees liveness.
 * Slow-solve hints appear at 12s / 30s so a long search never reads as hung.
 */
function PlanningProgress() {
  const [seconds, setSeconds] = React.useState(0);
  React.useEffect(() => {
    const id = window.setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
          <div
            aria-hidden
            className="h-full w-2/5 rounded-full bg-primary/70 motion-safe:animate-[plan-progress-sweep_1.4s_ease-in-out_infinite]"
          />
        </div>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {seconds}s
        </span>
      </div>
      {seconds >= 12 && (
        <p className="text-xs text-muted-foreground">
          {PLAN_PROGRESS_SLOW_HINT}
        </p>
      )}
      {seconds >= 30 && (
        <p className="text-xs text-muted-foreground">
          {PLAN_PROGRESS_VERY_SLOW_HINT}
        </p>
      )}
    </div>
  );
}

type BannerTone = "rose" | "amber" | "emerald" | "blue";

const BANNER_TONES: Record<BannerTone, string> = {
  rose: "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400",
  amber:
    "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  emerald:
    "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  blue: "border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400",
};

function Banner({
  tone,
  icon: Icon,
  children,
  highlight,
}: {
  tone: BannerTone;
  icon: React.ElementType;
  children: React.ReactNode;
  /** One-shot motion-safe pop for the fix-loop success flip. */
  highlight?: boolean;
}) {
  return (
    <div
      role="status"
      className={cn(
        "flex items-start gap-2.5 rounded-lg border px-3 py-2.5",
        BANNER_TONES[tone],
        highlight &&
          "motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95 motion-safe:duration-300",
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 space-y-1 text-sm">{children}</div>
    </div>
  );
}

/**
 * The guidance engine's ranked, engine-proven fix list (ruleset §2). Each row
 * is plain-words copy with the exact numbers baked in; an `add-card`
 * suggestion carries its computed $ band and seeds the existing
 * `BuilderCardPicker` price pre-filter via `onAddCardRange` (the same
 * one-click fix loop the legacy `suggestedRange` used).
 */
function GuidanceSuggestions({
  guidance,
  onAddCardRange,
  onChangeTag,
  onApplyPrice,
}: {
  guidance: TagGuidance;
  onAddCardRange: (range: { min: number; max: number }) => void;
  onChangeTag: (override: StagedTagOverride | undefined) => void;
  /**
   * Wave 4 one-click for the price suggestions: stages the suggested price
   * PINNED (odds-only solve at exactly that cent — the suggestion's claim is a
   * point solution, not a search anchor) plus, for `price-edge-exact`, the
   * edge-target override; then re-plans. The landed plan re-verifies the claim
   * through the real engine — a suggestion the solve can't honour REFUSES.
   */
  onApplyPrice: (args: { price: number; edgeTarget?: number }) => void;
}) {
  const rows = guidance.suggestions;
  if (rows.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {GUIDANCE_HEADING}
      </p>
      <ul className="space-y-1.5">
        {rows.map((s, i) => {
          const isAddCard =
            s.kind === "add-card" &&
            typeof s.params.valueMin === "number" &&
            typeof s.params.valueMax === "number";
          // Retag / untag suggestions carry a machine `action` on params so the
          // guidance row can APPLY the change through the existing tag control
          // (`onChangeTag` re-plans). Old suggestions without `action` render no
          // button (guarded on the string type).
          const tagAction =
            typeof s.params.action === "string" ? s.params.action : null;
          // Price suggestions carry the exact cent on params; `price-edge-exact`
          // additionally carries the edge fraction the pinned pool pays there.
          const priceParam =
            typeof s.params.price === "number" &&
            Number.isFinite(s.params.price) &&
            s.params.price > 0
              ? s.params.price
              : null;
          const edgeParam =
            typeof s.params.edgeTarget === "number" &&
            Number.isFinite(s.params.edgeTarget) &&
            s.params.edgeTarget > 0
              ? s.params.edgeTarget
              : null;
          return (
            <li key={`${s.kind}-${i}`} className="space-y-1">
              <p className="text-xs">
                <Badge
                  variant="outline"
                  className="mr-1.5 border-current/30 px-1.5 py-0 align-middle text-[10px] font-medium"
                >
                  {suggestionKindLabel(s.kind)}
                </Badge>
                <span className="text-foreground/90">{s.humanCopy}</span>
                {s.proof.solverVerified === true && (
                  <Badge
                    variant="outline"
                    className="ml-1.5 border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0 align-middle text-[10px] font-medium text-emerald-600 dark:text-emerald-400"
                  >
                    {SOLVER_VERIFIED_BADGE}
                  </Badge>
                )}
              </p>
              {isAddCard && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    onAddCardRange({
                      min: s.params.valueMin as number,
                      max: s.params.valueMax as number,
                    })
                  }
                >
                  <Plus className="size-3.5" />
                  {addCardCtaLabel({
                    min: s.params.valueMin as number,
                    max: s.params.valueMax as number,
                  })}
                </Button>
              )}
              {tagAction === "untag" && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onChangeTag({ kind: "untag" })}
                >
                  <PinOff className="size-3.5" />
                  {UNTAG_CTA_LABEL}
                </Button>
              )}
              {tagAction === "retag" && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    onChangeTag({
                      kind: "tag",
                      tag: s.params.tierTag as
                        | "pct1"
                        | "pct5"
                        | "pct10"
                        | "fifty50",
                      hitRate: Number(s.params.tierHitRate),
                    })
                  }
                >
                  <Tag className="size-3.5" />
                  {retagCtaLabel(String(s.params.tierDbLabel))}
                </Button>
              )}
              {s.kind === "price-move" && priceParam !== null && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onApplyPrice({ price: priceParam })}
                >
                  <Ticket className="size-3.5" />
                  {applyPriceCtaLabel(priceParam)}
                </Button>
              )}
              {s.kind === "price-edge-exact" &&
                priceParam !== null &&
                edgeParam !== null && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      onApplyPrice({ price: priceParam, edgeTarget: edgeParam })
                    }
                  >
                    <Ticket className="size-3.5" />
                    {applyPriceEdgeCtaLabel(priceParam, edgeParam)}
                  </Button>
                )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Pool-edits-first PRIMARY card (owner-lens §3 / Patterns 1, 10). Renders when
 * the plan carries a `poolEditPlan`: the solver-verified pool edit is THE
 * recommendation (heading + reason line + summary + one-click stage CTA), with
 * the plain guidance list demoted under a collapsed "More fixes" disclosure.
 * The as-is fixed-pool plan stays fully rendered BELOW (it is the secondary).
 */
function PoolEditPrimary({
  poolEdit,
  guidance,
  onStagePoolEdit,
  onAddCardRange,
  onChangeTag,
  onApplyPrice,
}: {
  poolEdit: NonNullable<PackTunePlan["poolEditPlan"]>;
  guidance: TagGuidance | null;
  onStagePoolEdit: () => void;
  onAddCardRange: (range: { min: number; max: number }) => void;
  onChangeTag: (override: StagedTagOverride | undefined) => void;
  onApplyPrice: (args: { price: number; edgeTarget?: number }) => void;
}) {
  const hasAdd = poolEdit.addCard !== null;
  return (
    <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
      <div className="flex items-center gap-2">
        <Wrench className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <p className="font-medium text-amber-700 dark:text-amber-300">
          {POOL_EDIT_PRIMARY_HEADING}
        </p>
      </div>
      <p className="text-xs text-muted-foreground">
        {poolEditReasonLine(poolEdit.reason)}
      </p>
      <p className="text-sm text-foreground/90">
        {poolEditSummary({
          addCard: poolEdit.addCard,
          removeCount: poolEdit.removeCardIds.length,
          price: poolEdit.price,
          beyondBudget: poolEdit.beyondBudget,
        })}
      </p>
      <Button type="button" size="sm" onClick={onStagePoolEdit}>
        <Wrench className="size-3.5" />
        {stagePoolEditCta(hasAdd)}
      </Button>
      {guidance != null && guidance.suggestions.length > 0 && (
        <details className="group pt-1">
          <summary className="cursor-pointer list-none text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground hover:text-foreground">
            {POOL_EDIT_MORE_FIXES}
          </summary>
          <div className="pt-2">
            <GuidanceSuggestions
              guidance={guidance}
              onAddCardRange={onAddCardRange}
              onChangeTag={onChangeTag}
              onApplyPrice={onApplyPrice}
            />
          </div>
        </details>
      )}
    </div>
  );
}

/**
 * Tag control (owner feature, 2026-07-04): a compact Select in the plan header
 * letting the operator REMOVE or CHANGE the pack's product tag. Selecting a
 * value stages a tag override and re-plans immediately (a tag change is
 * solve-relevant); the push writes it to `packs.tags`.
 *
 *   • "Live tag" — no override (use the pack's DB / name tag as-is).
 *   • "None (untag)" — force the pack UNTAGGED (fast, live-anchored plan).
 *   • %1 / %5 / %10 / 50/50 — pin the plan to that tag's designed win-rate.
 *
 * The current value reflects the STAGED override when present, else "live".
 */
function TagControl({
  tagOverride,
  onChangeTag,
  disabled,
}: {
  tagOverride: StagedTagOverride | undefined;
  onChangeTag: (override: StagedTagOverride | undefined) => void;
  disabled: boolean;
}) {
  const value =
    tagOverride === undefined
      ? "live"
      : tagOverride.kind === "untag"
        ? "untag"
        : tagOverride.tag;
  const handleChange = (v: string | null) => {
    if (v === null || v === "live") {
      onChangeTag(undefined);
      return;
    }
    if (v === "untag") {
      onChangeTag({ kind: "untag" });
      return;
    }
    const match = SELECTABLE_TAG_HIT_RATES.find((t) => t.tag === v);
    if (match) onChangeTag({ kind: "tag", tag: match.tag, hitRate: match.hitRate });
  };
  return (
    <div className="inline-flex items-center gap-1">
      <Tag className="size-3.5 text-muted-foreground" aria-hidden />
      <Select value={value} onValueChange={handleChange} disabled={disabled}>
        <SelectTrigger
          size="sm"
          className="h-6 gap-1 px-1.5 text-[11px]"
          aria-label="Change or remove the pack tag"
          title="Change or remove the pack's product tag — re-plans immediately and writes on push"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="live">Live tag</SelectItem>
          <SelectItem value="untag">None (untag)</SelectItem>
          {SELECTABLE_TAG_HIT_RATES.map((t) => (
            <SelectItem key={t.tag} value={t.tag}>
              {t.dbLabel}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export type PlanRefusal = {
  kind: "skew" | "invariant";
  message: string;
  /** F9 "Copy details" payload — packId + the frozen plan JSON. */
  details: string | null;
};

export function PlanPanel({
  row,
  status,
  plan,
  lastPlanBefore,
  planError,
  estimate,
  staged,
  pushed,
  refusal,
  rebased,
  fixLoopSuccess,
  driftPrompt,
  tagSource,
  tagOverride,
  onChangeTag,
  nextSuggestion,
  pushEnabled,
  pushing,
  pendingCount,
  onReplan,
  onResetToLive,
  onPush,
  onRetryPlan,
  onAddCardRange,
  onStagePoolEdit,
  onApplyPrice,
  onApplyPinRemedy,
  onClearEdgeOverride,
  onSetEdgeTarget,
  onKeepRehydrated,
  onDiscardRehydrated,
  onSelectPack,
  onClearAllPins,
  children,
}: {
  row: RetuneRailRow;
  status: WorkspaceStatus;
  /** The plan for the CURRENT basis only (null while none has landed). */
  plan: PackTunePlan | null;
  /**
   * The LIVE-pool risk from the last landed plan, any basis — `before` is
   * basis-independent (live truth), so the KPI strip keeps its BEFORE column
   * (and can show the client-mirror estimate) during a stale re-plan.
   */
  lastPlanBefore: PackRisk | null;
  planError: string | null;
  /** Client mirror (`computePackRisk`) during stale/planning — labeled estimate. */
  estimate: PackRisk | null;
  staged: StagedPool | null;
  pushed: PushedInfo | undefined;
  refusal: PlanRefusal | null;
  rebased: boolean;
  fixLoopSuccess: boolean;
  driftPrompt: boolean;
  tagSource: "db" | "name" | null;
  /**
   * The staged tag override (tag control) — `undefined` when the plan uses the
   * pack's LIVE tag. Drives the tag control's selected value.
   */
  tagOverride: StagedTagOverride | undefined;
  /**
   * Change/remove the pack's product tag (tag control): pass the new override,
   * or `undefined` to revert to the live tag. Triggers an immediate re-plan.
   */
  onChangeTag: (override: StagedTagOverride | undefined) => void;
  /** Post-push "Next: {name} →" suggestion (a button, never auto-nav). */
  nextSuggestion: { packId: string; name: string } | null;
  pushEnabled: boolean;
  pushing: boolean;
  /**
   * Typed-but-not-applied edits (LAW P): any count > 0 blocks the push and the
   * disabled label says exactly why — the plan below doesn't contain them.
   */
  pendingCount: number;
  onReplan: () => void;
  onResetToLive: () => void;
  onPush: () => void;
  onRetryPlan: () => void;
  onAddCardRange: (range: { min: number; max: number }) => void;
  /**
   * §3 pool-edits-first: stage the plan's `poolEditPlan` into the staged pool
   * (remove its dead cards, pin its price, then open the picker pre-filtered to
   * its add-card band). One-click; never writes.
   */
  onStagePoolEdit: () => void;
  /**
   * Wave 4 price-suggestion one-click: stage the suggested price PINNED
   * (+ the edge-target override for `price-edge-exact`) and re-plan.
   */
  onApplyPrice: (args: { price: number; edgeTarget?: number }) => void;
  /**
   * Wave 5 one-click pin remedies (pins-infeasible chips): adjust/remove the
   * staged pin by the remedy's `cardId` — or stage its verified pinned price
   * (`price-move`) — then re-plan. Solver-verified server-side; the landed
   * plan re-verifies through the real engine either way.
   */
  onApplyPinRemedy: (remedy: PinRemedy) => void;
  /** Drop the staged edge-target override (header chip ×) and re-plan. */
  onClearEdgeOverride: () => void;
  /**
   * Raise the edge target by raising the price — computes the price that
   * produces the desired edge at the current EV, stages it pinned + the
   * edge override, then re-plans. No odds changes.
   */
  onSetEdgeTarget: (desiredEdge: number) => void;
  onKeepRehydrated: () => void;
  onDiscardRehydrated: () => void;
  onSelectPack: (packId: string) => void;
  /** Clear every owner pin on this pack (control near the plan header). */
  onClearAllPins: () => void;
  /** The pool zone (§5d) — rendered between the banner slot and the push row. */
  children: React.ReactNode;
}) {
  const targets = plan?.targets ?? null;
  const after = plan?.after ?? null;
  const showEstimate =
    after === null &&
    estimate !== null &&
    (status === "planning" || status === "stale");
  const afterRisk = after ?? (showEstimate ? estimate : null);
  // Hold the last non-null BEFORE through a re-plan: a staged edit flips the
  // basis and nulls the entry's plan, which would unmount the whole KPI grid
  // to skeletons mid-episode (flash + layout jump). `before` is live truth
  // (basis-independent), so re-showing it during planning/stale/drifted is
  // honest. The panel remounts per pack (FadeIn key), so it can't leak across
  // packs. Render-time setState is the sanctioned previous-render pattern.
  const beforeLive = plan?.before ?? lastPlanBefore;
  const [heldBefore, setHeldBefore] = React.useState<PackRisk | null>(null);
  if (beforeLive !== null && beforeLive !== heldBefore) setHeldBefore(beforeLive);
  const before =
    beforeLive ??
    (status === "planning" || status === "stale" || status === "drifted"
      ? heldBefore
      : null);
  // The EFFECTIVE tag the plan is solving against: when the operator staged a
  // tag override, the plan's `intendedHitRate` reflects it (a number = the
  // overridden tag, null = untagged). Otherwise it's the pack's live tag. All
  // PLAN-facing displays (KPI win-rate tile, tag banners) use this so they
  // match what the plan actually solved. The off-tag LIVE strip below stays on
  // `row.tag` (it's about live truth, not the staged override).
  const tag =
    tagOverride !== undefined
      ? (plan?.intendedHitRate ?? null)
      : row.tag;

  // ── Status badge (§5a) ────────────────────────────────────────────────────
  const badge = ((): { label: string; className: string; spin?: boolean } => {
    switch (status) {
      case "planning":
        return { label: STATUS_BADGE.planning, className: "border-border bg-muted/40 text-muted-foreground", spin: true };
      case "stale":
        return { label: STATUS_BADGE.stale, className: "border-border bg-muted/40 text-muted-foreground", spin: true };
      case "drifted":
        return { label: STATUS_BADGE.drifted, className: BANNER_TONES.amber };
      case "pushing":
        return { label: STATUS_BADGE.pushing, className: "border-border bg-muted/40 text-muted-foreground", spin: true };
      case "pushed":
        return { label: STATUS_BADGE.pushed, className: BANNER_TONES.emerald };
      case "refused":
        return { label: STATUS_BADGE.refused, className: BANNER_TONES.rose };
      case "error":
        return { label: STATUS_BADGE.error, className: BANNER_TONES.rose };
      case "infeasible":
        return { label: STATUS_BADGE.infeasible, className: BANNER_TONES.rose };
      case "planned":
        if (plan?.snapped === false)
          return { label: STATUS_BADGE.plannedDirty, className: BANNER_TONES.amber };
        // §3.3: a feasible-but-degenerate ladder is badged (between dirty and
        // relaxed in precedence) — it is pushable but demoted.
        if (plan?.shape?.degenerate === true)
          return { label: STATUS_BADGE.plannedDegenerate, className: BANNER_TONES.amber };
        if (plan && plan.relaxations.length > 0)
          return { label: STATUS_BADGE.relaxed, className: BANNER_TONES.amber };
        return { label: STATUS_BADGE.plannedClean, className: BANNER_TONES.emerald };
      case "pristine":
      default:
        return { label: STATUS_BADGE.previewOnly, className: "border-border bg-transparent text-muted-foreground" };
    }
  })();

  // ── The ONE banner slot (§5c, priority top-down) ──────────────────────────
  const banner = ((): React.ReactNode => {
    if (status === "error") {
      return (
        <Banner tone="rose" icon={TriangleAlert}>
          <p>{PLAN_FAILED_BANNER}</p>
          {planError && (
            <p className="text-xs text-muted-foreground">{planError}</p>
          )}
          <Button type="button" variant="outline" size="sm" onClick={onRetryPlan}>
            Retry
          </Button>
        </Banner>
      );
    }
    if (status === "stale" || status === "planning") {
      return (
        <Banner tone="blue" icon={Loader2}>
          <p>{STALE_BANNER}</p>
          {/* One episode = one clock: keyed by pack so pack switches reset it
              while the stale→planning flip keeps it mounted and counting. */}
          <PlanningProgress key={row.packId} />
        </Banner>
      );
    }
    if (status === "drifted") {
      return (
        <Banner tone="amber" icon={TriangleAlert}>
          <p>{F7_DRIFTED}</p>
          <p className="text-xs text-muted-foreground">
            Re-basing on the fresh live pool and re-planning — your staged
            edits are kept.
          </p>
        </Banner>
      );
    }
    if (!plan) return null;
    const verdict = plan.verdict;
    const verdictPrice = plan.priceAfter || plan.price;
    const showTriage =
      verdict.kind === "tag-unreachable" ||
      verdict.kind === "monotone-unreachable";
    const hasGuidance =
      plan.guidance != null && plan.guidance.suggestions.length > 0;
    // §3 pool-edits-first (owner-lens): whenever the server attached a
    // solver-verified `poolEditPlan` — infeasible, degenerate, risk-flip, or a
    // dirty dead-end — the PRIMARY recommendation is the pool edit. Wave 2c:
    // the server VERDICT is the WHY line above the card (a healthy verdict —
    // the risk-band-exit pool edit on an otherwise-clean plan — renders no
    // lead; the card's reason line carries the why, as before).
    if (plan.poolEditPlan !== null) {
      return (
        <Banner tone={plan.limit !== null ? "rose" : "amber"} icon={TriangleAlert}>
          {verdict.kind !== "healthy" && (
            <VerdictLead
              verdict={verdict}
              limit={plan.limit}
              price={verdictPrice}
              tag={tag}
              onApplyPinRemedy={onApplyPinRemedy}
            />
          )}
          {showTriage && (
            <TagTriage
              verdict={verdict}
              price={verdictPrice}
              tag={tag}
              onChangeTag={onChangeTag}
            />
          )}
          <PoolEditPrimary
            poolEdit={plan.poolEditPlan}
            guidance={plan.guidance}
            onStagePoolEdit={onStagePoolEdit}
            onAddCardRange={onAddCardRange}
            onChangeTag={onChangeTag}
            onApplyPrice={onApplyPrice}
          />
        </Banner>
      );
    }
    // Wave 2c: every refusal kind — and the feasible-but-off-tag block — leads
    // with the SERVER verdict (ranked worst-first at the source; the client
    // never re-derives "why is this bad?" from six nullable fields again).
    // The tag-law refusals additionally render the LAW T tag triage: the
    // window-proven retag picker bounded by `verdict.fitRange`.
    if (
      verdict.kind === "tag-contradiction" ||
      verdict.kind === "pins-infeasible" ||
      verdict.kind === "monotone-unreachable" ||
      verdict.kind === "tag-unreachable" ||
      verdict.kind === "refused" ||
      verdict.kind === "off-tag"
    ) {
      return (
        <Banner tone="rose" icon={TriangleAlert}>
          <VerdictLead
            verdict={verdict}
            limit={plan.limit}
            price={verdictPrice}
            tag={tag}
            onApplyPinRemedy={onApplyPinRemedy}
          />
          {/* off-tag ships no server detail — the quantified saturation copy
              (closest-achievable framing) stays as the second line. */}
          {verdict.kind === "off-tag" && tag !== null && (
            <p className="text-xs text-muted-foreground">
              {tagSaturatedBanner(tag)}
            </p>
          )}
          {showTriage && (
            <TagTriage
              verdict={verdict}
              price={verdictPrice}
              tag={tag}
              onChangeTag={onChangeTag}
            />
          )}
          {hasGuidance ? (
            // The guidance engine's ranked, proven fixes LEAD whenever they
            // exist (ruleset: no infeasible verdict without a computed
            // suggestion); the verdict's ONE `action` renders as-is ONLY
            // when guidance shipped nothing verified.
            <GuidanceSuggestions
              guidance={plan.guidance!}
              onAddCardRange={onAddCardRange}
              onChangeTag={onChangeTag}
              onApplyPrice={onApplyPrice}
            />
          ) : (
            <>
              {verdict.action !== null && (
                <p className="text-xs">{verdict.action}</p>
              )}
              {plan.limit?.suggestedRange && (
                <Button
                  type="button"
                  size="sm"
                  className="mt-1"
                  onClick={() => onAddCardRange(plan.limit!.suggestedRange!)}
                >
                  <Plus className="size-3.5" />
                  {addCardCtaLabel(plan.limit.suggestedRange)}
                </Button>
              )}
            </>
          )}
        </Banner>
      );
    }
    if (plan.feasible && fixLoopSuccess) {
      return (
        <Banner tone="emerald" icon={ShieldCheck} highlight>
          <p className="font-medium">{FIX_LOOP_SUCCESS}</p>
        </Banner>
      );
    }
    // Wave 2c quality kinds — the verdict headline leads, the QUANTIFIED
    // client line follows (the server keeps quality details null by design):
    //   • `unsnapped` — the dirty banner; a dirty plan that swept the whole
    //     band + fell back is a dead end ("nudge the price" is wrong advice,
    //     Pattern 9g/10). Dead ends normally carry a poolEditPlan (above);
    //     this renders the residual dirty-but-not-dead-end case.
    //   • `off-nice` — §niceness saturation-honesty: exact but off the nice
    //     rung grid, quantified. Push stays ENABLED (tag + edge exact).
    //   • `degenerate` — the shape guard's verdict WITHOUT a pool-edit lever
    //     (previously badge-only for tagged packs): the ladder-collapse
    //     banner + whatever spread fixes guidance proved.
    if (
      verdict.kind === "degenerate" ||
      verdict.kind === "unsnapped" ||
      verdict.kind === "off-nice"
    ) {
      const qualityLine =
        verdict.kind === "unsnapped"
          ? dirtyOddsBanner(
              plan.offLadderCards.length,
              plan.planned.length,
              plan.searchMeta?.fellBackToBase === true,
            )
          : verdict.kind === "off-nice"
            ? nicePinnedBanner(plan.offLadderCards.length, plan.planned.length)
            : DEGENERATE_LADDER_BANNER;
      return (
        <Banner tone="amber" icon={TriangleAlert}>
          <VerdictLead
            verdict={verdict}
            limit={plan.limit}
            price={verdictPrice}
            tag={tag}
            onApplyPinRemedy={onApplyPinRemedy}
          />
          <p>{qualityLine}</p>
          {hasGuidance && (
            <GuidanceSuggestions
              guidance={plan.guidance!}
              onAddCardRange={onAddCardRange}
              onChangeTag={onChangeTag}
              onApplyPrice={onApplyPrice}
            />
          )}
        </Banner>
      );
    }
    if (
      plan.feasible &&
      tag === null &&
      plan.guidance != null &&
      plan.guidance.suggestions.length > 0
    ) {
      // Untagged degenerate loss ladder (the "Captive" case): the plan is
      // valid and pushable — the banner answers WHY cards sit at the odds
      // floor and offers the engine-proven spread fixes.
      return (
        <Banner tone="amber" icon={TriangleAlert}>
          <p>{DEGENERATE_LADDER_BANNER}</p>
          <GuidanceSuggestions
            guidance={plan.guidance}
            onAddCardRange={onAddCardRange}
            onChangeTag={onChangeTag}
            onApplyPrice={onApplyPrice}
          />
        </Banner>
      );
    }
    if (plan.feasible && plan.relaxations.length > 0) {
      return (
        <Banner tone="amber" icon={TriangleAlert}>
          <ul className="list-disc space-y-0.5 pl-4">
            {plan.relaxations.map((r, i) => (
              <li key={`${r.lever}-${i}`}>{relaxationLine(r, { tag })}</li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">{RELAXED_FOOTER}</p>
        </Banner>
      );
    }
    if (plan.feasible && plan.topInflationUnavoidable) {
      return (
        <Banner tone="amber" icon={TriangleAlert}>
          <p>{JACKPOT_NOTE}</p>
        </Banner>
      );
    }
    if (plan.feasible) {
      return (
        <Banner tone="emerald" icon={ShieldCheck}>
          <p>{CLEAN_BANNER}</p>
        </Banner>
      );
    }
    return null;
  })();

  // ── Push row facts (§5e) ──────────────────────────────────────────────────
  // Cap-removed cards are counted as removals below, never as odds changes
  // (their planned 0 is the drop verdict, not a chance).
  const capDropped = new Set(plan?.capDroppedCardIds ?? []);
  const oddsChanges = plan
    ? plan.planned.filter(
        (p) =>
          !capDropped.has(p.cardId) &&
          p.livePct !== null &&
          Math.abs(p.pct - p.livePct) > 1e-9,
      ).length
    : 0;
  const addedCount = plan
    ? plan.planned.filter(
        (p) => !capDropped.has(p.cardId) && p.livePct === null,
      ).length
    : 0;
  // Staged removals + cap removals (owner rule, 2026-07-03): both are true
  // removals the write persists — the "Will write … removed" line counts both.
  const removedCount = plan
    ? plan.removedCardIds.length +
      (plan.feasible ? plan.capDroppedCardIds.length : 0)
    : 0;

  // Owner hard law 2026-07-11 (client mirror): a landed plan whose after-edge
  // sits below the 10.5% floor never offers Push. The server write gate
  // enforces the same floor fail-closed — this is only the honest pre-disable.
  const edgeFloorBlocked =
    plan !== null &&
    plan.after !== null &&
    plan.after.edge < MIN_PUSH_EDGE - 1e-9;

  // Client mirror of the server's edge-below-target assert: the server refuses
  // any plan whose edge < targetEdge. Without this client check, the user
  // could click Push on a plan that looks fine (edge above the 10.5% floor)
  // only to get a server refusal — wasting their time. This is especially
  // common when manual pins push the edge below target.
  const edgeBelowTarget =
    plan !== null &&
    plan.after !== null &&
    plan.targets.targetEdge > 0 &&
    plan.after.edge < plan.targets.targetEdge - 1e-9;

  const pushDisabledLabel = ((): string | null => {
    if (pushEnabled)
      return edgeFloorBlocked
        ? PUSH_BLOCKED_EDGE_FLOOR
        : edgeBelowTarget
          ? PUSH_BLOCKED_EDGE_BELOW_TARGET
          : null;
    if (status === "pushed") return PUSH_LABEL; // F14 — re-stage to re-arm
    if (status === "pushing") return PUSH_DISABLED_PUSHING;
    if (status === "planning" || status === "stale" || status === "drifted")
      return PUSH_DISABLED_REPLANNING;
    // LAW P: typed odds not in this plan — the most actionable block (Apply
    // or Discard resolves it regardless of what the merged plan then says).
    if (pendingCount > 0) return pushDisabledPendingLabel(pendingCount);
    if (plan && (plan.taggedAccuracyHit === false || plan.tagContradiction))
      return PUSH_DISABLED_OFF_TAG;
    if (plan && plan.feasible && plan.snapped === false)
      return PUSH_DISABLED_DIRTY;
    if (plan && !plan.feasible) return PUSH_DISABLED_INFEASIBLE;
    return PUSH_DISABLED_FIX_POOL;
  })();

  // Win-rate tile tone (§5b #2).
  const winTone = ((): AccentColor => {
    if (!afterRisk) return "blue";
    if (tag === null) return "blue";
    const delta = afterRisk.winRate - tag;
    if (Math.abs(delta) <= TAGGED_WRITE_WINRATE_TOLERANCE + 1e-12)
      return "emerald";
    return delta > 0 ? "rose" : "amber";
  })();

  const priceDelta = plan ? plan.priceAfter - plan.price : 0;

  return (
    <div className="space-y-4">
      {/* ── §5a header ──────────────────────────────────────────────────── */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="min-w-0 truncate text-lg font-bold tracking-tight">
            {row.name}
          </h2>
          <Badge
            variant="outline"
            className={cn("h-5 px-1.5 text-[10px]", TIER_COLORS_BADGE[row.tier] ?? "")}
          >
            {row.tier}
          </Badge>
          {tag !== null && tagOverride === undefined && (
            <Badge
              variant="outline"
              className="h-5 px-1.5 text-[10px] tabular-nums"
              title={tagSource === "db" ? "DB tag" : "from name"}
            >
              {tagBadgeLabel(tag)}
            </Badge>
          )}
          {/* Tag control (owner feature): change/remove the pack tag → re-plan
              immediately; the push writes it to packs.tags. */}
          <TagControl
            tagOverride={tagOverride}
            onChangeTag={onChangeTag}
            disabled={pushing}
          />
          <span className="text-sm tabular-nums text-muted-foreground">
            {formatCurrency(row.price)}
          </span>
          {/* Wave 4: the staged edge-target override binds the plan — always
              visible while set, cleared with one click (re-plans on the auto
              curve target). */}
          {staged?.edgeTargetOverride !== undefined && (
            <Badge
              variant="outline"
              className={cn(
                "h-5 gap-1 px-1.5 text-[10px] tabular-nums",
                BANNER_TONES.amber,
              )}
              title={EDGE_OVERRIDE_CHIP_TITLE}
            >
              {edgeOverrideChipLabel(staged.edgeTargetOverride)}
              <button
                type="button"
                aria-label={EDGE_OVERRIDE_CLEAR_ARIA}
                onClick={onClearEdgeOverride}
                disabled={pushing}
                className="rounded-sm opacity-70 transition-opacity hover:opacity-100 disabled:pointer-events-none"
              >
                <X className="size-3" />
              </button>
            </Badge>
          )}
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            {pushed && (
              <Badge
                variant="outline"
                className={cn("h-5 gap-1 px-1.5 text-[10px]", BANNER_TONES.emerald)}
              >
                <Check className="size-3" />
                pushed {formatRelative(new Date(pushed.at))}
              </Badge>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onResetToLive}
              disabled={staged === null}
              title="Drop the staged edits and reload the live pool"
            >
              <RotateCcw className="size-3.5" />
              Reset to live
            </Button>
            <Button
              variant="ghost"
              size="sm"
              nativeButton={false}
              render={<Link href="/pack-studio/doctor" />}
            >
              <Stethoscope className="size-3.5" />
              Open in Doctor
            </Button>
            <LegendPopover />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant="outline"
            className={cn("h-5 gap-1 px-1.5 text-[10px]", badge.className)}
          >
            {badge.spin && <Loader2 className="size-3 animate-spin" />}
            {badge.label}
          </Badge>
          {plan && (
            <span className="text-[11px] text-muted-foreground">
              plan computed {formatRelative(new Date(plan.computedAtIso))}
            </span>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={onReplan}
            disabled={status === "planning" || status === "pushing"}
            title="Bypass the 60s cache and re-plan fresh (recovery path for external drift)"
          >
            Re-plan
          </Button>
        </div>
      </div>

      {/* ── F17 rehydrated-drift prompt (blocks reuse until answered) ────── */}
      {driftPrompt && (
        <Banner tone="amber" icon={TriangleAlert}>
          <p className="font-medium">{F17_REHYDRATED_DRIFT}</p>
          <div className="flex flex-wrap gap-2 pt-1">
            <Button type="button" size="sm" variant="outline" onClick={onKeepRehydrated}>
              {F17_KEEP}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={onDiscardRehydrated}>
              {F17_DISCARD}
            </Button>
          </div>
        </Banner>
      )}

      {/* ── F9 / F11 write refusal panel ──────────────────────────────────── */}
      {refusal && (
        <Banner tone="rose" icon={TriangleAlert}>
          <p>{refusal.message}</p>
          {refusal.kind === "skew" && refusal.details && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                void navigator.clipboard.writeText(refusal.details ?? "");
              }}
            >
              <ClipboardCopy className="size-3.5" />
              {COPY_DETAILS}
            </Button>
          )}
        </Banner>
      )}

      {/* ── F8 re-based note ─────────────────────────────────────────────── */}
      {rebased && (
        <Banner tone="amber" icon={TriangleAlert}>
          <p>{F8_REBASED}</p>
        </Banner>
      )}

      {/* ── Post-push success panel ("Next: {name} →" — never auto-nav) ──── */}
      {status === "pushed" && nextSuggestion && (
        <Banner tone="emerald" icon={Check}>
          <div className="flex flex-wrap items-center gap-2">
            <span>Pushed. Re-stage to tune again.</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => onSelectPack(nextSuggestion.packId)}
            >
              Next: {nextSuggestion.name} <ArrowRight className="size-3.5" />
            </Button>
          </div>
        </Banner>
      )}

      {/* ── Off-tag live strip (independent, ABOVE the banner slot) ──────── */}
      {/* Reports live truth (live win-rate vs the pack's actual live tag) —
          but staged-AWARE: once a tag override is staged, the copy names the
          override and what pushing writes instead of the stale "the tag says
          X% — pushing fixes it". No override ⇒ byte-identical legacy strip. */}
      {row.offTagLive && row.tag !== null && (
        <Banner tone="amber" icon={Tag}>
          <p>
            {tagOverride === undefined
              ? offTagStrip(row.winRate, row.tag, plan?.feasible === true)
              : tagOverride.kind === "untag"
                ? offTagStripUntagStaged(row.winRate, row.tag)
                : offTagStripRetagStaged(
                    row.winRate,
                    row.tag,
                    tagOverride.hitRate,
                  )}
          </p>
        </Banner>
      )}

      {/* ── §5b KPI strip ─────────────────────────────────────────────────── */}
      <SectionHeading
        icon={Sparkles}
        title="Plan"
        action={
          staged !== null ? (
            <div className="flex items-center gap-1.5">
              {staged.pinnedOdds.length > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs text-amber-600 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300"
                  onClick={onClearAllPins}
                  title="Drop every pinned chance on this pack and re-plan"
                >
                  <PinOff className="size-3.5" />
                  {clearAllPinsLabel(staged.pinnedOdds.length)}
                </Button>
              )}
              {/* Owner ask: the restart affordance must be findable at a
                  glance whenever a staged pool exists — this duplicates the
                  header button right next to the plan/pool controls. */}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={onResetToLive}
                title="Drop the staged edits and reload the live pool"
              >
                <RotateCcw className="size-3.5" />
                Reset to live
              </Button>
            </div>
          ) : undefined
        }
      />
      {before ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
          <PlanMetric
            label="House edge"
            icon={Gauge}
            accent={
              afterRisk && targets
                ? afterRisk.edge >= targets.targetEdge - 1e-9
                  ? "emerald"
                  : "rose"
                : "blue"
            }
            sub={
              targets
                ? `${edgeTargetSub(
                    targets.targetEdge,
                    staged?.edgeTargetOverride !== undefined
                      ? "override"
                      : "curve",
                  )}${showEstimate ? " · estimate" : ""}`
                : undefined
            }
          >
            <BeforeAfter
              before={pct(before.edge)}
              after={
                afterRisk ? (
                  <AnimatedNumber value={afterRisk.edge * 100} format="percent" />
                ) : null
              }
            />
            {plan && plan.after && plan.priceAfter > 0 && !showEstimate && (
              <div className="mt-1.5 flex basis-full items-center gap-1 text-xs font-normal">
                <Input
                  type="text"
                  inputMode="decimal"
                  placeholder="11.1"
                  className="h-7 w-20 rounded-md text-xs font-normal tabular-nums"
                  title="Type a desired edge % and press Enter — raises the price to hit it, no odds changes."
                  defaultValue=""
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      const val = Number.parseFloat(
                        (e.target as HTMLInputElement).value,
                      );
                      if (Number.isFinite(val) && val > 0 && val < 90) {
                        onSetEdgeTarget(val / 100);
                      }
                    }
                  }}
                />
                <span className="text-[10px] text-muted-foreground">% edge — raises price, no odds changes</span>
              </div>
            )}
          </PlanMetric>
          <PlanMetric
            label="Win rate"
            icon={Trophy}
            accent={winTone}
            sub={
              tag !== null
                ? afterRisk
                  ? Math.abs(afterRisk.winRate - tag) <=
                    TAGGED_WRITE_WINRATE_TOLERANCE + 1e-12
                    ? `tag ${tagBadgeLabel(tag)} · ${WIN_RATE_ON_TAG}`
                    : afterRisk.winRate > tag
                      ? `tag ${tagBadgeLabel(tag)} · ${WIN_RATE_OVER_TAG}`
                      : `tag ${tagBadgeLabel(tag)} · under tag`
                  : `tag ${tagBadgeLabel(tag)}`
                : `default ${targets ? pct(targets.targetWinRate) : "20.00%"}`
            }
          >
            <BeforeAfter
              before={pct(before.winRate)}
              after={
                afterRisk ? (
                  <AnimatedNumber
                    value={afterRisk.winRate * 100}
                    format="percent"
                  />
                ) : null
              }
            />
          </PlanMetric>
          <PlanMetric
            label="Pack price"
            icon={Ticket}
            accent="blue"
            sub={
              staged?.pinPrice
                ? pricePinnedSub(staged.price ?? row.price, row.price)
                : plan && Math.abs(priceDelta) > 1e-9
                  ? priceMoveSub(priceDelta, plan.snapped !== false)
                  : "price unchanged"
            }
          >
            <BeforeAfter
              before={formatCurrency(plan?.price ?? row.price)}
              after={
                plan ? (
                  <AnimatedNumber value={plan.priceAfter} format="currency" />
                ) : null
              }
            />
          </PlanMetric>
          <PlanMetric
            label="Max win"
            icon={Layers}
            accent={
              afterRisk && targets
                ? afterRisk.maxWin <= targets.maxWinCap + 1e-9
                  ? "emerald"
                  : "rose"
                : "blue"
            }
            sub={targets ? `cap ${formatCurrency(targets.maxWinCap)}` : undefined}
          >
            <BeforeAfter
              before={formatCurrency(before.maxWin)}
              after={
                afterRisk ? (
                  <AnimatedNumber value={afterRisk.maxWin} format="currency" />
                ) : null
              }
            />
          </PlanMetric>
          <PlanMetric
            label="Risk level"
            icon={Gauge}
            accent="blue"
            sub={
              afterRisk && afterRisk.tier !== before.tier
                ? `${before.tier} → ${afterRisk.tier}`
                : undefined
            }
          >
            {/* Owner ask 2026-07-11: the game-style 5-segment LEVEL BAR, not
                a bare CV number — the CV rides as the muted suffix. */}
            <RiskLevelBar
              tier={(afterRisk ?? before).tier}
              cv={(afterRisk ?? before).cv}
            />
          </PlanMetric>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
          {/* h matches the real PlanMetric tile (icon row + value + sub) so
              the grid doesn't jump when data swaps in. */}
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className="h-[92px] animate-pulse rounded-xl border bg-muted/30"
            />
          ))}
        </div>
      )}

      {/* ── §5c the ONE banner slot ───────────────────────────────────────── */}
      {banner}

      {/* ── §5d pool zone (rendered by the workspace) ─────────────────────── */}
      {children}

      {/* ── §5e push row (sticky bottom, right-aligned) ───────────────────── */}
      <div className="sticky bottom-0 -mx-1 flex flex-col items-end gap-1.5 rounded-t-lg border-t bg-background/95 px-1 py-3 backdrop-blur">
        <Button
          type="button"
          onClick={onPush}
          disabled={!pushEnabled || pushing || edgeFloorBlocked || edgeBelowTarget}
        >
          {pushing && <Loader2 className="size-4 animate-spin" />}
          {pushDisabledLabel ?? PUSH_LABEL}
        </Button>
        {plan && pushEnabled && !edgeFloorBlocked && !edgeBelowTarget && (
          <p className="text-right text-[11px] text-muted-foreground">
            {pushSubLine({
              priceAfter: plan.priceAfter,
              oddsChanges,
              added: addedCount,
              removed: removedCount,
            })}
          </p>
        )}
      </div>
    </div>
  );
}
