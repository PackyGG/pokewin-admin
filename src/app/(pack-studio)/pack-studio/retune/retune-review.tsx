"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  ChevronDown,
  DollarSign,
  Loader2,
  RotateCcw,
  Scale,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { SectionHeading } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { DEFAULT_MAX_MULT_CEILING } from "@/app/(admin)/packs/_lib/auto-targets";
import {
  computePackRisk,
  searchBestPriceForCleanSnap,
  RETUNE_MAX_PRICE_CHANGE_PCT,
  type PackRisk,
  type ShapeWeightsLimit,
  type ShapeWeightsRelaxation,
} from "@/app/(admin)/insights/edge-calc/risk";
import {
  authorizePackRetuneForReview,
  applyPackRetune,
  type PackRetuneTargets,
} from "@/app/(admin)/packs/actions";
import {
  planAllRetunes,
  planSingleRetune,
  applyPackEdit,
  applyStagedPackEditAndRetune,
  type PlanAllProposal,
  type PlanAllWeightDiff,
  type PortfolioProfileResult,
} from "../doctor/retune-actions";
import type { EditorTargets, EditPreview } from "./pool-editor";
import type { PortfolioSystemPlan } from "@/app/(admin)/packs/_lib/portfolio";

import { ReviewCard } from "./review-card";
import { ReviewRail } from "./review-rail";
import { SystemBalancePanel } from "./system-balance";
import { RetuneGuide, RetuneGlossary } from "./retune-guide";
import { formatDeltaPp, formatPercent } from "./format-percent";

/**
 * Bulk Re-tune Review orchestrator (operator-only, client). Drives the Tinder-
 * style card stack over `planAllRetunes()` proposals:
 *
 *   1. "Start review" gate — mints ONE retune token via
 *      `authorizePackRetuneForReview` (operator + capability check, NO 2FA).
 *      The token authorizes every approve-write for the session.
 *   2. Card stack — one pack at a time. APPROVE → `applyPackRetune(packId, token,
 *      targets)` (the server re-shapes fresh + writes); DECLINE/SKIP → advance,
 *      no write; ADJUST → re-shape LOCALLY via the pure `shapeWeights` and send
 *      the adjusted levers on approve; BACK → revisit the previous pack.
 *   3. Token expiry — if a write returns the "authorization expired" error, a
 *      fresh token is minted silently and the SAME approve is retried.
 *
 * SYSTEM BALANCE — a header panel (fed by `getPortfolioProfileFromProposals`,
 * derived from the loaded proposals — no extra DB read) profiles the
 * WHOLE catalog (tier histogram, jackpot exposure vs cap, aggregate CV, spicy
 * share). A "Balance whole system" toggle re-loads the proposals via
 * `planAllRetunes("portfolio")` so the cross-pack balancer's system-targets drive
 * every card, and shows the `systemPlan` (what got tightened + why).
 *
 * Nothing is persisted until APPROVE. Only approved packs ever write. The pure
 * client-safe `shapeWeights`/`computePackRisk` mirror the server's math, so the
 * adjusted after-preview matches what `applyPackRetune` will (re-)compute and
 * fail-close on.
 *
 * 2FA — the owner explicitly removed the per-session 2FA prompt from THIS flow
 * (annoying friction; the operator + capability + scope + audit guards on every
 * write still hold). Other retune entry points (history revert, doctor drawer,
 * bulk-retune button) keep their TOTP dialogs.
 */

/** Local lever overrides for an adjusted re-tune (re-shaped client-side). */
export type AdjustedTargets = {
  targetWinRate: number;
  maxWinCap: number | undefined;
  nearMissMin: number;
};

/** The result of a local re-shape (or its error) for an adjusted proposal. */
export type AdjustedState = AdjustedTargets & {
  feasible: boolean;
  after: PackRisk | null;
  weightDiff: PlanAllWeightDiff[] | null;
  /**
   * The price the adjusted search landed on (`search.bestPrice`) — the FINAL
   * price an Approve of this adjustment will write. The search picks (price,
   * weights) as a PAIR, so `after` is scored AT this price (scoring at the
   * stale proposal price skewed the after-KPIs by up to 3.56pp of edge).
   * Threaded into the write as `approvedPriceAfter` (RC1 approved-artifact
   * contract) and shown by the confirm gate so preview == gate == write.
   * Null when the local re-shape errored.
   */
  priceAfter: number | null;
  /** Soft targets the local solver relaxed (empty when nothing relaxed). */
  relaxations: ShapeWeightsRelaxation[];
  error?: string;
  /** Structured hard limit when the local re-shape is infeasible. */
  limit: ShapeWeightsLimit | null;
};

export type ReviewStatus = "pending" | "approved" | "declined";

/**
 * What an "Edit pool" Approve hands up. Discriminated by `mode`:
 *  • "verbatim" — the owner's exact odds become positive-integer weights and
 *    are written via `applyPackEdit` (advanced escape hatch — no shaping).
 *  • "auto-tune" — only the pool IDENTITY (cards + order + color/animation +
 *    optional new price) is sent. The server runs `shapeWeights` against the
 *    pack's auto-targets and writes optimized weights via the new
 *    `applyStagedPackEditAndRetune` action. This is the SAFE path.
 */
export type EditApprovePayload =
  | {
      mode: "verbatim";
      cards: {
        cardId: string;
        weight: number;
        color?: string;
        animation?: boolean;
        order: number;
      }[];
      price?: number;
      hasAddedCards: boolean;
      /** Local before/after for the confirm-gate KPI grid + per-card diff. */
      preview: EditPreview;
    }
  | {
      mode: "auto-tune";
      cards: {
        cardId: string;
        color?: string;
        animation?: boolean;
        order: number;
      }[];
      price?: number;
      hasAddedCards: boolean;
      /**
       * Owner opt-in: when true the server may nudge the pack price by up to
       * ±25% around the staged price to land cleaner odds (the price-search
       * lever in `applyStagedPackEditAndRetune`). Defaults undefined/false.
       */
      allowPriceSearch?: boolean;
      /** Local before/after for the confirm-gate KPI grid + per-card diff. */
      preview: EditPreview;
    };

export type ReviewItem = {
  proposal: PlanAllProposal;
  status: ReviewStatus;
  /** Active local adjustment (supersedes the server proposal in the UI). */
  adjusted: AdjustedState | null;
};

/**
 * Per-review-session edge-target nudge presets. The baseline (11.02%) is what
 * the auto-targets produce today (`autoTargetEdge` floor + the per-pack risk
 * premium); the higher presets are pure operator nudges — the same lever the
 * server's `applyPackRetune` / `applyStagedPackEditAndRetune` already honour
 * via their optional `targetEdge` argument (validated to [1%, 50%] by
 * `resolveRepriceTarget` / clamped to `auto.targetEdge` fallback). Selecting a
 * preset here just threads its fraction into `buildTargets` + the local
 * `shapeWeights` call so the on-screen "after" matches what the server will
 * (re-)shape against.
 */
export const EDGE_TARGET_PRESETS = [
  { label: "Baseline", pct: 11.02, value: 0.1102 },
  { label: "+0.08pp", pct: 11.1, value: 0.111 },
  { label: "+0.18pp", pct: 11.2, value: 0.112 },
  { label: "+0.23pp", pct: 11.25, value: 0.1125 },
  { label: "+0.28pp", pct: 11.3, value: 0.113 },
] as const;

/** The default (baseline) preset value — equals the standard auto-target edge. */
export const EDGE_TARGET_BASELINE = EDGE_TARGET_PRESETS[0].value;

/**
 * Resolve the EFFECTIVE target edge for a review item.
 *
 * The proposal's `autoTargets.targetEdge` is already the authoritative target:
 * when an `edgeOverride` is active, `planAllRetunes` was re-run with that
 * override as the curve's edge floor, so every pack's `autoTargets.targetEdge`
 * is already `≥ override`. We take `max(proposal target, override)` as a
 * belt-and-braces guard so the local "after" preview never accidentally shapes
 * below the operator's nudged floor (e.g. if a reload race left a stale
 * proposal in the queue for one render).
 */
function effectiveTargetEdge(
  item: ReviewItem,
  edgeOverride: number | null,
): number {
  const baseline = item.proposal.autoTargets.targetEdge;
  if (edgeOverride !== null && Number.isFinite(edgeOverride)) {
    return Math.max(baseline, edgeOverride);
  }
  return baseline;
}

/** Build the `PackRetuneTargets` payload sent to `applyPackRetune` for an item.
 *
 * ALWAYS opts the write into the clean-snap price-search path — the chip-strip
 * preview the operator approved was already produced via the same search (see
 * `planAllRetunes`), so the write must use the same lever or the displayed
 * "after" weights won't match what lands in MAIN. When the operator nudged the
 * edge target via the chip-strip (`edgeOverride !== null`), the upward search
 * band is extended to +200% so the ticket can RISE as far as needed to land
 * (raised edge + clean ladder odds + tag/default win-rate) simultaneously —
 * matching the owner's spec: "u can change the price of the pack to keep the
 * edge better or chances". A local adjust resets `edgeOverride` semantics: it
 * still uses the price-search, but only at the symmetric ±60% retune band
 * (`RETUNE_MAX_PRICE_CHANGE_PCT` — shared with the planner and the write).
 */
function buildTargets(
  item: ReviewItem,
  edgeOverride: number | null,
  priceOverride: number | null,
): PackRetuneTargets {
  const { autoTargets } = item.proposal;
  const a = item.adjusted;
  const edgeRaised = edgeOverride !== null && Number.isFinite(edgeOverride);
  // RC1 approved-artifact contract: pin the previewed FINAL price so the
  // server refuses (no write) if its re-solve lands anywhere else. With an
  // active Adjust the artifact is the adjust panel's own re-solve (it ran the
  // search with the adjusted levers — the server will too); otherwise it's
  // the server proposal's `priceAfter`. A STALE proposal (override changed,
  // nav-lazy recompute not landed yet) pins its pre-override price — the
  // server's mismatch refusal is exactly the fail-closed behavior we want
  // there. NOTE: an Adjust artifact is solved in the BROWSER's JS engine; the
  // search is integer/IEEE-arithmetic-deterministic, so a cross-engine
  // divergence would itself be a nondeterminism bug the refusal must surface.
  const approvedPriceAfter = a
    ? a.priceAfter
    : item.proposal.feasible
      ? item.proposal.priceAfter
      : null;
  return {
    targetEdge: effectiveTargetEdge(item, edgeOverride),
    targetWinRate: a ? a.targetWinRate : autoTargets.targetWinRate,
    maxWinCap: a ? a.maxWinCap : autoTargets.maxWinCap,
    nearMissMin: a ? a.nearMissMin : autoTargets.nearMissMin,
    allowPriceSearch: true,
    upwardPriceExtensionPct: edgeRaised ? 2.0 : 0,
    ...(priceOverride !== null && Number.isFinite(priceOverride) && priceOverride > 0
      ? { priceOverride }
      : {}),
    ...(approvedPriceAfter !== null && Number.isFinite(approvedPriceAfter)
      ? { approvedPriceAfter }
      : {}),
    // RC1 pool-freshness token — the fingerprint of the pool the proposal was
    // solved from; the write recomputes it over the fresh pool and refuses on
    // drift. Guarded truthy for safety against a pre-fingerprint blob.
    ...(item.proposal.poolFingerprint
      ? { approvedPoolFingerprint: item.proposal.poolFingerprint }
      : {}),
  };
}

