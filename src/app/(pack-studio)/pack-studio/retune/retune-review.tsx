"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { KeyRound, Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  computePackRisk,
  shapeWeights,
  type PackRisk,
} from "@/app/(admin)/insights/edge-calc/risk";
import {
  authorizePackRetune,
  applyPackRetune,
  type PackRetuneTargets,
} from "@/app/(admin)/packs/actions";
import type {
  PlanAllProposal,
  PlanAllWeightDiff,
} from "../doctor/retune-actions";

import { ReviewCard } from "./review-card";
import { ReviewRail } from "./review-rail";

/**
 * Bulk Re-tune Review orchestrator (owner-only, client). Drives the Tinder-style
 * card stack over `planAllRetunes()` proposals:
 *
 *   1. "Start review" gate — mints ONE retune token via `authorizePackRetune`
 *      (2FA). The token authorizes every approve-write for the session.
 *   2. Card stack — one pack at a time. APPROVE → `applyPackRetune(packId, token,
 *      targets)` (the server re-shapes fresh + writes); DECLINE/SKIP → advance,
 *      no write; ADJUST → re-shape LOCALLY via the pure `shapeWeights` and send
 *      the adjusted levers on approve; BACK → revisit the previous pack.
 *   3. Token expiry — if a write returns the "authorization expired" error, the
 *      2FA dialog re-opens; on re-confirm the SAME approve is retried.
 *
 * Nothing is persisted until APPROVE. Only approved packs ever write. The pure
 * client-safe `shapeWeights`/`computePackRisk` mirror the server's math, so the
 * adjusted after-preview matches what `applyPackRetune` will (re-)compute and
 * fail-close on.
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
  error?: string;
};

export type ReviewStatus = "pending" | "approved" | "declined";

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

export function RetuneReview({
  proposals,
  targetEdge,
}: {
  proposals: PlanAllProposal[];
  targetEdge: number;
}) {
  const router = useRouter();

  const [items, setItems] = React.useState<ReviewItem[]>(() =>
    proposals.map((p) => ({ proposal: p, status: "pending", adjusted: null })),
  );
  const [index, setIndex] = React.useState(0);
  const [started, setStarted] = React.useState(false);
  const [applying, setApplying] = React.useState(false);

  // The session retune token (kept in a ref so the approve loop reads the
  // latest after a re-mint without a stale closure).
  const tokenRef = React.useRef<string | null>(null);

  // 2FA dialog (used both for the initial Start gate and a token-expiry retry).
  const [authOpen, setAuthOpen] = React.useState(false);
  const [authBusy, setAuthBusy] = React.useState(false);
  const [totp, setTotp] = React.useState("");
  // True while the 2FA dialog is open for a token-expiry retry (vs. the initial
  // Start gate) — drives the dialog copy.
  const [isRetry, setIsRetry] = React.useState(false);
  // When set, a successful re-auth retries this pending approve index.
  const retryIndexRef = React.useRef<number | null>(null);

  const total = items.length;
  const approved = items.filter((i) => i.status === "approved").length;
  const declined = items.filter((i) => i.status === "declined").length;
  const pending = total - approved - declined;
  const current = items[index];

  // ── Navigation ──────────────────────────────────────────────────────
  const goTo = React.useCallback(
    (i: number) => {
      if (i < 0 || i >= total) return;
      setIndex(i);
    },
    [total],
  );
  const advance = React.useCallback(() => {
    setIndex((i) => Math.min(i + 1, total - 1));
  }, [total]);

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
          adjusted = { ...levers, feasible: false, after: null, weightDiff: null, error: shaped.error };
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
          adjusted = { ...levers, feasible: true, after, weightDiff, error: undefined };
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
          // Re-prompt 2FA, then retry THIS approve on success.
          retryIndexRef.current = i;
          setIsRetry(true);
          setTotp("");
          setAuthOpen(true);
          toast.message("2FA authorization expired — re-confirm to continue.");
        } else {
          toast.error(message);
        }
      } finally {
        setApplying(false);
      }
    },
    [items, router, advance],
  );

  const onApprove = React.useCallback(() => {
    if (applying) return;
    void performApprove(index);
  }, [applying, performApprove, index]);

  const onDecline = React.useCallback(() => {
    if (applying) return;
    setItems((prev) => {
      const next = [...prev];
      if (next[index]) next[index] = { ...next[index]!, status: "declined" };
      return next;
    });
    advance();
  }, [applying, index, advance]);

  // ── 2FA gate (Start review + token-expiry retry) ────────────────────
  const totpValid = /^\d{6}$/.test(totp.trim());

  async function confirmAuth() {
    if (!totpValid) return;
    setAuthBusy(true);
    try {
      const { token } = await authorizePackRetune(totp.trim());
      tokenRef.current = token;
      setStarted(true);
      setAuthOpen(false);
      setIsRetry(false);
      const retryIdx = retryIndexRef.current;
      retryIndexRef.current = null;
      if (retryIdx != null) {
        // Resume the approve that hit the expired token.
        void performApprove(retryIdx);
      } else {
        toast.success("Review session authorized.");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "2FA verification failed.");
    } finally {
      setAuthBusy(false);
    }
  }

  function openStartGate() {
    retryIndexRef.current = null;
    setIsRetry(false);
    setTotp("");
    setAuthOpen(true);
  }

  // ── Keyboard shortcuts (A approve · D decline · ←/→ navigate) ────────
  React.useEffect(() => {
    if (!started) return;
    function onKey(e: KeyboardEvent) {
      // Ignore when typing in an input / the 2FA dialog is open.
      const t = e.target as HTMLElement | null;
      if (
        authOpen ||
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
  }, [started, authOpen, applying, advance, goTo, index, onApprove, onDecline]);

  const progressPct = total > 0 ? Math.round(((approved + declined) / total) * 100) : 0;

  return (
    <div className="space-y-4">
      {/* Progress + counts strip */}
      <div className="rounded-xl border bg-card px-4 py-3">
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
            <Button size="sm" onClick={openStartGate}>
              <ShieldCheck className="mr-1 size-3.5" />
              Start review
            </Button>
          )}
        </div>
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary motion-safe:transition-all motion-safe:duration-300 motion-safe:ease-out"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
        <ReviewRail items={items} activeIndex={index} onJump={goTo} />

        <div className="relative">
          {current ? (
            <ReviewCard
              key={current.proposal.packId}
              item={current}
              index={index}
              total={total}
              targetEdge={targetEdge}
              applying={applying}
              onApprove={onApprove}
              onDecline={onDecline}
              onBack={() => goTo(index - 1)}
              onAdjust={(levers) => onAdjust(index, levers)}
              onResetAdjust={() => onResetAdjust(index)}
            />
          ) : null}

          {/* Pre-start overlay — the stack is inert until the token is minted. */}
          {!started && (
            <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-background/70 backdrop-blur-[1px]">
              <div className="max-w-xs rounded-xl border bg-card px-5 py-4 text-center shadow-sm">
                <KeyRound className="mx-auto mb-2 size-5 text-muted-foreground" />
                <p className="text-sm font-medium">Authorize to review</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Start the review to mint a 2FA-authorized session. Nothing is
                  written until you approve a pack.
                </p>
                <Button size="sm" className="mt-3" onClick={openStartGate}>
                  <ShieldCheck className="mr-1 size-3.5" />
                  Start review
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 2FA dialog (Start gate + token-expiry retry) */}
      <Dialog
        open={authOpen}
        onOpenChange={(o) => {
          if (authBusy) return;
          if (!o) {
            setAuthOpen(false);
            setIsRetry(false);
            retryIndexRef.current = null;
          }
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {isRetry ? "Re-confirm 2FA" : "Authorize re-tune session"}
            </DialogTitle>
            <DialogDescription>
              Enter your 2FA code to authorize approve-writes for this review
              session. The token authorizes every Approve; if it expires you&apos;ll
              be asked to re-confirm.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="retune-totp">2FA code</Label>
            <Input
              id="retune-totp"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={totp}
              onChange={(e) => setTotp(e.target.value.replace(/\D/g, ""))}
              placeholder="123456"
              className="w-40 tracking-[0.3em]"
              aria-invalid={totp.length > 0 && !totpValid}
              disabled={authBusy}
              onKeyDown={(e) => {
                if (e.key === "Enter" && totpValid && !authBusy) {
                  e.preventDefault();
                  void confirmAuth();
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setAuthOpen(false);
                setIsRetry(false);
                retryIndexRef.current = null;
              }}
              disabled={authBusy}
              className="w-full sm:w-auto"
            >
              Cancel
            </Button>
            <Button
              onClick={confirmAuth}
              disabled={!totpValid || authBusy}
              className="w-full sm:w-auto"
            >
              {authBusy ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : null}
              Authorize
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
