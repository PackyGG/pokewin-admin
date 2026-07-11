"use client";

import * as React from "react";
import { ArrowRight, ListChecks, TriangleAlert, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatCurrency } from "@/lib/utils/format";
import { safeQueryOrNull } from "@/lib/errors/safe-query";
import { cn } from "@/lib/utils";
import { TAGGED_WRITE_WINRATE_TOLERANCE } from "@/app/(admin)/packs/_lib/auto-targets";
import {
  applyPackRetune,
  type PackRetuneResult,
} from "@/app/(admin)/packs/actions";

import type { PackTunePlan } from "../../doctor/retune-actions";
import { planPackTuneOverWire } from "./plan-transport";
import {
  RetuneProgressDialog,
  type RetuneFailure,
} from "../../doctor/retune-progress-dialog";
import type { RetuneRailRow } from "../_queries/rail";
import {
  BULK_PLAN_RUNNING,
  BULK_PUSH_RUNNING,
  BULK_STAGED_NOTE,
  CONFIRM_STEP2_ACTION,
  bulkConfirmTitle,
  bulkPlanTitle,
  bulkPushLabel,
  bulkPushTitle,
  tagBadgeLabel,
} from "./plan-copy";
import { isTokenExpired } from "./plan-state";

/**
 * Bulk flow (§6): selection bar → **Phase 1 plan** (strictly sequential
 * `planPackTune(id)`, live arm, auto tag-aware targets — NEVER `Promise.all`,
 * the MAIN pool is max:3; cached packs land instantly) → **Phase 2 summary**
 * (per-pack price/edge/win-rate rows; infeasible + dirty-odds packs listed
 * and EXCLUDED from the push set) → **Phase 3** two-step confirm → **Phase 4
 * write**: a stoppable sequential `applyPackRetune` loop where every write
 * threads ITS OWN plan's `approvedPriceAfter` + `approvedPoolFingerprint`
 * pins (fixes the old pin-less bulk). Reuses `RetuneProgressDialog` verbatim.
 * No global lever inputs exist anywhere in V2.
 */

type BulkPhase = "idle" | "planning" | "review" | "confirm" | "running" | "done";

type PlannedRow = {
  packId: string;
  name: string;
  plan: PackTunePlan | null;
  /** null = pushable; else the one-line exclusion reason. */
  excluded: string | null;
  /** amber (dirty odds) vs rose (infeasible / off-tag / error). */
  excludedTone: "amber" | "rose" | null;
};

/** Push-set predicate — mirrors the workspace's push gate for the live arm. */
function exclusionFor(plan: PackTunePlan | null): {
  excluded: string | null;
  tone: "amber" | "rose" | null;
} {
  if (plan === null) {
    return { excluded: "Inactive or unpriced — out of scope.", tone: "rose" };
  }
  if (plan.tagContradiction !== null) {
    return { excluded: plan.tagContradiction, tone: "rose" };
  }
  if (!plan.feasible) {
    return {
      excluded: plan.limit?.detail ?? "Infeasible at the current pool.",
      tone: "rose",
    };
  }
  if (plan.intendedHitRate !== null) {
    if (plan.taggedAccuracyHit === false) {
      return { excluded: "No price hits the tag exactly — off tag.", tone: "rose" };
    }
    if (
      plan.after !== null &&
      Math.abs(plan.after.winRate - plan.intendedHitRate) >
        TAGGED_WRITE_WINRATE_TOLERANCE
    ) {
      return { excluded: "Planned win-rate misses the tag.", tone: "rose" };
    }
  }
  if (plan.snapped === false) {
    return { excluded: "Dirty odds — clean odds are required to push.", tone: "amber" };
  }
  return { excluded: null, tone: null };
}