/** Build the `targets` payload for `applyStagedPackEditAndRetune` (the staged
 * edit-and-retune Approve). Shares the lever resolution with `buildTargets`
 * (effective edge + adjusted-or-auto win-rate/cap/near-miss) but deliberately
 * DOES NOT forward the plain-path price-search levers:
 *
 *  • `allowPriceSearch` comes STRICTLY from the editor's "Allow price
 *    adjustment" checkbox (the payload). `buildTargets` pins it `true` for the
 *    plain Approve — spreading that over the staged call made the checkbox
 *    dead (an unticked box still price-searched on the server while the gate
 *    showed no price warning).
 *  • `upwardPriceExtensionPct` / `priceOverride` are chip-strip levers of the
 *    PLAIN `applyPackRetune` path; the staged action doesn't accept them —
 *    its search always anchors on the staged price at the default ±25% band.
 */
function buildStagedTargets(
  item: ReviewItem,
  edgeOverride: number | null,
  priceOverride: number | null,
  payload: Extract<EditApprovePayload, { mode: "auto-tune" }>,
): {
  targetEdge: number;
  targetWinRate: number;
  maxWinCap: number | undefined;
  nearMissMin: number;
  allowPriceSearch: boolean;
  approvedPriceAfter?: number;
  approvedPoolFingerprint?: string;
} {
  const t = buildTargets(item, edgeOverride, priceOverride);
  const allowPriceSearch = payload.allowPriceSearch === true;
  // RC1 approved-artifact contract (staged flavor): the staged pool identity
  // travels verbatim, so only price + pool-freshness need pinning.
  //  • Price — authoritative ONLY when the search lever is OFF (the server
  //    then writes the staged price exactly: `payload.price`, or the live
  //    price when unchanged). With the lever ON the server legitimately picks
  //    the final price, so nothing is pinned: the editor preview DOES show
  //    its own search's expected price (EditPreview.newPrice, C2-F5), but
  //    that client mirror omits the server's currentWeights/winRateTol/
  //    taggedWinRate params and may legitimately land elsewhere — pinning it
  //    would refuse valid approves. The fingerprint still guards freshness.
  //  • Fingerprint — always: the staged solve still anchors on the LIVE pool
  //    (anti-inflation weights + live price), so live-state drift between
  //    plan and approve must refuse.
  const approvedPriceAfter = allowPriceSearch
    ? null
    : payload.price ?? item.proposal.price;
  return {
    targetEdge: t.targetEdge!,
    targetWinRate: t.targetWinRate!,
    maxWinCap: t.maxWinCap,
    nearMissMin: t.nearMissMin!,
    allowPriceSearch,
    ...(approvedPriceAfter !== null && Number.isFinite(approvedPriceAfter)
      ? { approvedPriceAfter }
      : {}),
    ...(item.proposal.poolFingerprint
      ? { approvedPoolFingerprint: item.proposal.poolFingerprint }
      : {}),
  };
}

/** Detect the retune-token-expiry error so we can re-prompt 2FA + retry. */
function isTokenExpired(message: string): boolean {
  return message.includes("authorization expired");
}

