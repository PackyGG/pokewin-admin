"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  ChevronDown,
  Loader2,
  Scale,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
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
  shapeWeights,
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
 * SYSTEM BALANCE — a header panel (fed by `getPortfolioProfile`) profiles the
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

/** Build the `PackRetuneTargets` payload sent to `applyPackRetune` for an item. */
function buildTargets(item: ReviewItem): PackRetuneTargets {
  const { autoTargets } = item.proposal;
  const a = item.adjusted;
  return {
    targetEdge: autoTargets.targetEdge,
    targetWinRate: a ? a.targetWinRate : autoTargets.targetWinRate,
    maxWinCap: a ? a.maxWinCap : autoTargets.maxWinCap,
    nearMissMin: a ? a.nearMissMin : autoTargets.nearMissMin,
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
function editorTargetsFor(item: ReviewItem): EditorTargets {
  const { autoTargets } = item.proposal;
  const a = item.adjusted;
  return {
    targetEdge: autoTargets.targetEdge,
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

  // The session retune token (kept in a ref so the approve loop reads the
  // latest after a re-mint without a stale closure). The token is minted by
  // the "Start review" button (no 2FA prompt for this flow) and silently
  // re-minted on expiry.
  const tokenRef = React.useRef<string | null>(null);
  // True while the "Start review" mint or a silent token re-mint is in flight.
  const [authBusy, setAuthBusy] = React.useState(false);

  const total = items.length;
  const approved = items.filter((i) => i.status === "approved").length;
  const declined = items.filter((i) => i.status === "declined").length;
  const pending = total - approved - declined;
  const current = items[index];

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
  // Re-load every proposal in the requested mode. Approved/declined verdicts and
  // any local adjustments are reset (the underlying auto-targets change), so we
  // confirm-via-toast and rebuild the queue from the fresh proposals. READ-ONLY:
  // `planAllRetunes` writes nothing — it's a dry-run, like the initial load.
  const onToggleSystemBalance = React.useCallback(
    async (next: boolean) => {
      if (reloading) return;
      setReloading(true);
      try {
        const res = await planAllRetunes(next ? "portfolio" : "per-pack");
        setItems(
          res.proposals.map((p) => ({
            proposal: p,
            status: "pending" as ReviewStatus,
            adjusted: null,
          })),
        );
        setSystemPlan(res.systemPlan);
        setPortfolioMode(next);
        setIndex(0);
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
    [reloading],
  );

  // ── Local re-shape (Adjust) ─────────────────────────────────────────
  const onAdjust = React.useCallback(
    (i: number, levers: AdjustedTargets) => {
      setItems((prev) => {
        const next = [...prev];
        const item = next[i];
        if (!item) return prev;
        const { proposal } = item;
        const shaped = shapeWeights({
          cards: proposal.cards.map((c) => ({ value: c.value })),
          price: proposal.price,
          targetEdge: proposal.autoTargets.targetEdge,
          targetWinRate: levers.targetWinRate,
          maxWinCap: levers.maxWinCap,
          nearMissMin: levers.nearMissMin,
        });
        let adjusted: AdjustedState;
        if ("error" in shaped) {
          adjusted = {
            ...levers,
            feasible: false,
            after: null,
            weightDiff: null,
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
          // Score from the freshly shaped weights so `after` is internally
          // consistent with `weightDiff` (same engine the server uses).
          const after = computePackRisk({
            cards: proposal.cards.map((c, idx) => ({
              value: c.value,
              weight: shaped.weights[idx]!,
            })),
            price: proposal.price,
          });
          adjusted = {
            ...levers,
            feasible: true,
            after,
            weightDiff,
            relaxations: shaped.relaxations,
            error: undefined,
            limit: null,
          };
        }
        next[i] = { ...item, adjusted };
        return next;
      });
    },
    [],
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
        const res = await applyPackRetune(item.proposal.packId, token, buildTargets(item));
        setItems((prev) => {
          const next = [...prev];
          if (next[i]) next[i] = { ...next[i]!, status: "approved" };
          return next;
        });
        toast.success(
          `Re-tuned ${res.name}: edge ${(res.after.edge * 100).toFixed(2)}% · win ${(res.after.winRate * 100).toFixed(2)}%.`,
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
              buildTargets(item),
            );
            setItems((prev) => {
              const next = [...prev];
              if (next[i]) next[i] = { ...next[i]!, status: "approved" };
              return next;
            });
            toast.success(
              `Re-tuned ${retry.name}: edge ${(retry.after.edge * 100).toFixed(2)}% · win ${(retry.after.winRate * 100).toFixed(2)}%.`,
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
    [items, router, advance],
  );

  // Approve opens the two-step confirm gate instead of writing directly — the
  // pending retune write only fires from the gate's final "Push to production".
  const onApprove = React.useCallback(() => {
    if (applying) return;
    setPendingWrite({ kind: "retune", index });
    setConfirmStep(1);
  }, [applying, index]);

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
        // card explains. `allowPriceSearch` is the owner's explicit opt-in for
        // the ±25% price-search lever; it flows from the editor checkbox
        // through the gate and lands on the server action's `targets` param.
        const t = buildTargets(item);
        const res = await applyStagedPackEditAndRetune(
          item.proposal.packId,
          token,
          {
            cards: payload.cards,
            ...(payload.price !== undefined ? { price: payload.price } : {}),
          },
          {
            ...t,
            ...(payload.allowPriceSearch === true
              ? { allowPriceSearch: true }
              : {}),
          },
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
            const t = buildTargets(item);
            const retry = await applyStagedPackEditAndRetune(
              item.proposal.packId,
              fresh,
              {
                cards: payload.cards,
                ...(payload.price !== undefined ? { price: payload.price } : {}),
              },
              {
                ...t,
                ...(payload.allowPriceSearch === true
                  ? { allowPriceSearch: true }
                  : {}),
              },
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
    [items, router, advance],
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
                  portfolioMode={portfolioMode}
                  editorTargets={editorTargetsFor(current)}
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
        const summary = buildConfirmSummary(item, pendingWrite);
        const isAutoTune = pendingWrite.kind === "edit-and-retune";
        // The owner only sees the "price may shift" note when the editor
        // checkbox flowed through into the pending payload — pure UI surface
        // of the same `allowPriceSearch` flag the server reads.
        const willSearchPrice =
          isAutoTune &&
          pendingWrite.kind === "edit-and-retune" &&
          pendingWrite.payload.allowPriceSearch === true;
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
                    Server may adjust price by up to ±25% to clean the odds.
                    Final price will be shown below after auto-tune.
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
    // Adjusted-or-proposed after; same pool identity, just re-weighted.
    const after = item.adjusted?.after ?? proposal.after;
    const weightDiff = item.adjusted?.weightDiff ?? proposal.weightDiff;
    const feasible = item.adjusted?.feasible ?? proposal.feasible;
    const diff = buildRetuneDiffRows(proposal, weightDiff);
    return {
      name: proposal.name,
      mode: "retune",
      modeLabel: "Auto re-tune (per-pack targets)",
      tag,
      priceBefore: proposal.price,
      priceAfter: proposal.price,
      priceChanged: false,
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
        {row.fromP != null ? `${(row.fromP * 100).toFixed(2)}%` : "—"}
      </td>
      <td className="px-1 py-1.5 text-center">
        <ArrowRight className="inline size-3 text-muted-foreground" />
      </td>
      <td className="px-3 py-1.5 text-right">
        <span className={cn("font-medium tabular-nums", tone)}>
          {row.toP != null ? `${(row.toP * 100).toFixed(2)}%` : "—"}
        </span>
      </td>
      <td className="w-16 px-3 py-1.5 text-right">
        {row.delta === 0 ? (
          <span className="text-muted-foreground">·</span>
        ) : (
          <span className={cn("tabular-nums", tone)}>
            {row.delta > 0 ? "+" : "−"}
            {Math.abs(row.delta).toFixed(2)}
          </span>
        )}
      </td>
    </tr>
  );
}