export function BulkBar({
  checkedIds,
  rowsById,
  stagedIds,
  getToken,
  remintToken,
  onClearSelection,
  onUncheck,
  onPushed,
}: {
  /** Checked ids in rail (attention) order. */
  checkedIds: string[];
  rowsById: Map<string, RetuneRailRow>;
  stagedIds: Set<string>;
  /** Returns the session token, minting one if absent. */
  getToken: () => Promise<string>;
  /** Force-mints a fresh token (silent re-mint on expiry). */
  remintToken: () => Promise<string>;
  onClearSelection: () => void;
  /** Uncheck ONE pack (successes leave the selection; failures stay — F12). */
  onUncheck: (packId: string) => void;
  /** Rail patch + pushed badge for one successful write. */
  onPushed: (packId: string, plan: PackTunePlan, result: PackRetuneResult) => void;
}) {
  const [phase, setPhase] = React.useState<BulkPhase>("idle");
  const [planned, setPlanned] = React.useState<PlannedRow[]>([]);
  const [processed, setProcessed] = React.useState(0);
  const [total, setTotal] = React.useState(0);
  const [currentName, setCurrentName] = React.useState("");
  const [doneCount, setDoneCount] = React.useState(0);
  const [failedCount, setFailedCount] = React.useState(0);
  const [failures, setFailures] = React.useState<RetuneFailure[]>([]);
  const [fatalError, setFatalError] = React.useState<string | null>(null);
  const stopRef = React.useRef(false);

  const pushable = planned.filter((p) => p.excluded === null && p.plan !== null);
  const excluded = planned.filter((p) => p.excluded !== null);
  const stagedSelected = checkedIds.filter((id) => stagedIds.has(id));

  // ── Phase 1 — sequential read-only plans ──────────────────────────────────
  const startPlanning = React.useCallback(async () => {
    const ids = [...checkedIds];
    stopRef.current = false;
    setPhase("planning");
    setPlanned([]);
    setProcessed(0);
    setTotal(ids.length);
    setDoneCount(0);
    setFailedCount(0);
    setFailures([]);
    setFatalError(null);

    const out: PlannedRow[] = [];
    for (const id of ids) {
      if (stopRef.current) break;
      const name = rowsById.get(id)?.name ?? id;
      setCurrentName(name);
      // Strictly sequential — one plan at a time against the max:3 MAIN pool.
      // Over the route transport: the bulk sweep no longer hogs the client's
      // serialized server-action queue, so interactive plans stay responsive.
      const { data, error } = await safeQueryOrNull(
        () => planPackTuneOverWire(id, null, null),
        "pack-studio.retune.plan-pack",
        20_000,
      );
      if (error) {
        out.push({
          packId: id,
          name,
          plan: null,
          excluded: "Planning failed or timed out.",
          excludedTone: "rose",
        });
        setFailedCount((c) => c + 1);
        setFailures((f) => [...f, { name, message: error }]);
      } else {
        const { excluded: reason, tone } = exclusionFor(data);
        out.push({
          packId: id,
          name: data?.name ?? name,
          plan: data,
          excluded: reason,
          excludedTone: tone,
        });
        setDoneCount((c) => c + 1);
      }
      setProcessed((p) => p + 1);
      setPlanned([...out]);
    }
    setCurrentName("");
    setPhase("review");
  }, [checkedIds, rowsById]);

  // ── Phase 4 — sequential artifact writes (own pins per pack) ──────────────
  const startWriting = React.useCallback(async () => {
    const targetsOf = (plan: PackTunePlan) => ({
      targetEdge: plan.targets.targetEdge,
      targetWinRate: plan.targets.targetWinRate,
      maxWinCap: plan.targets.maxWinCap,
      nearMissMin: plan.targets.nearMissMin,
      allowPriceSearch: true,
      upwardPriceExtensionPct: 0,
      approvedPriceAfter: plan.priceAfter,
      approvedPoolFingerprint: plan.poolFingerprint,
    });

    stopRef.current = false;
    setPhase("running");
    setProcessed(0);
    setTotal(pushable.length);
    setDoneCount(0);
    setFailedCount(0);
    setFailures([]);
    setFatalError(null);

    let token: string;
    try {
      token = await getToken();
    } catch (err) {
      setFatalError(
        err instanceof Error ? err.message : "Could not mint a retune token.",
      );
      setPhase("done");
      return;
    }

    for (const row of pushable) {
      if (stopRef.current) break;
      const plan = row.plan!;
      setCurrentName(row.name);
      try {
        // Refusals arrive as DATA (`refusedMessage`) — Next prod masks
        // server-action throws (incident 2026-07-11), so routing matches the
        // returned message, never a caught error's.
        let result = await applyPackRetune(row.packId, token, targetsOf(plan));
        if (
          "refusedMessage" in result &&
          isTokenExpired(result.refusedMessage)
        ) {
          // Silent re-mint + ONE retry; a second auth failure aborts the loop.
          try {
            token = await remintToken();
          } catch (mintErr) {
            setFatalError(
              mintErr instanceof Error
                ? mintErr.message
                : "Token re-mint failed.",
            );
            break;
          }
          result = await applyPackRetune(row.packId, token, targetsOf(plan));
        }
        if ("refusedMessage" in result) {
          throw new Error(result.refusedMessage);
        }
        onPushed(row.packId, plan, result);
        onUncheck(row.packId);
        setDoneCount((c) => c + 1);
      } catch (err) {
        // Per-pack failure — record it, keep it selected (F12), continue.
        setFailedCount((c) => c + 1);
        setFailures((f) => [
          ...f,
          {
            name: row.name,
            message: err instanceof Error ? err.message : "Re-tune failed.",
          },
        ]);
      }
      setProcessed((p) => p + 1);
    }
    setCurrentName("");
    setPhase("done");
  }, [pushable, getToken, remintToken, onPushed, onUncheck]);

  if (checkedIds.length === 0 && phase === "idle") return null;

  return (
    <>
      {/* ── Selection bar ──────────────────────────────────────────────────── */}
      {checkedIds.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card px-3 py-2">
          <ListChecks className="size-4 text-primary" />
          <span className="text-sm font-medium">
            {checkedIds.length} selected
          </span>
          <Button
            type="button"
            size="sm"
            onClick={() => void startPlanning()}
            disabled={phase !== "idle"}
          >
            Plan tune
            <ArrowRight className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClearSelection}
            disabled={phase === "planning" || phase === "running"}
          >
            <X className="size-3.5" />
            Clear
          </Button>
          <span className="text-[11px] text-muted-foreground">
            Sequential read-only plans first — nothing writes before the
            two-step confirm.
          </span>
        </div>
      )}

      {/* ── Phase 1 progress ───────────────────────────────────────────────── */}
      <RetuneProgressDialog
        open={phase === "planning"}
        running={phase === "planning"}
        title={bulkPlanTitle(total)}
        runningLabel={BULK_PLAN_RUNNING}
        verb="Planned"
        processed={processed}
        total={total}
        currentName={currentName}
        doneCount={doneCount}
        failedCount={failedCount}
        failures={failures}
        fatalError={null}
        onStop={() => {
          stopRef.current = true;
        }}
        onClose={() => setPhase("review")}
      />

      {/* ── Phase 2 summary ────────────────────────────────────────────────── */}
      <Dialog
        open={phase === "review"}
        onOpenChange={(o) => {
          if (!o) setPhase("idle");
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              Bulk plan — {pushable.length} pushable, {excluded.length} excluded
            </DialogTitle>
            <DialogDescription>
              Every pack was planned on its own tag-aware auto targets. Only
              clean, on-tag, feasible plans join the push set.
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-[50vh] space-y-2 overflow-y-auto">
            {stagedSelected.length > 0 && (
              <p className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  {stagedSelected.length} selected pack
                  {stagedSelected.length === 1 ? " has" : "s have"} staged
                  edits — {BULK_STAGED_NOTE}.
                </span>
              </p>
            )}
            {pushable.map((p) => {
              const plan = p.plan!;
              const tag = plan.intendedHitRate;
              return (
                <div
                  key={p.packId}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2 text-sm"
                >
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {p.name}
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {formatCurrency(plan.price)} →{" "}
                    <span className="text-foreground">
                      {formatCurrency(plan.priceAfter)}
                    </span>
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    edge {(plan.before.edge * 100).toFixed(2)}% →{" "}
                    <span className="text-foreground">
                      {plan.after ? `${(plan.after.edge * 100).toFixed(2)}%` : "—"}
                    </span>
                  </span>
                  {tag !== null && plan.after !== null && (
                    <Badge
                      variant="outline"
                      className={cn(
                        "h-5 px-1.5 text-[10px]",
                        Math.abs(plan.after.winRate - tag) <=
                          TAGGED_WRITE_WINRATE_TOLERANCE + 1e-12
                          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                          : "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400",
                      )}
                    >
                      {tagBadgeLabel(tag)} ·{" "}
                      {(plan.after.winRate * 100).toFixed(2)}%
                    </Badge>
                  )}
                  <Badge
                    variant="outline"
                    className={cn(
                      "h-5 px-1.5 text-[10px]",
                      plan.snapped
                        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                        : "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
                    )}
                  >
                    {plan.snapped ? "clean" : "dirty"}
                  </Badge>
                </div>
              );
            })}
            {excluded.map((p) => (
              <div
                key={p.packId}
                className={cn(
                  "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2 text-sm",
                  p.excludedTone === "amber"
                    ? "border-amber-500/30 bg-amber-500/5"
                    : "border-rose-500/30 bg-rose-500/5",
                )}
              >
                <span className="min-w-0 flex-1 truncate font-medium">
                  {p.name}
                </span>
                <span
                  className={cn(
                    "text-xs",
                    p.excludedTone === "amber"
                      ? "text-amber-600 dark:text-amber-400"
                      : "text-rose-600 dark:text-rose-400",
                  )}
                >
                  {p.excluded}
                </span>
              </div>
            ))}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setPhase("idle")}>
              Cancel
            </Button>
            <Button
              onClick={() => setPhase("confirm")}
              disabled={pushable.length === 0}
            >
              {bulkPushLabel(pushable.length)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Phase 3 — "100% sure" ──────────────────────────────────────────── */}
      <AlertDialog
        open={phase === "confirm"}
        onOpenChange={(o) => {
          if (!o) setPhase("review");
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-rose-600 dark:text-rose-400">
              {bulkConfirmTitle(pushable.length)}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Each pack writes its own frozen plan (price pin + pool
              fingerprint). The loop is stoppable after the current pack;
              packs already processed stay written.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel autoFocus onClick={() => setPhase("review")}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => void startWriting()}
              // Pointer-only — no keyboard path fires a money write (§6).
              onKeyDown={(e: React.KeyboardEvent) => {
                if (e.key === "Enter" || e.key === " ") e.preventDefault();
              }}
            >
              {CONFIRM_STEP2_ACTION}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Phase 4 progress + done ────────────────────────────────────────── */}
      <RetuneProgressDialog
        open={phase === "running" || phase === "done"}
        running={phase === "running"}
        title={bulkPushTitle(total)}
        runningLabel={BULK_PUSH_RUNNING}
        verb="Pushed"
        processed={processed}
        total={total}
        currentName={currentName}
        doneCount={doneCount}
        failedCount={failedCount}
        failures={failures}
        fatalError={fatalError}
        onStop={() => {
          stopRef.current = true;
        }}
        onClose={() => setPhase("idle")}
      />
    </>
  );
}