/** Format a fraction as a 2-dp percent (mirrors the review card's `pct`). */
function pct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(2)}%`;
}

/**
 * Targets the inline pool editor's "Re-shape to targets" button shapes onto. The
 * edge always comes from the pack's auto-target (the house-edge knob is not an
 * operator lever); win-rate / cap / near-miss follow the active local adjustment
 * when one exists, else the auto-targets — so a re-shape inside the editor honours
 * any "Adjust" the owner already made.
 */
function editorTargetsFor(
  item: ReviewItem,
  edgeOverride: number | null,
): EditorTargets {
  const { autoTargets } = item.proposal;
  const a = item.adjusted;
  return {
    targetEdge: effectiveTargetEdge(item, edgeOverride),
    targetWinRate: a ? a.targetWinRate : autoTargets.targetWinRate,
    maxWinCap: a ? a.maxWinCap : autoTargets.maxWinCap,
    nearMissMin: a ? a.nearMissMin : autoTargets.nearMissMin,
  };
}

export function RetuneReview({
  proposals,
  portfolio,
}: {
  proposals: PlanAllProposal[];
  portfolio: PortfolioProfileResult;
}) {
  const router = useRouter();

  const [items, setItems] = React.useState<ReviewItem[]>(() =>
    proposals.map((p) => ({ proposal: p, status: "pending", adjusted: null })),
  );
  const [index, setIndex] = React.useState(0);
  const [started, setStarted] = React.useState(false);
  const [applying, setApplying] = React.useState(false);
  // The index whose inline pool editor is open (null = none). Reset on navigate.
  const [editingIndex, setEditingIndex] = React.useState<number | null>(null);

  // ── Two-step confirm gate before any prod write ─────────────────────
  // Both Approve paths (plain retune + edited-pool) route through this gate: a
  // first "push this live?" dialog, then a final hard "100% sure" confirm. Only
  // the final confirm fires the write. The retune token (no longer 2FA-gated for
  // this flow) still guards the server action; a token-expiry retry re-mints
  // silently and re-enters the perform* fns WITHOUT re-opening the gate (the
  // gate sits at the entry points, not inside perform*).
  type PendingWrite =
    | { kind: "retune"; index: number }
    | {
        kind: "edit";
        index: number;
        payload: Extract<EditApprovePayload, { mode: "verbatim" }>;
      }
    | {
        kind: "edit-and-retune";
        index: number;
        payload: Extract<EditApprovePayload, { mode: "auto-tune" }>;
      };
  const [pendingWrite, setPendingWrite] = React.useState<PendingWrite | null>(
    null,
  );
  // 0 = closed, 1 = first dialog, 2 = final hard confirm.
  const [confirmStep, setConfirmStep] = React.useState<0 | 1 | 2>(0);

  // ── Per-session edge-target override ────────────────────────────────
  // Owner-chosen target-edge nudge that applies to EVERY approve write this
  // session (until reset). `null` = use each pack's auto-target; a number =
  // override every pack's targetEdge with this fraction. The chip strip is the
  // only UI surface for this; the value flows through `buildTargets` (sent to
  // `applyPackRetune` / `applyStagedPackEditAndRetune` — both already accept an
  // optional `targetEdge`) and into the local `shapeWeights` call so the
  // on-screen "after" matches what the server will (re-)shape against.
  const [edgeOverride, setEdgeOverride] = React.useState<number | null>(null);

  // ── Per-session price-target override ───────────────────────────────
  // Operator-pinned absolute ticket price (USD). `null` = each pack searches
  // around its OWN live price; a number = the search re-anchors on this USD
  // value for every pack this session. Threads through `planAllRetunes`'s
  // `priceOverride` opt AND `buildTargets`'s `priceOverride` field so both
  // the dry-run preview (chip-strip table) and the eventual server write
  // (`applyPackRetune`) share the same anchor. Same UX pattern as the
  // chip-strip: re-runs on change and SURVIVES a system-balance toggle (the
  // toggle threads it through the reload).
  //
  // SAFETY: when an anchor is active, the search runs in `preferHigherEdge`
  // mode so a lower anchor doesn't silently give up edge — the scorer will
  // still pick the candidate with the highest achievable house edge ≥ target.
  const [priceOverride, setPriceOverride] = React.useState<number | null>(null);

  // ── System-balance mode ─────────────────────────────────────────────
  // Off = per-pack auto-targets (the default load). On = portfolio mode: the
  // proposals are re-loaded via `planAllRetunes("portfolio")` so the cross-pack
  // balancer's system-targets drive every card; `systemPlan` explains the
  // tightening.
  const [portfolioMode, setPortfolioMode] = React.useState(false);
  const [systemPlan, setSystemPlan] = React.useState<PortfolioSystemPlan | null>(
    null,
  );
  const [reloading, setReloading] = React.useState(false);

  // ── Stale-on-nudge tracker (single-pack-on-demand chip recompute) ───
  // A chip-strip nudge OR a target-price change used to call
  // `planAllRetunes(mode, { ... })`, which recomputes ALL ~183 packs server-
  // side: at 800 `searchBestPriceForCleanSnap` candidates per pack under an
  // edge nudge, that's ~146k shapeWeights calls and times out at the Vercel
  // gateway (owner-reported ~3-min stall). The fix: recompute ONLY the pack
  // the operator is reviewing on click (≈100ms), mark the others as stale,
  // and lazily recompute each one as the operator navigates to it. The other
  // packs keep their pre-nudge proposal until approached — they're stale-
  // but-displayable.
  //
  // `staleIds` carries pack ids whose proposal is older than the current
  // (edgeOverride, priceOverride). The current pack is always recomputed
  // synchronously by the chip handler so the operator sees the new shape
  // immediately; navigating to a stale pack triggers a background recompute
  // (see the `goTo` / `advance` effect below) without blocking the UI.
  const [staleIds, setStaleIds] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // True while a single-pack recompute (chip click OR background nav-lazy)
  // is in flight. Drives the chip-strip + price-input spinners.
  const [recomputingSingle, setRecomputingSingle] = React.useState(false);

  // The session retune token (kept in a ref so the approve loop reads the
  // latest after a re-mint without a stale closure). The token is minted by
  // the "Start review" button (no 2FA prompt for this flow) and silently
  // re-minted on expiry.
  const tokenRef = React.useRef<string | null>(null);
  // True while the "Start review" mint or a silent token re-mint is in flight.
  const [authBusy, setAuthBusy] = React.useState(false);

  // ── Re-seed on fresh server proposals (post-write router.refresh()) ──
  // `items` is seeded once from the initial `proposals` prop and the component
  // is never re-keyed — so a post-approve `router.refresh()` used to stream
  // FRESH proposals into a client that kept showing (and approving!) the old
  // ones. React's derived-state-from-props pattern: compare the prop identity
  // during render and merge the fresh proposals in, preserving each pack's
  // VERDICT (status keyed by packId — an approved pack was already written,
  // it must not become re-approvable). Local adjustments are reset: they were
  // shaped against the superseded pool. With an active edge/price override
  // the fresh baseline proposals are immediately marked stale so the nav-lazy
  // effect re-shapes each one at the operator's nudge on approach.
  //
  // Skipped in portfolio mode: the refreshed prop payload is the PER-PACK
  // dry-run (the server page always loads per-pack), so seeding it while the
  // system-balance toggle is on would silently flip every card's targeting.
  // Portfolio proposals only ever come from the toggle's own reload path.
  const [seededProposals, setSeededProposals] = React.useState(proposals);
  if (proposals !== seededProposals) {
    setSeededProposals(proposals);
    if (!portfolioMode) {
      setItems((prev) => {
        const prevById = new Map(prev.map((it) => [it.proposal.packId, it]));
        return proposals.map((p) => ({
          proposal: p,
          status: prevById.get(p.packId)?.status ?? ("pending" as ReviewStatus),
          adjusted: null,
        }));
      });
      setIndex((i) => Math.min(i, Math.max(0, proposals.length - 1)));
      setStaleIds(
        edgeOverride !== null || priceOverride !== null
          ? new Set(proposals.map((p) => p.packId))
          : new Set(),
      );
    }
  }

  const total = items.length;
  const approved = items.filter((i) => i.status === "approved").length;
  const declined = items.filter((i) => i.status === "declined").length;
  const pending = total - approved - declined;
  const current = items[index];

  // ── Approve staleness gate ──────────────────────────────────────────
  // The displayed proposal is NOT what an Approve would act on while (a) the
  // current pack is marked stale (shaped against a superseded edge/price
  // override), (b) a single-pack recompute is in flight, or (c) a full
  // system-balance reload is replacing the queue. Approving in any of those
  // windows writes from numbers the operator isn't looking at — so the
  // Approve button AND the keyboard "A" shortcut are disabled until the
  // fresh proposal lands (the review card shows a small recomputing note).
  const currentStale =
    current != null && staleIds.has(current.proposal.packId);
  const approveBlocked = currentStale || recomputingSingle || reloading;

  // ── Navigation ──────────────────────────────────────────────────────
  const goTo = React.useCallback(
    (i: number) => {
      if (i < 0 || i >= total) return;
      setEditingIndex(null);
      setIndex(i);
    },
    [total],
  );
  const advance = React.useCallback(() => {
    setEditingIndex(null);
    setIndex((i) => Math.min(i + 1, total - 1));
  }, [total]);

  // ── System-balance toggle ───────────────────────────────────────────
  // Re-load every proposal in the requested mode. Per-pack VERDICTS are
  // PRESERVED across the reload (keyed by packId) — an already-approved pack
  // was already WRITTEN to MAIN, and resetting it to "pending" made it
  // re-approvable (double write). Local adjustments ARE reset: the underlying
  // auto-targets change with the mode, so a lever tweak shaped against the
  // old targets no longer applies. READ-ONLY: `planAllRetunes` writes
  // nothing — it's a dry-run, like the initial load. The active
  // `edgeOverride` + `priceOverride` are threaded through so toggling
  // system-balance doesn't silently revert the operator's nudges.
  const onToggleSystemBalance = React.useCallback(
    async (next: boolean) => {
      if (reloading) return;
      setReloading(true);
      try {
        const res = await planAllRetunes(next ? "portfolio" : "per-pack", {
          edgeFloorOverride: edgeOverride,
          priceOverride,
        });
        setItems((prev) => {
          const prevById = new Map(prev.map((it) => [it.proposal.packId, it]));
          return res.proposals.map((p) => ({
            proposal: p,
            // Keep the operator's verdict for a pack they already decided on;
            // only packs new to the queue start pending.
            status: prevById.get(p.packId)?.status ?? ("pending" as ReviewStatus),
            adjusted: null,
          }));
        });
        setSystemPlan(res.systemPlan);
        setPortfolioMode(next);
        setIndex(0);
        // The full plan-all reload re-shaped every proposal with the current
        // overrides, so nothing is stale anymore.
        setStaleIds(new Set());
        if (next) {
          const tightened = res.systemPlan?.tightened.length ?? 0;
          toast.success(
            tightened > 0
              ? `System balance on — ${tightened} pack${tightened === 1 ? "" : "s"} tightened to fit the catalog bounds.`
              : "System balance on — the catalog already fits its bounds; no packs tightened.",
          );
        } else {
          toast.success("System balance off — every pack back on its own auto-targets.");
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to re-load proposals.");
      } finally {
        setReloading(false);
      }
    },
    [reloading, edgeOverride, priceOverride],
  );

  // ── Single-pack recompute primitive (chip-strip + price-input) ──────
  // Recomputes ONE pack's proposal with the given nudge and swaps it in. Used
  // by both nudge handlers AND the nav-lazy effect. Returns true on success so
  // the caller can clear the stale flag; returns false on error (the pack
  // keeps its prior proposal — a stale display is better than a missing one).
  // The cached server action makes a return-visit instant (same key tuple).
  const recomputeOne = React.useCallback(
    async (
      i: number,
      edge: number | null,
      price: number | null,
    ): Promise<boolean> => {
      const item = items[i];
      if (!item) return false;
      const packId = item.proposal.packId;
      try {
        const next = await planSingleRetune(packId, {
          edgeFloorOverride: edge,
          priceOverride: price,
        });
        if (!next) return false;
        setItems((prev) => {
          const arr = [...prev];
          // Re-find by packId — `i` may be stale if the queue was rebuilt.
          const idx = arr.findIndex((it) => it.proposal.packId === packId);
          if (idx < 0) return prev;
          arr[idx] = { ...arr[idx]!, proposal: next, adjusted: null };
          return arr;
        });
        setStaleIds((prev) => {
          if (!prev.has(packId)) return prev;
          const out = new Set(prev);
          out.delete(packId);
          return out;
        });
        return true;
      } catch {
        return false;
      }
    },
    [items],
  );

  // ── Edge-target nudge (chip strip on the review card) ───────────────
  // Operator picks a higher house-edge floor (presets 11.02 / 11.10 / 11.20 /
  // 11.25 / 11.30 %). Recomputes ONLY the current proposal synchronously via
  // `planSingleRetune` (≈100ms) and marks the rest as stale; the nav-lazy
  // effect recomputes each one on demand. `null` = baseline curve.
  // READ-ONLY — no MAIN writes.
  const onSelectEdgeTarget = React.useCallback(
    async (value: number | null) => {
      if (reloading || recomputingSingle) return;
      // No-op if the operator clicks the already-selected chip.
      if (value === edgeOverride) return;
      setRecomputingSingle(true);
      try {
        // Adopt the new override BEFORE recomputing so the nav-lazy effect
        // observes the matching value if the operator navigates immediately.
        setEdgeOverride(value);
        // Mark every other proposal stale — they were shaped against the OLD
        // override. The current pack is recomputed synchronously below, so
        // its id never appears in the stale set.
        const currentPackId = items[index]?.proposal.packId ?? null;
        setStaleIds(
          new Set(
            items
              .map((it) => it.proposal.packId)
              .filter((id) => id !== currentPackId),
          ),
        );
        // Recompute the current pack with the new override.
        const ok = await recomputeOne(index, value, priceOverride);
        if (!ok) {
          toast.error("Failed to re-shape at new edge target.");
          return;
        }
        toast.success(
          value == null
            ? "Edge target back to baseline."
            : `Edge target nudged to ${(value * 100).toFixed(2)}%.`,
        );
      } finally {
        setRecomputingSingle(false);
      }
    },
    [reloading, recomputingSingle, edgeOverride, items, index, priceOverride, recomputeOne],
  );

  // ── Per-session price-target override input ───────────────────────────
  // Operator commits an absolute USD anchor (or clears via null) → recompute
  // ONLY the current proposal synchronously, mark the rest as stale (nav-lazy
  // recompute fills them in on demand). `null` (or 0) = no anchor.
  // READ-ONLY dry-run, no MAIN writes.
  const onSetPriceOverride = React.useCallback(
    async (value: number | null) => {
      if (reloading || recomputingSingle) return;
      // No-op if the value didn't actually change.
      if (value === priceOverride) return;
      setRecomputingSingle(true);
      try {
        setPriceOverride(value);
        const currentPackId = items[index]?.proposal.packId ?? null;
        setStaleIds(
          new Set(
            items
              .map((it) => it.proposal.packId)
              .filter((id) => id !== currentPackId),
          ),
        );
        const ok = await recomputeOne(index, edgeOverride, value);
        if (!ok) {
          toast.error("Failed to re-shape at new target price.");
          return;
        }
        toast.success(
          value == null
            ? "Target price cleared — every pack searches around its live price."
            : `Target price set to $${value.toFixed(2)} — every pack re-anchored.`,
        );
      } finally {
        setRecomputingSingle(false);
      }
    },
    [reloading, recomputingSingle, priceOverride, items, index, edgeOverride, recomputeOne],
  );

  // ── Nav-lazy recompute ──────────────────────────────────────────────
  // When the operator navigates to a pack whose proposal is stale (was not
  // recomputed with the current edge/price override), kick off a background
  // recompute. The chip-strip spinner stays visible until it lands, but the
  // page is never blocked. The cached `planSingleRetune` makes a return
  // visit to an already-recomputed pack instant.
  React.useEffect(() => {
    const item = items[index];
    if (!item) return;
    const packId = item.proposal.packId;
    if (!staleIds.has(packId)) return;
    if (recomputingSingle) return;
    let cancelled = false;
    setRecomputingSingle(true);
    void (async () => {
      try {
        await recomputeOne(index, edgeOverride, priceOverride);
      } finally {
        if (!cancelled) setRecomputingSingle(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [index, items, staleIds, recomputingSingle, edgeOverride, priceOverride, recomputeOne]);

  // ── Local re-shape (Adjust) ─────────────────────────────────────────
  // Routes through `searchBestPriceForCleanSnap` so the locally-previewed
  // weights match what the server will (re-)shape against on approve — the
  // chip-strip preview is already snapped, so the adjust panel must use the
  // same lever or the per-card percentages would jump on approve.
  const onAdjust = React.useCallback(
    (i: number, levers: AdjustedTargets) => {
      setItems((prev) => {
        const next = [...prev];
        const item = next[i];
        if (!item) return prev;
        const { proposal } = item;
        const targetEdge = effectiveTargetEdge(item, edgeOverride);
        const edgeRaised =
          edgeOverride !== null && Number.isFinite(edgeOverride);
        const priceAnchor =
          priceOverride !== null &&
          Number.isFinite(priceOverride) &&
          priceOverride > 0
            ? priceOverride
            : null;
        const preferHigherEdge = edgeRaised || priceAnchor !== null;
        // Tagged strict win-rate gate — same condition the server applies on
        // approve (`applyPackRetune`): the resolved target IS the name tag.
        // Moving the win-rate lever off the tag disables it on both sides.
        const taggedWinRate =
          proposal.intendedHitRate !== null &&
          Math.abs(proposal.intendedHitRate - levers.targetWinRate) < 1e-9
            ? proposal.intendedHitRate
            : undefined;
        const search = searchBestPriceForCleanSnap({
          cards: proposal.cards.map((c) => ({ value: c.value })),
          // Re-anchor the search on the operator's pinned target price when
          // set; else on the pack's live price. Keeps the local preview in
          // lockstep with `planAllRetunes` (server uses same anchor).
          basePrice: priceAnchor ?? proposal.price,
          // Honour the per-session edge-target override so the locally-shaped
          // "after" matches what the server will (re-)shape against on approve.
          targetEdge,
          targetWinRate: levers.targetWinRate,
          maxWinCap: levers.maxWinCap,
          nearMissMin: levers.nearMissMin,
          // Anti-inflation anchor — the pack's CURRENT weights, exactly what
          // the planner passed, so this local re-shape matches the server's.
          currentWeights: proposal.cards.map((c) => c.weight),
          // The SHARED ±60% retune band (planner + write + mirrors must agree
          // or the approved odds would differ from this preview).
          maxPriceChangePct: RETUNE_MAX_PRICE_CHANGE_PCT,
          upwardPriceExtensionPct: edgeRaised ? 2.0 : 0,
          preferHigherEdge,
          ...(taggedWinRate !== undefined ? { taggedWinRate } : {}),
        });
        const shaped = search.bestResult;
        let adjusted: AdjustedState;
        if ("error" in shaped) {
          adjusted = {
            ...levers,
            feasible: false,
            after: null,
            weightDiff: null,
            priceAfter: null,
            relaxations: [],
            error: shaped.error,
            limit: shaped.limit,
          };
        } else {
          // Re-derive the per-card weight diff from the locally shaped vector
          // (mirrors the server proposal's `weightDiff` shape) so Top Movers +
          // the after-preview reflect the adjustment instantly.
          const weightDiff = proposal.cards
            .map((c, idx) => ({ cardId: c.cardId, from: c.weight, to: shaped.weights[idx]! }))
            .filter((d) => d.from !== d.to);
          // Score from the freshly shaped weights AT THE SEARCHED PRICE —
          // the search picks (price, weights) as a pair; scoring at the stale
          // proposal price detached the after-KPIs from the weights (edge off
          // by up to 3.56pp, "below target" shown when the engine hit target).
          const after = computePackRisk({
            cards: proposal.cards.map((c, idx) => ({
              value: c.value,
              weight: shaped.weights[idx]!,
            })),
            price: search.bestPrice,
          });
          adjusted = {
            ...levers,
            feasible: true,
            after,
            weightDiff,
            // The artifact price this adjustment will write on Approve — the
            // server re-runs the SAME search and must land exactly here.
            priceAfter: search.bestPrice,
            relaxations: shaped.relaxations,
            error: undefined,
            limit: null,
          };
        }
        next[i] = { ...item, adjusted };
        return next;
      });
    },
    [edgeOverride, priceOverride],
  );

  const onResetAdjust = React.useCallback((i: number) => {
    setItems((prev) => {
      const next = [...prev];
      const item = next[i];
      if (!item) return prev;
      next[i] = { ...item, adjusted: null };
      return next;
    });
  }, []);

  // ── Reload proposals (re-run the server `planAllRetunes` dry-run) ────
  // Used by the "Recheck pool" button on the infeasibility error AND by the
  // pool editor's picker after the operator added at least one card during the
  // open session. `router.refresh()` re-mounts the Server Component shell so
  // every proposal is re-evaluated against the latest live pool — if the
  // operator's edits resolved the no-win-band-card limit, the rose banner
  // clears on the next paint. In-flight local state (active adjustment, open
  // editor) is reset by the remount; that's an intentional trade-off the
  // owner explicitly accepted in the ask (a manual + auto re-check).
  const [reloadPending, startReloadTransition] = React.useTransition();
  const onReload = React.useCallback(() => {
    if (reloadPending) return;
    startReloadTransition(() => {
      router.refresh();
    });
    toast.message("Re-checking pool…");
  }, [reloadPending, router]);

  // ── Approve (write) ─────────────────────────────────────────────────
  const performApprove = React.useCallback(
    async (i: number): Promise<void> => {
      const token = tokenRef.current;
      const item = items[i];
      if (!item || !token) return;
      // Guard: never write an infeasible pack.
      const feasible = item.adjusted ? item.adjusted.feasible : item.proposal.feasible;
      if (!feasible) {
        toast.error("This pack is infeasible — decline it or adjust the levers first.");
        return;
      }
      setApplying(true);
      try {
        const res = await applyPackRetune(
          item.proposal.packId,
          token,
          buildTargets(item, edgeOverride, priceOverride),
        );
        setItems((prev) => {
          const next = [...prev];
          if (next[i]) next[i] = { ...next[i]!, status: "approved" };
          return next;
        });
        toast.success(
          res.priceAfter !== res.priceBefore
            ? `Re-tuned ${res.name}: price $${res.priceBefore.toFixed(2)} → $${res.priceAfter.toFixed(2)} · edge ${(res.after.edge * 100).toFixed(2)}% · win ${(res.after.winRate * 100).toFixed(2)}%.`
            : `Re-tuned ${res.name}: edge ${(res.after.edge * 100).toFixed(2)}% · win ${(res.after.winRate * 100).toFixed(2)}%.`,
        );
        router.refresh();
        advance();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Re-tune failed.";
        if (isTokenExpired(message)) {
          // Silently re-mint a fresh retune token (no 2FA prompt for this flow)
          // and retry THIS approve on success.
          try {
            const { token: fresh } = await authorizePackRetuneForReview();
            tokenRef.current = fresh;
            const retry = await applyPackRetune(
              item.proposal.packId,
              fresh,
              buildTargets(item, edgeOverride, priceOverride),
            );
            setItems((prev) => {
              const next = [...prev];
              if (next[i]) next[i] = { ...next[i]!, status: "approved" };
              return next;
            });
            toast.success(
              retry.priceAfter !== retry.priceBefore
                ? `Re-tuned ${retry.name}: price $${retry.priceBefore.toFixed(2)} → $${retry.priceAfter.toFixed(2)} · edge ${(retry.after.edge * 100).toFixed(2)}% · win ${(retry.after.winRate * 100).toFixed(2)}%.`
                : `Re-tuned ${retry.name}: edge ${(retry.after.edge * 100).toFixed(2)}% · win ${(retry.after.winRate * 100).toFixed(2)}%.`,
            );
            router.refresh();
            advance();
          } catch (retryErr) {
            toast.error(
              retryErr instanceof Error ? retryErr.message : "Re-tune failed.",
            );
          }
        } else {
          toast.error(message);
        }
      } finally {
        setApplying(false);
      }
    },
    [items, router, advance, edgeOverride, priceOverride],
  );

  // Approve opens the two-step confirm gate instead of writing directly — the
  // pending retune write only fires from the gate's final "Push to production".
  // Refused while the current proposal is stale / recomputing (see
  // `approveBlocked`): the gate summary and the write targets would be built
  // from numbers the operator isn't looking at.
  const onApprove = React.useCallback(() => {
    if (applying || approveBlocked) return;
    setPendingWrite({ kind: "retune", index });
    setConfirmStep(1);
  }, [applying, approveBlocked, index]);

  const onDecline = React.useCallback(() => {
    if (applying) return;
    setItems((prev) => {
      const next = [...prev];
      if (next[index]) next[index] = { ...next[index]!, status: "declined" };
      return next;
    });
    advance();
  }, [applying, index, advance]);

  // ── Approve an EXPLICIT edited pool (writes via applyPackEdit) ───────
  // The inline pool editor hands up the exact pool it shows. This calls the
  // paranoid, operator+token-guarded `applyPackEdit` (writes the verbatim
  // weights/price, history-snapshotted). Token-expiry silently re-mints a fresh
  // token (no 2FA prompt for this flow) and retries THIS edit.
  const performEditApprove = React.useCallback(
    async (
      i: number,
      payload: Extract<EditApprovePayload, { mode: "verbatim" }>,
    ): Promise<void> => {
      const token = tokenRef.current;
      const item = items[i];
      if (!item || !token) return;
      setApplying(true);
      try {
        const res = await applyPackEdit(item.proposal.packId, token, {
          cards: payload.cards,
          ...(payload.price !== undefined ? { price: payload.price } : {}),
        });
        setItems((prev) => {
          const next = [...prev];
          if (next[i]) next[i] = { ...next[i]!, status: "approved" };
          return next;
        });
        setEditingIndex(null);
        toast.success(
          `Edited ${res.name}: edge ${(res.after.edge * 100).toFixed(2)}% · win ${(res.after.winRate * 100).toFixed(2)}% · ${res.cardCountAfter} cards.`,
        );
        router.refresh();
        advance();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Pool edit failed.";
        if (isTokenExpired(message)) {
          try {
            const { token: fresh } = await authorizePackRetuneForReview();
            tokenRef.current = fresh;
            const retry = await applyPackEdit(item.proposal.packId, fresh, {
              cards: payload.cards,
              ...(payload.price !== undefined ? { price: payload.price } : {}),
            });
            setItems((prev) => {
              const next = [...prev];
              if (next[i]) next[i] = { ...next[i]!, status: "approved" };
              return next;
            });
            setEditingIndex(null);
            toast.success(
              `Edited ${retry.name}: edge ${(retry.after.edge * 100).toFixed(2)}% · win ${(retry.after.winRate * 100).toFixed(2)}% · ${retry.cardCountAfter} cards.`,
            );
            router.refresh();
            advance();
          } catch (retryErr) {
            toast.error(
              retryErr instanceof Error ? retryErr.message : "Pool edit failed.",
            );
          }
        } else {
          toast.error(message);
        }
      } finally {
        setApplying(false);
      }
    },
    // Verbatim edit: the server writes operator-typed weights as-is — the
    // per-session edge-target override doesn't apply (no shaping happens).
    [items, router, advance],
  );

  // ── Approve a STAGED pool with SERVER-SIDE auto-tune (SAFE PATH) ─────
  // The inline pool editor hands up just the pool IDENTITY (no client weights).
  // This calls the paranoid, operator+token-guarded
  // `applyStagedPackEditAndRetune` — the server resolves the pack's auto-targets
  // (tag-aware win-rate + edge curve + cap), runs `shapeWeights` on the staged
  // identity, asserts the `EDIT_EDGE_FLOOR` + edge/cap/win-rate guards, and
  // writes optimized weights in ONE transaction with a snapshot first.
  // Token-expiry silently re-mints a fresh token (no 2FA prompt) and retries.
  const performEditAndRetuneApprove = React.useCallback(
    async (
      i: number,
      payload: Extract<EditApprovePayload, { mode: "auto-tune" }>,
    ): Promise<void> => {
      const token = tokenRef.current;
      const item = items[i];
      if (!item || !token) return;
      setApplying(true);
      try {
        // Send the pack's auto-targets (the same ones the per-pack Approve
        // path uses) so the server shapes against the SAME goals the review
        // card explains. The price-search lever is NOT spread from
        // `buildTargets` — that helper is the PLAIN-retune payload and pins
        // `allowPriceSearch: true` (+ the chip-strip's upward extension and
        // price anchor) unconditionally, which used to silently override the
        // editor's "Allow price adjustment" checkbox. The staged path takes
        // `allowPriceSearch` STRICTLY from the editor checkbox payload: an
        // unticked box means the server holds the staged price exactly.
        const res = await applyStagedPackEditAndRetune(
          item.proposal.packId,
          token,
          {
            cards: payload.cards,
            ...(payload.price !== undefined ? { price: payload.price } : {}),
          },
          buildStagedTargets(item, edgeOverride, priceOverride, payload),
        );
        setItems((prev) => {
          const next = [...prev];
          if (next[i]) next[i] = { ...next[i]!, status: "approved" };
          return next;
        });
        setEditingIndex(null);
        // Surface the price adjustment when the server moved off the staged
        // price (owner opted-in to the search AND it landed on a non-base
        // candidate). Otherwise the standard auto-tune confirmation only.
        const adjusted =
          res.priceSearch?.attempted === true &&
          res.priceSearch.chosen !== res.priceSearch.base;
        if (adjusted && res.priceSearch) {
          toast.success(
            `Price adjusted from ${formatCurrency(res.priceSearch.base)} to ${formatCurrency(res.priceSearch.chosen)} for cleaner odds.`,
          );
        }
        toast.success(
          `Auto-tuned ${res.name}: edge ${(res.after.edge * 100).toFixed(2)}% · win ${(res.after.winRate * 100).toFixed(2)}% · ${res.cardCountAfter} cards.`,
        );
        router.refresh();
        advance();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Auto-tune failed.";
        if (isTokenExpired(message)) {
          try {
            const { token: fresh } = await authorizePackRetuneForReview();
            tokenRef.current = fresh;
            const retry = await applyStagedPackEditAndRetune(
              item.proposal.packId,
              fresh,
              {
                cards: payload.cards,
                ...(payload.price !== undefined ? { price: payload.price } : {}),
              },
              buildStagedTargets(item, edgeOverride, priceOverride, payload),
            );
            setItems((prev) => {
              const next = [...prev];
              if (next[i]) next[i] = { ...next[i]!, status: "approved" };
              return next;
            });
            setEditingIndex(null);
            const retryAdjusted =
              retry.priceSearch?.attempted === true &&
              retry.priceSearch.chosen !== retry.priceSearch.base;
            if (retryAdjusted && retry.priceSearch) {
              toast.success(
                `Price adjusted from ${formatCurrency(retry.priceSearch.base)} to ${formatCurrency(retry.priceSearch.chosen)} for cleaner odds.`,
              );
            }
            toast.success(
              `Auto-tuned ${retry.name}: edge ${(retry.after.edge * 100).toFixed(2)}% · win ${(retry.after.winRate * 100).toFixed(2)}% · ${retry.cardCountAfter} cards.`,
            );
            router.refresh();
            advance();
          } catch (retryErr) {
            toast.error(
              retryErr instanceof Error ? retryErr.message : "Auto-tune failed.",
            );
          }
        } else {
          toast.error(message);
        }
      } finally {
        setApplying(false);
      }
    },
    [items, router, advance, edgeOverride, priceOverride],
  );

  // Edit-approve also opens the two-step confirm gate — the pending edit write
  // only fires from the gate's final "Push to production". Routes both the
  // verbatim AND the auto-tune payload through the same gate, discriminated by
  // the payload's `mode`.
  const onApplyEdit = React.useCallback(
    (payload: EditApprovePayload) => {
      if (applying) return;
      if (payload.mode === "auto-tune") {
        setPendingWrite({ kind: "edit-and-retune", index, payload });
      } else {
        setPendingWrite({ kind: "edit", index, payload });
      }
      setConfirmStep(1);
    },
    [applying, index],
  );

  // ── Start review (no 2FA prompt for this flow) ──────────────────────
  // Mints a retune token directly via `authorizePackRetuneForReview` (operator
  // + capability check, no TOTP). Per-pack token-expiry re-mints happen
  // silently inside each perform* function.
  async function startReview() {
    if (authBusy) return;
    setAuthBusy(true);
    try {
      const { token } = await authorizePackRetuneForReview();
      tokenRef.current = token;
      setStarted(true);
      toast.success("Review session ready.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to start review.");
    } finally {
      setAuthBusy(false);
    }
  }

  // ── Keyboard shortcuts (A approve · D decline · ←/→ navigate) ────────
  React.useEffect(() => {
    if (!started) return;
    function onKey(e: KeyboardEvent) {
      // Ignore when typing in an input / the confirm gate is open.
      const t = e.target as HTMLElement | null;
      if (
        confirmStep > 0 ||
        applying ||
        (t &&
          (t.tagName === "INPUT" ||
            t.tagName === "TEXTAREA" ||
            t.isContentEditable))
      ) {
        return;
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        advance();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        goTo(index - 1);
      } else if (e.key.toLowerCase() === "a") {
        e.preventDefault();
        onApprove();
      } else if (e.key.toLowerCase() === "d") {
        e.preventDefault();
        onDecline();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [started, confirmStep, applying, advance, goTo, index, onApprove, onDecline]);

  const progressPct = total > 0 ? Math.round(((approved + declined) / total) * 100) : 0;

  return (
    <div className="space-y-6">
      {/* ── Explanation layer (default-closed): flow guide + glossary ─ */}
      <div className="space-y-3">
        <RetuneGuide />
        <RetuneGlossary />
      </div>

      {/* ── System Balance ─────────────────────────────────────────── */}
      <div className="space-y-3">
        <SectionHeading
          icon={Scale}
          title="System balance"
          action={
            <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-muted-foreground">
              {reloading ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Sparkles className="size-3.5 text-primary" />
              )}
              Balance whole system
              <Switch
                checked={portfolioMode}
                onCheckedChange={(v) => void onToggleSystemBalance(v)}
                disabled={reloading || applying}
                aria-label="Balance whole system"
              />
            </label>
          }
        />
        <SystemBalancePanel
          portfolio={portfolio}
          systemPlan={portfolioMode ? systemPlan : null}
          portfolioMode={portfolioMode}
        />
      </div>

      {/* ── Review queue ───────────────────────────────────────────── */}
      <div className="space-y-3">
        <SectionHeading icon={ShieldCheck} title="Review queue" />

        {/* Progress + counts strip — sticks to the top while the (tall) card
            scrolls beneath it, so the review position + counts stay in view. */}
        <div className="sticky top-2 z-20 rounded-xl border bg-card/95 px-4 py-3 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-card/80">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3 text-sm">
              <span className="font-medium tabular-nums">
                {index + 1} / {total}
              </span>
              <span className="text-muted-foreground">·</span>
              <CountChip label="Approved" value={approved} tone="emerald" />
              <CountChip label="Declined" value={declined} tone="muted" />
              <CountChip label="Pending" value={pending} tone="blue" />
            </div>
            {!started && (
              <Button size="sm" onClick={startReview} disabled={authBusy}>
                {authBusy ? (
                  <Loader2 className="mr-1 size-3.5 animate-spin" />
                ) : (
                  <ShieldCheck className="mr-1 size-3.5" />
                )}
                Start review
              </Button>
            )}
          </div>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary motion-safe:transition-all motion-safe:duration-500 motion-safe:ease-out"
              style={{ width: `${progressPct}%` }}
            />
          </div>

          {/* ── Per-session edge-target chip strip ───────────────────────
              Owner-only nudge: the active preset overrides every Approve's
              targetEdge (plain retune + edit-and-retune) and the locally
              shaped "after" preview. Baseline = 11.02% (the live auto-target
              floor today); the higher presets are pure nudges. Persists for
              the whole session until reset — a system-balance toggle threads
              it through the reload, so the nudge survives. */}
          <EdgeTargetChipStrip
            edgeOverride={edgeOverride}
            onChange={(v) => void onSelectEdgeTarget(v)}
            disabled={applying || reloading || recomputingSingle}
            reloading={reloading || recomputingSingle}
          />
          {/* ── Per-session target-price input ───────────────────────────
              Advanced operator override: pin an ABSOLUTE USD anchor for the
              clean-snap price search. When set, every pack re-anchors on
              this price instead of its live ticket. Same UX pattern as the
              chip strip (re-runs on commit; reset = clear input + Apply).
              Persists for the whole session — a system-balance toggle
              threads it through the reload, so the anchor survives.
              SAFETY: when an anchor is active the search runs in
              `preferHigherEdge` mode so an anchor that lowers the price
              doesn't silently give up house edge. */}
          <TargetPriceInput
            priceOverride={priceOverride}
            onChange={(v) => void onSetPriceOverride(v)}
            disabled={applying || reloading || recomputingSingle}
            reloading={reloading || recomputingSingle}
          />
        </div>

        <div className="grid gap-4 lg:grid-cols-[260px_1fr] lg:items-start">
          <ReviewRail items={items} activeIndex={index} onJump={goTo} />

          {/* Generous bottom padding so the card's Approve / Decline footer
              never crowds the page edge — the card scrolls comfortably with
              clear breathing room below the action controls. */}
          <div className="relative pb-28">
            {current ? (
              <FadeIn key={current.proposal.packId}>
                <ReviewCard
                  item={current}
                  index={index}
                  total={total}
                  applying={applying}
                  recomputing={approveBlocked}
                  portfolioMode={portfolioMode}
                  editorTargets={editorTargetsFor(current, edgeOverride)}
                  editing={editingIndex === index}
                  onApprove={onApprove}
                  onDecline={onDecline}
                  onBack={() => goTo(index - 1)}
                  onAdjust={(levers) => onAdjust(index, levers)}
                  onResetAdjust={() => onResetAdjust(index)}
                  onOpenEditor={() => setEditingIndex(index)}
                  onCloseEditor={() => setEditingIndex(null)}
                  onApplyEdit={onApplyEdit}
                  onReload={onReload}
                  reloadPending={reloadPending}
                />
              </FadeIn>
            ) : null}

            {/* Pre-start overlay — the stack is inert until the token is minted. */}
            {!started && (
              <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-background/70 backdrop-blur-[1px]">
                <div className="max-w-xs rounded-xl border bg-card px-5 py-4 text-center shadow-sm">
                  <ShieldCheck className="mx-auto mb-2 size-5 text-muted-foreground" />
                  <p className="text-sm font-medium">Start review</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Mints an operator session token. Nothing is written until
                    you approve a pack.
                  </p>
                  <Button
                    size="sm"
                    className="mt-3"
                    onClick={startReview}
                    disabled={authBusy}
                  >
                    {authBusy ? (
                      <Loader2 className="mr-1 size-3.5 animate-spin" />
                    ) : (
                      <ShieldCheck className="mr-1 size-3.5" />
                    )}
                    Start review
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Two-step "push live" confirm gate ───────────────────────────
          Sits in front of BOTH prod-write Approve paths. Step 1 summarizes the
          write; Step 2 is a final hard confirm. The write only fires from Step 2
          (the 2FA token still guards the server action separately). */}
      {(() => {
        if (confirmStep === 0 || !pendingWrite) return null;
        const item = items[pendingWrite.index];
        if (!item) return null;
        const summary = buildConfirmSummary(
          item,
          pendingWrite,
          edgeOverride,
          priceOverride,
        );
        const isAutoTune = pendingWrite.kind === "edit-and-retune";
        // Truthful price-search notes — one per write path, shown exactly when
        // a search will actually run at write time:
        //  • staged auto-tune: only when the editor checkbox flowed into the
        //    payload (`buildStagedTargets` sends exactly this flag — an
        //    unticked box holds the staged price, so no note).
        //  • plain retune: ALWAYS — `buildTargets` opts every plain Approve
        //    into the clean-snap search (shared ±60% band; extended upward
        //    when the chip-strip edge target is raised).
        const willSearchPrice =
          isAutoTune &&
          pendingWrite.kind === "edit-and-retune" &&
          pendingWrite.payload.allowPriceSearch === true;
        const isPlainRetune = pendingWrite.kind === "retune";
        const title1 = isAutoTune
          ? "Auto-tune and push to production?"
          : "Push this pack live?";
        const title2 = isAutoTune
          ? "100% sure — auto-tune & push"
          : "100% sure — push to production";
        const cancel = () => {
          setConfirmStep(0);
          setPendingWrite(null);
        };
        return (
          <AlertDialog
            open
            onOpenChange={(o) => {
              if (applying) return;
              if (!o) cancel();
            }}
          >
            {confirmStep === 1 ? (
              <AlertDialogContent className="sm:max-w-xl">
                <AlertDialogHeader>
                  <AlertDialogMedia className="bg-rose-500/10 text-rose-600 dark:text-rose-400">
                    <TriangleAlert />
                  </AlertDialogMedia>
                  <AlertDialogTitle>{title1}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {isAutoTune ? (
                      <>
                        The server will pick optimized weights for the staged
                        pool of <strong>{summary.name}</strong> and write them
                        to the live game database. Review the change below, then
                        confirm once more.
                      </>
                    ) : (
                      <>
                        This writes <strong>{summary.name}</strong> to the live
                        game database. Review the change below, then confirm
                        once more.
                      </>
                    )}
                  </AlertDialogDescription>
                </AlertDialogHeader>

                {willSearchPrice && (
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                    Server may adjust price by up to ±25% around the staged
                    price to clean the odds. The expected final price is shown
                    below.
                  </div>
                )}
                {isPlainRetune && (
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                    This write re-runs the clean-snap price search (±60% band
                    around the{" "}
                    {priceOverride !== null
                      ? "pinned target price"
                      : "live price"}
                    {edgeOverride !== null
                      ? ", extended upward for the raised edge target"
                      : ""}
                    ) — the expected final price is shown below.
                  </div>
                )}

                <ConfirmGateSummary summary={summary} />

                <AlertDialogFooter>
                  <Button
                    variant="outline"
                    onClick={cancel}
                    disabled={applying}
                    className="w-full sm:w-auto"
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={() => setConfirmStep(2)}
                    disabled={applying || !summary.feasible}
                    className="w-full sm:w-auto"
                  >
                    Continue
                  </Button>
                </AlertDialogFooter>
              </AlertDialogContent>
            ) : (
              <AlertDialogContent className="sm:max-w-md">
                <AlertDialogHeader>
                  <AlertDialogMedia className="bg-rose-500/10 text-rose-600 dark:text-rose-400">
                    <TriangleAlert />
                  </AlertDialogMedia>
                  <AlertDialogTitle>{title2}</AlertDialogTitle>
                  <AlertDialogDescription>
                    Final confirmation.{" "}
                    {isAutoTune ? (
                      <>
                        The server will write the auto-tuned pool for{" "}
                        <strong>{summary.name}</strong> to the live game
                        database now.
                      </>
                    ) : (
                      <>
                        This writes <strong>{summary.name}</strong> to the live
                        game database now.
                      </>
                    )}{" "}
                    There is no undo from here.
                  </AlertDialogDescription>
                </AlertDialogHeader>

                <AlertDialogFooter>
                  <Button
                    variant="outline"
                    onClick={() => setConfirmStep(1)}
                    disabled={applying}
                    className="w-full sm:w-auto"
                  >
                    Back
                  </Button>
                  <Button
                    onClick={() => {
                      const p = pendingWrite;
                      setConfirmStep(0);
                      setPendingWrite(null);
                      if (!p) return;
                      if (p.kind === "edit-and-retune") {
                        void performEditAndRetuneApprove(p.index, p.payload);
                      } else if (p.kind === "edit") {
                        void performEditApprove(p.index, p.payload);
                      } else {
                        void performApprove(p.index);
                      }
                    }}
                    disabled={applying}
                    className="w-full bg-rose-600 text-white hover:bg-rose-600/90 sm:w-auto"
                  >
                    {isAutoTune ? "Auto-tune & push" : "Push to production"}
                  </Button>
                </AlertDialogFooter>
              </AlertDialogContent>
            )}
          </AlertDialog>
        );
      })()}
    </div>
  );
}

function CountChip({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "emerald" | "muted" | "blue";
}) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        className={cn(
          "text-sm font-semibold tabular-nums",
          tone === "emerald" && "text-emerald-600 dark:text-emerald-400",
          tone === "blue" && "text-blue-600 dark:text-blue-400",
          tone === "muted" && "text-muted-foreground",
        )}
      >
        {value}
      </span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </span>
  );
}

/**
 * Per-session edge-target preset strip. Renders one chip per preset in
 * {@link EDGE_TARGET_PRESETS}; the active chip is highlighted with the same
 * primary/border treatment used by the rest of the retune review controls.
 * Pressing the active chip again resets the override back to the per-pack
 * auto-target (so the chip strip is also its own clear button). The numeric
 * override flows up via `onChange` to `RetuneReview`, which threads it through
 * `buildTargets` + the local `shapeWeights` call so both the server write and
 * the on-screen "after" pick it up.
 */
function EdgeTargetChipStrip({
  edgeOverride,
  onChange,
  disabled,
  reloading,
}: {
  edgeOverride: number | null;
  onChange: (next: number | null) => void;
  disabled: boolean;
  reloading: boolean;
}) {
  // The "Baseline" chip equals the live auto-target floor today — pressing it
  // explicitly is the same as clearing the override (null), and that's how the
  // strip displays its baseline state.
  const activeIdx = (() => {
    if (edgeOverride === null) return 0;
    return EDGE_TARGET_PRESETS.findIndex(
      (p) => Math.abs(p.value - edgeOverride) < 1e-9,
    );
  })();
  const activeLabel =
    edgeOverride === null
      ? `${(EDGE_TARGET_BASELINE * 100).toFixed(2)}% (baseline)`
      : `${(edgeOverride * 100).toFixed(2)}%`;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
      <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {reloading ? (
          <Loader2 className="size-3.5 animate-spin text-primary" />
        ) : (
          <Sparkles className="size-3.5 text-primary" />
        )}
        Target edge:{" "}
        <span className="font-semibold tabular-nums text-foreground">
          {activeLabel}
        </span>
      </span>
      <div className="flex flex-wrap items-center gap-1.5">
        {EDGE_TARGET_PRESETS.map((preset, i) => {
          const isActive = i === activeIdx;
          return (
            <button
              key={preset.value}
              type="button"
              disabled={disabled}
              aria-pressed={isActive}
              onClick={() => {
                // Baseline preset clears the override (null) so the per-pack
                // auto-target carries over to packs that have a non-floor
                // target (the portfolio-balanced ones); a higher preset writes
                // its exact fraction as the per-session override.
                if (i === 0) {
                  onChange(null);
                } else {
                  onChange(preset.value);
                }
              }}
              className={cn(
                "rounded-full border px-2.5 py-1 text-xs font-medium tabular-nums transition-colors",
                "disabled:cursor-not-allowed disabled:opacity-50",
                isActive
                  ? "border-primary bg-primary/15 text-primary"
                  : "border-border bg-card text-muted-foreground hover:border-primary/40 hover:bg-muted/50 hover:text-foreground",
              )}
              title={
                i === 0
                  ? `Baseline (${preset.pct.toFixed(2)}%) — uses each pack's per-pack auto-target.`
                  : `Nudge target edge to ${preset.pct.toFixed(2)}% (${preset.label}).`
              }
            >
              {preset.pct.toFixed(2)}%
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Per-session target-price input. Advanced operator override: pin an absolute
 * USD anchor for the clean-snap price search. Compact input + Apply button:
 * the operator types a number, hits Apply (or Enter), and the search re-anchors
 * every proposal on that price. Empty + Apply clears the override (the search
 * goes back to centering on each pack's live price). The active anchor is
 * shown next to the input as `Active: $X.XX` so it's visible at a glance.
 *
 * UX: small, less prominent than the chip strip — this is an advanced lever.
 * Same disabled-while-reloading / spinner semantics as the chip strip. Pressing
 * Enter in the input commits, matching the operator-friendly muscle memory.
 */
function TargetPriceInput({
  priceOverride,
  onChange,
  disabled,
  reloading,
}: {
  priceOverride: number | null;
  onChange: (next: number | null) => void;
  disabled: boolean;
  reloading: boolean;
}) {
  // Controlled local string state so the input doesn't fight the operator's
  // typing (number input + the parent's null state would flip a typed "1.2"
  // back to "" on every render). Committed via Apply / Enter only.
  const [raw, setRaw] = React.useState<string>(
    priceOverride !== null ? priceOverride.toFixed(2) : "",
  );
  // Re-seed when the parent clears the override (e.g. the Reset button).
  // Avoid clobbering operator-in-progress typing by only re-syncing
  // when the parent's value differs from the parsed input value.
  React.useEffect(() => {
    const current = parseFloat(raw);
    const same =
      priceOverride !== null && Number.isFinite(current) && current === priceOverride;
    if (!same && priceOverride === null) setRaw("");
    if (!same && priceOverride !== null) setRaw(priceOverride.toFixed(2));
    // raw intentionally omitted — we only want to react to parent changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [priceOverride]);

  const trimmed = raw.trim();
  const parsed = trimmed === "" ? null : parseFloat(trimmed);
  const valid =
    trimmed === "" || (parsed !== null && Number.isFinite(parsed) && parsed > 0);

  const commit = () => {
    if (!valid) return;
    onChange(parsed); // null when blank → clears the override
  };

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
      <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {reloading ? (
          <Loader2 className="size-3.5 animate-spin text-primary" />
        ) : (
          <DollarSign className="size-3.5 text-primary" />
        )}
        Target price:
        <span className="font-semibold tabular-nums text-foreground">
          {priceOverride !== null ? `$${priceOverride.toFixed(2)}` : "auto"}
        </span>
      </span>
      <div className="flex items-center gap-1.5">
        <Input
          type="number"
          step="0.01"
          min="0"
          inputMode="decimal"
          placeholder="e.g. 1.27"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
          }}
          disabled={disabled}
          aria-invalid={!valid}
          aria-label="Target ticket price"
          className="h-7 w-24 text-xs"
        />
        <button
          type="button"
          onClick={commit}
          disabled={disabled || !valid}
          className={cn(
            "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
            "disabled:cursor-not-allowed disabled:opacity-50",
            "border-primary bg-primary/15 text-primary hover:bg-primary/25",
          )}
          title={
            trimmed === ""
              ? "Apply to clear the target price (back to each pack's live price)."
              : `Apply a $${parsed?.toFixed(2) ?? "?"} target — every pack re-anchors.`
          }
        >
          Apply
        </button>
        {priceOverride !== null && (
          <button
            type="button"
            onClick={() => {
              setRaw("");
              onChange(null);
            }}
            disabled={disabled}
            className="flex items-center gap-1 rounded-full border border-border bg-card px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-50"
            title="Clear the target-price override (back to each pack's live price)."
          >
            <RotateCcw className="size-3" />
            Reset
          </button>
        )}
      </div>
      <span className="text-[10px] text-muted-foreground">
        Solver anchors every pack on this price (still searches the shared
        ±60% retune band for a clean snap; higher price = higher edge).
      </span>
    </div>
  );
}

// ─── Confirm-gate Step 1 summary ─────────────────────────────────────
// Builds a unified before/after snapshot for ALL three write paths (plain
// retune · verbatim edit · edit-and-retune) so Step 1 renders a single,
// consistent KPI grid + per-card diff dropdown. The diff table mirrors the
// review card's `AllCardChanges` House-POV colouring rule (win card gaining
// share = rose = player-favorable; non-win card gaining share = emerald =
// house-favorable; added cards = rose with "+"; removed cards = emerald with
// "−" — both deltas to the player are surfaced from the house's side).

type ConfirmWriteInput =
  | { kind: "retune"; index: number }
  | {
      kind: "edit";
      index: number;
      payload: Extract<EditApprovePayload, { mode: "verbatim" }>;
    }
  | {
      kind: "edit-and-retune";
      index: number;
      payload: Extract<EditApprovePayload, { mode: "auto-tune" }>;
    };

/** A single row in the per-card diff dropdown. */
type ConfirmDiffRow = {
  cardId: string;
  /** Card display name when known (edit modes); falls back to a value tag. */
  name: string | null;
  value: number;
  /** Probability share BEFORE the write (0..1). Null for an added card. */
  fromP: number | null;
  /** Probability share AFTER the write (0..1). Null for a removed card. */
  toP: number | null;
  /** Signed delta in % points. NaN-safe; +0 for unchanged. */
  delta: number;
  state: "kept" | "added" | "removed";
  isWinCard: boolean;
};

type ConfirmSummary = {
  name: string;
  mode: "retune" | "edit" | "edit-and-retune";
  modeLabel: string;
  /** Lottery tag info — null for an untagged pack. */
  tag: { tagPct: string; capActual: number; capBaseline: number } | null;
  priceBefore: number;
  priceAfter: number;
  priceChanged: boolean;
  edgeBefore: number;
  edgeAfter: number | null;
  /** True when auto-tune (or verbatim) is the write that's about to fire. */
  isAutoTune: boolean;
  winRateBefore: number;
  winRateAfter: number | null;
  maxWinBefore: number;
  maxWinAfter: number | null;
  cardCountBefore: number;
  cardCountAfter: number;
  feasible: boolean;
  /** Per-card diff sorted by |Δ| desc; removed/added bubble up by magnitude. */
  diff: ConfirmDiffRow[];
  diffChangedCount: number;
};

function buildConfirmSummary(
  item: ReviewItem,
  write: ConfirmWriteInput,
  edgeOverride: number | null,
  priceOverride: number | null,
): ConfirmSummary {
  const { proposal } = item;
  const tag = (() => {
    const ihr = proposal.intendedHitRate;
    if (ihr == null || ihr > 0.1) return null;
    const tagPct = (ihr * 100).toFixed(ihr < 0.01 ? 2 : 0);
    const capBaseline = proposal.price * DEFAULT_MAX_MULT_CEILING;
    const capActual = proposal.autoTargets.maxWinCap;
    return { tagPct, capActual, capBaseline };
  })();
  // Common before — every mode starts from the live pack's PackRisk + pool.
  const before = proposal.before;
  const cardCountBefore = proposal.cards.length;

  if (write.kind === "retune") {
    // Re-derive the "after" locally so the gate matches what the server will
    // (re-)shape against — the proposal was shaped at the per-pack auto-target,
    // but a per-session edge override (or a local Adjust) supersedes that.
    // Precedence: a local `Adjust` already shaped against the override (woven
    // in via `onAdjust`); else, when an override is set, reshape here;
    // otherwise fall back to the proposal's original after.
    //
    // Both server-side shape paths (`planAllRetunes`, `applyPackRetune`) now
    // route through `searchBestPriceForCleanSnap` — so this LOCAL preview MUST
    // mirror the same lever or the gate would show the wrong odds/price.
    let after: PackRisk | null;
    let weightDiff: PlanAllWeightDiff[] | null;
    let feasible: boolean;
    let priceAfter: number = proposal.priceAfter ?? proposal.price;
    const priceAnchor =
      priceOverride !== null &&
      Number.isFinite(priceOverride) &&
      priceOverride > 0
        ? priceOverride
        : null;
    if (item.adjusted) {
      after = item.adjusted.after;
      weightDiff = item.adjusted.weightDiff;
      feasible = item.adjusted.feasible;
      // The adjusted search's own landing price IS the write artifact (it is
      // pinned as `approvedPriceAfter` on Approve) — show it, not the stale
      // pre-adjust proposal price.
      priceAfter = item.adjusted.priceAfter ?? priceAfter;
    } else if (edgeOverride !== null || priceAnchor !== null) {
      const auto = proposal.autoTargets;
      // Tagged strict win-rate gate — same condition the server applies on
      // approve (the resolved target IS the name tag).
      const taggedWinRate =
        proposal.intendedHitRate !== null &&
        Math.abs(proposal.intendedHitRate - auto.targetWinRate) < 1e-9
          ? proposal.intendedHitRate
          : undefined;
      const search = searchBestPriceForCleanSnap({
        cards: proposal.cards.map((c) => ({ value: c.value })),
        // Same anchor as `onAdjust` + the server: pinned override OR pack price.
        basePrice: priceAnchor ?? proposal.price,
        // Same edge resolution as `buildTargets` sends the server (max of the
        // pack's auto-target and the nudge — never below the pack's curve).
        targetEdge: effectiveTargetEdge(item, edgeOverride),
        targetWinRate: auto.targetWinRate,
        maxWinCap: auto.maxWinCap,
        nearMissMin: auto.nearMissMin,
        // Anti-inflation anchor — matches the planner + `applyPackRetune`.
        currentWeights: proposal.cards.map((c) => c.weight),
        // The SHARED ±60% retune band (planner + write + mirrors must agree
        // or the gate would show a different price/odds than the write lands).
        maxPriceChangePct: RETUNE_MAX_PRICE_CHANGE_PCT,
        upwardPriceExtensionPct: edgeOverride !== null ? 2.0 : 0,
        preferHigherEdge: true,
        ...(taggedWinRate !== undefined ? { taggedWinRate } : {}),
      });
      const reshaped = search.bestResult;
      priceAfter = search.bestPrice;
      if ("error" in reshaped) {
        after = null;
        weightDiff = null;
        feasible = false;
      } else {
        after = reshaped.risk;
        weightDiff = proposal.cards
          .map((c, i) => ({
            cardId: c.cardId,
            from: c.weight,
            to: reshaped.weights[i]!,
          }))
          .filter((d) => d.from !== d.to);
        feasible = true;
      }
    } else {
      after = proposal.after;
      weightDiff = proposal.weightDiff;
      feasible = proposal.feasible;
      priceAfter = proposal.priceAfter ?? proposal.price;
    }
    const diff = buildRetuneDiffRows(proposal, weightDiff);
    const priceChanged = Math.abs(priceAfter - proposal.price) > 1e-9;
    return {
      name: proposal.name,
      mode: "retune",
      modeLabel: "Auto re-tune (per-pack targets)",
      tag,
      priceBefore: proposal.price,
      priceAfter,
      priceChanged,
      edgeBefore: before.edge,
      edgeAfter: after?.edge ?? null,
      isAutoTune: false,
      winRateBefore: before.winRate,
      winRateAfter: after?.winRate ?? null,
      maxWinBefore: before.maxWin,
      maxWinAfter: after?.maxWin ?? null,
      cardCountBefore,
      cardCountAfter: cardCountBefore,
      feasible,
      diff,
      diffChangedCount: diff.filter((r) => r.state !== "kept" || r.delta !== 0)
        .length,
    };
  }

  // Edit modes — staged pool. Use the editor-supplied preview.
  const preview = write.payload.preview;
  const newPrice = preview.newPrice;
  const priceAfter = newPrice ?? proposal.price;
  const after = preview.after;
  const isAutoTune = write.kind === "edit-and-retune";
  const diff = buildEditDiffRows(preview, priceAfter);
  // Feasibility for an edit: the editor refuses to send a non-win pool, so
  // `after` is null only on a (rare) infeasible local shape — surface as rose.
  const feasible = after != null;
  return {
    name: proposal.name,
    mode: isAutoTune ? "edit-and-retune" : "edit",
    modeLabel: isAutoTune
      ? "Edited pool + server auto-tune"
      : "Verbatim pool edit (no auto-shaping)",
    tag,
    priceBefore: proposal.price,
    priceAfter,
    priceChanged: newPrice != null,
    edgeBefore: before.edge,
    edgeAfter: after?.edge ?? null,
    isAutoTune,
    winRateBefore: before.winRate,
    winRateAfter: after?.winRate ?? null,
    maxWinBefore: before.maxWin,
    maxWinAfter: after?.maxWin ?? null,
    cardCountBefore,
    cardCountAfter: preview.cards.length,
    feasible,
    diff,
    diffChangedCount: diff.filter((r) => r.state !== "kept" || r.delta !== 0)
      .length,
  };
}

/** Build the per-card diff for a plain retune. Pool identity unchanged. */
function buildRetuneDiffRows(
  proposal: ReviewItem["proposal"],
  weightDiff: { cardId: string; from: number; to: number }[] | null,
): ConfirmDiffRow[] {
  const toByCard = new Map<string, number>();
  if (weightDiff) {
    for (const d of weightDiff) toByCard.set(d.cardId, d.to);
  }
  const fromTotal =
    proposal.cards.reduce((s, c) => s + (c.weight > 0 ? c.weight : 0), 0) || 1;
  const afterWeights = proposal.cards.map((c) =>
    toByCard.has(c.cardId) ? toByCard.get(c.cardId)! : c.weight,
  );
  const toTotal = afterWeights.reduce((s, w) => s + (w > 0 ? w : 0), 0) || 1;
  const rows: ConfirmDiffRow[] = proposal.cards.map((c, i) => {
    const fromP = c.weight / fromTotal;
    const toP = afterWeights[i]! / toTotal;
    return {
      cardId: c.cardId,
      // The plain-retune proposal carries no card name (privacy of the
      // `cards.name` PII isn't relevant here, the type just doesn't include
      // it). Show the value as the label.
      name: null,
      value: c.value,
      fromP,
      toP,
      delta: (toP - fromP) * 100,
      state: "kept",
      isWinCard: c.value >= proposal.price,
    };
  });
  return sortDiffRows(rows);
}

/** Build the per-card diff for an edit (verbatim or auto-tune). */
function buildEditDiffRows(
  preview: EditPreview,
  priceAfter: number,
): ConfirmDiffRow[] {
  const fromTotal =
    preview.cards.reduce(
      (s, c) => s + (c.fromWeight != null && c.fromWeight > 0 ? c.fromWeight : 0),
      0,
    ) +
      preview.removed.reduce(
        (s, c) => s + (c.fromWeight > 0 ? c.fromWeight : 0),
        0,
      ) || 1;
  const toTotal =
    preview.cards.reduce((s, c) => s + (c.toWeight > 0 ? c.toWeight : 0), 0) ||
    1;
  const kept: ConfirmDiffRow[] = preview.cards.map((c) => {
    const fromP = c.fromWeight != null ? c.fromWeight / fromTotal : null;
    const toP = c.toWeight / toTotal;
    const fromPct = fromP ?? 0;
    return {
      cardId: c.cardId,
      name: c.name,
      value: c.value,
      fromP,
      toP,
      delta: (toP - fromPct) * 100,
      state: c.added ? "added" : "kept",
      isWinCard: c.value >= priceAfter,
    };
  });
  const removed: ConfirmDiffRow[] = preview.removed.map((c) => {
    const fromP = c.fromWeight / fromTotal;
    return {
      cardId: c.cardId,
      name: c.name,
      value: c.value,
      fromP,
      toP: null,
      delta: (0 - fromP) * 100,
      state: "removed",
      isWinCard: c.value >= priceAfter,
    };
  });
  return sortDiffRows([...kept, ...removed]);
}

/** Sort biggest movers first; added/removed bubble up by magnitude. */
function sortDiffRows(rows: ConfirmDiffRow[]): ConfirmDiffRow[] {
  return [...rows].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

/** Render the KPI grid + lottery chip + expandable per-card diff. */
function ConfirmGateSummary({ summary }: { summary: ConfirmSummary }) {
  const [diffOpen, setDiffOpen] = React.useState(false);
  return (
    <div className="space-y-3">
      {/* Header strip — pack name + mode badge + tag chip */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">{summary.name}</span>
        <span className="rounded-full border bg-muted/30 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {summary.modeLabel}
        </span>
        {summary.tag && (
          <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
            {summary.tag.tagPct}% lottery
          </span>
        )}
      </div>

      {/* Price-changed callout — only when auto-tune adjusted the price */}
      {summary.priceChanged && summary.isAutoTune && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          <Sparkles className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Price adjusted from{" "}
            <span className="font-medium tabular-nums">
              {formatCurrency(summary.priceBefore)}
            </span>{" "}
            to{" "}
            <span className="font-medium tabular-nums">
              {formatCurrency(summary.priceAfter)}
            </span>{" "}
            for cleaner odds + monotonic shape.
          </span>
        </div>
      )}
      {summary.priceChanged && !summary.isAutoTune && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Pack price will change from{" "}
            <span className="font-medium tabular-nums">
              {formatCurrency(summary.priceBefore)}
            </span>{" "}
            to{" "}
            <span className="font-medium tabular-nums">
              {formatCurrency(summary.priceAfter)}
            </span>{" "}
            — players will see the new price after push.
          </span>
        </div>
      )}

      {/* Lottery acknowledgment — only for ≤10% tagged packs */}
      {summary.tag && (
        <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400">
          <Sparkles className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Lottery pack — jackpot preserved. Cap{" "}
            <span className="font-medium tabular-nums">
              {formatCurrency(summary.tag.capActual)}
            </span>
            {summary.tag.capActual > summary.tag.capBaseline + 1e-6 ? (
              <>
                {" "}
                (loosened from baseline{" "}
                <span className="font-medium tabular-nums">
                  {formatCurrency(summary.tag.capBaseline)}
                </span>
                ).
              </>
            ) : (
              <> (baseline cap is already permissive enough).</>
            )}
          </span>
        </div>
      )}

      {/* KPI grid — 2 columns on sm+, stacks on narrow phones */}
      <div className="grid gap-2 rounded-lg border bg-muted/10 p-3 text-sm sm:grid-cols-2">
        <KpiRow
          label="Price"
          before={formatCurrency(summary.priceBefore)}
          after={formatCurrency(summary.priceAfter)}
          changed={summary.priceChanged}
        />
        <KpiRow
          label="House edge"
          before={pct(summary.edgeBefore)}
          after={pct(summary.edgeAfter)}
          changed={summary.edgeAfter != null && summary.edgeAfter !== summary.edgeBefore}
          // Edge: rising = good for the house (emerald), falling = giving away
          // margin (rose). House-POV.
          tone={edgeTone(summary.edgeBefore, summary.edgeAfter)}
        />
        <KpiRow
          label="Win rate"
          before={pct(summary.winRateBefore)}
          after={pct(summary.winRateAfter)}
          changed={
            summary.winRateAfter != null &&
            summary.winRateAfter !== summary.winRateBefore
          }
          // Win-rate: rising = more frequent player wins = bad for house (rose).
          tone={winRateTone(summary.winRateBefore, summary.winRateAfter)}
        />
        <KpiRow
          label="Max win"
          before={formatCurrency(summary.maxWinBefore)}
          after={
            summary.maxWinAfter != null
              ? formatCurrency(summary.maxWinAfter)
              : "—"
          }
          changed={
            summary.maxWinAfter != null &&
            summary.maxWinAfter !== summary.maxWinBefore
          }
          // Max win: rising = bigger jackpot exposure = bad for house (rose).
          tone={maxWinTone(summary.maxWinBefore, summary.maxWinAfter)}
        />
        <KpiRow
          label="Card count"
          before={String(summary.cardCountBefore)}
          after={String(summary.cardCountAfter)}
          changed={summary.cardCountAfter !== summary.cardCountBefore}
        />
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">Feasible</span>
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-xs font-medium",
              summary.feasible
                ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                : "bg-rose-500/15 text-rose-700 dark:text-rose-400",
            )}
          >
            {summary.feasible ? "Yes" : "No"}
          </span>
        </div>
      </div>

      {/* Expandable card-level diff dropdown — default closed */}
      <Collapsible open={diffOpen} onOpenChange={setDiffOpen}>
        <CollapsibleTrigger
          render={
            <button
              type="button"
              className="flex w-full items-center justify-between gap-2 rounded-lg border bg-muted/10 px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted/20"
            >
              <span>
                Show card-level changes
                {summary.diffChangedCount > 0 && (
                  <span className="ml-1.5 text-muted-foreground tabular-nums">
                    ({summary.diffChangedCount} card
                    {summary.diffChangedCount === 1 ? "" : "s"} moved)
                  </span>
                )}
              </span>
              <ChevronDown
                className={cn(
                  "size-3.5 text-muted-foreground transition-transform",
                  diffOpen && "rotate-180",
                )}
              />
            </button>
          }
        />
        <CollapsibleContent>
          <div className="mt-2 overflow-hidden rounded-lg border">
            <div className="flex items-center justify-between gap-2 border-b bg-muted/20 px-3 py-1.5">
              <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                {summary.diff.length} card
                {summary.diff.length === 1 ? "" : "s"}
              </span>
              <span className="hidden text-[10px] text-muted-foreground sm:inline">
                card · before → after · Δ
              </span>
            </div>
            <div className="max-h-72 overflow-y-auto">
              <table className="w-full text-xs">
                <tbody>
                  {summary.diff.map((r) => (
                    <ConfirmDiffRowItem key={r.cardId} row={r} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

/** Compute the House-POV tone for a KPI delta. */
function edgeTone(
  before: number,
  after: number | null,
): "emerald" | "rose" | "neutral" {
  if (after == null || after === before) return "neutral";
  // Edge up = house keeps more = good for house = emerald.
  return after > before ? "emerald" : "rose";
}
function winRateTone(
  before: number,
  after: number | null,
): "emerald" | "rose" | "neutral" {
  if (after == null || after === before) return "neutral";
  // Win-rate up = players win more often = bad for house = rose.
  return after > before ? "rose" : "emerald";
}
function maxWinTone(
  before: number,
  after: number | null,
): "emerald" | "rose" | "neutral" {
  if (after == null || after === before) return "neutral";
  // Max-win up = bigger jackpot exposure = bad for house = rose.
  return after > before ? "rose" : "emerald";
}

/** A single before → after KPI row with House-POV tone on the "after" cell. */
function KpiRow({
  label,
  before,
  after,
  changed,
  tone = "neutral",
}: {
  label: string;
  before: string;
  after: string;
  changed: boolean;
  tone?: "emerald" | "rose" | "neutral";
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex items-center gap-1.5 tabular-nums">
        <span className="text-muted-foreground">{before}</span>
        <ArrowRight className="size-3 text-muted-foreground" />
        <span
          className={cn(
            "font-medium",
            !changed && "text-muted-foreground",
            changed && tone === "emerald" && "text-emerald-700 dark:text-emerald-400",
            changed && tone === "rose" && "text-rose-700 dark:text-rose-400",
            changed && tone === "neutral" && "text-foreground",
          )}
        >
          {after}
        </span>
      </span>
    </div>
  );
}

/** One row of the per-card diff dropdown. */
function ConfirmDiffRowItem({ row }: { row: ConfirmDiffRow }) {
  // House-POV: a win card gaining share, or a non-win card losing share,
  // raises player EV = BAD for the house → rose. The inverse → emerald. An
  // ADDED card is treated as gaining all its share (player change), a REMOVED
  // card as losing all of it.
  const up = row.delta > 0;
  const playerFavorable =
    row.state === "added"
      ? row.isWinCard
      : row.state === "removed"
        ? !row.isWinCard
        : row.isWinCard === up;
  const tone =
    row.delta === 0 && row.state === "kept"
      ? "text-muted-foreground"
      : playerFavorable
        ? "text-rose-600 dark:text-rose-400"
        : "text-emerald-600 dark:text-emerald-400";
  const bgTone =
    row.state === "added"
      ? "bg-rose-500/5"
      : row.state === "removed"
        ? "bg-emerald-500/5"
        : "";
  return (
    <tr className={cn("border-b last:border-b-0", bgTone)}>
      <td className="whitespace-nowrap px-3 py-1.5">
        <span className="flex items-center gap-1.5 tabular-nums">
          {row.state === "added" && (
            <span
              className="inline-flex size-4 items-center justify-center rounded-full bg-rose-500/15 text-[10px] font-bold text-rose-600 dark:text-rose-400"
              title="Card added — gives the player a new winning row"
            >
              +
            </span>
          )}
          {row.state === "removed" && (
            <span
              className="inline-flex size-4 items-center justify-center rounded-full bg-emerald-500/15 text-[10px] font-bold text-emerald-600 dark:text-emerald-400"
              title="Card removed — drops a player payout slot"
            >
              −
            </span>
          )}
          <span className="font-medium">{formatCurrency(row.value)}</span>
          {row.name && (
            <span className="truncate text-muted-foreground" title={row.name}>
              {row.name}
            </span>
          )}
          {row.isWinCard && (
            <span
              className="inline-block size-1.5 rounded-full bg-amber-500"
              title="Profit card (value ≥ price)"
            />
          )}
        </span>
      </td>
      <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
        {row.fromP != null ? formatPercent(row.fromP * 100) : "—"}
      </td>
      <td className="px-1 py-1.5 text-center">
        <ArrowRight className="inline size-3 text-muted-foreground" />
      </td>
      <td className="px-3 py-1.5 text-right">
        <span className={cn("font-medium tabular-nums", tone)}>
          {row.toP != null ? formatPercent(row.toP * 100) : "—"}
        </span>
      </td>
      <td className="w-16 px-3 py-1.5 text-right">
        {row.delta === 0 ? (
          <span className="text-muted-foreground">·</span>
        ) : (
          <span className={cn("tabular-nums", tone)}>
            {row.delta > 0 ? "+" : "−"}
            {formatDeltaPp(Math.abs(row.delta))}
          </span>
        )}
      </td>
    </tr>
  );
}
