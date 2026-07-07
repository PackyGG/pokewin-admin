"use client";

import * as React from "react";
import { ArrowRight, Loader2, TriangleAlert } from "lucide-react";

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
import { formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

import type { PackTunePlan, StagedPoolInput } from "../../doctor/retune-actions";
import { CardDiffTable, type CardDiffRow } from "./card-diff-table";
import {
  CONFIRM_BASIS_NOTE,
  CONFIRM_STEP1_CONTINUE,
  CONFIRM_STEP2_ACTION,
  CONFIRM_STEP2_TITLE,
  F10_PLAN_CHANGED,
  confirmPendingDefensiveBanner,
  confirmStep1Title,
  relaxationLine,
} from "./plan-copy";

/**
 * The two-step push confirm (§5e / §4): step 1 renders the EXACT frozen
 * artifact (price/edge/win-rate/max-win before→after, relaxation notes, and
 * the per-card diff through the SAME `CardDiffTable` the pool shows — one
 * renderer, no confirm-mirror drift); step 2 is the rose destructive "100%
 * sure" gate. ONLY step 2 fires the write, and it sends ONLY the frozen
 * plan's fields (the workspace re-checks the frozen keys at the click and
 * swaps to "Plan changed underneath — nothing was written" on mismatch).
 *
 * Keyboard safety (§6): NO keyboard path fires the money write — step 2's
 * destructive button is pointer-only (initial focus lands on Cancel via
 * `autoFocus`; Enter/Space are swallowed on the action button).
 */

export type PendingPush = {
  packId: string;
  arm: "live" | "staged";
  /** The frozen plan — the write payload, verbatim. */
  frozen: PackTunePlan;
  /** basisKey at freeze time — re-checked at the step-2 click (F10). */
  frozenBasisKey: string;
  /** The staged write payload frozen at confirm-open (staged arm only). */
  writeInput: StagedPoolInput | null;
  pinPrice: boolean;
  /** Frozen per-card diff rows for the step-1 render. */
  frozenRows: CardDiffRow[];
  /**
   * Pending-edits count at freeze time — the push gate (LAW P) guarantees 0;
   * any non-zero renders the defensive rose banner in step 1 (belt-and-
   * suspenders: the write recheck also blocks it at the step-2 click).
   */
  pendingAtFreeze: number;
  step: 1 | 2;
  /** F10 — the plan changed while the confirm was open; nothing was written. */
  changed: boolean;
  /** F6 double-failure (or mint failure) surfaced in the step-2 dialog. */
  error: string | null;
};

function DeltaLine({
  label,
  before,
  after,
  format,
}: {
  label: string;
  before: number;
  after: number | null;
  format: (v: number) => string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex items-center gap-1.5 font-medium tabular-nums">
        <span className="text-muted-foreground">{format(before)}</span>
        {after !== null && (
          <>
            <ArrowRight className="size-3.5 text-muted-foreground" />
            <span>{format(after)}</span>
          </>
        )}
      </span>
    </div>
  );
}

export function PushConfirm({
  pending,
  pushing,
  onContinue,
  onConfirm,
  onBackToStep1,
  onClose,
}: {
  pending: PendingPush | null;
  pushing: boolean;
  /** Step 1 → step 2. */
  onContinue: () => void;
  /** Step 2 destructive click — the workspace re-checks the frozen keys, then writes. */
  onConfirm: () => void;
  onBackToStep1: () => void;
  onClose: () => void;
}) {
  const open = pending !== null;
  const step = pending?.step ?? 1;
  const plan = pending?.frozen ?? null;

  const handleOpenChange = (next: boolean) => {
    if (next || pushing) return;
    // Esc / overlay: step 2 steps BACK to the summary; step 1 closes (§6).
    if (step === 2 && pending && !pending.changed && !pending.error) {
      onBackToStep1();
    } else {
      onClose();
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      {plan && step === 1 && (
        <AlertDialogContent className="sm:max-w-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmStep1Title(plan.name)}</AlertDialogTitle>
            <AlertDialogDescription>
              This is the exact frozen artifact the push writes — the server
              refuses anything else (price pin, tolerance 0 + pool
              fingerprint). {CONFIRM_BASIS_NOTE}
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-3">
            {/* Defensive only — the push gate blocks the confirm from opening
                with a non-empty buffer; if one exists anyway, say it in rose. */}
            {pending !== null && pending.pendingAtFreeze > 0 && (
              <div className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-400">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  {confirmPendingDefensiveBanner(pending.pendingAtFreeze)}
                </span>
              </div>
            )}
            <div className="rounded-lg border px-3 py-1.5">
              <DeltaLine
                label="Ticket price"
                before={plan.price}
                after={plan.priceAfter}
                format={formatCurrency}
              />
              <DeltaLine
                label="House edge"
                before={plan.before.edge * 100}
                after={plan.after !== null ? plan.after.edge * 100 : null}
                format={(v) => `${v.toFixed(2)}%`}
              />
              <DeltaLine
                label="Win rate"
                before={plan.before.winRate * 100}
                after={plan.after !== null ? plan.after.winRate * 100 : null}
                format={(v) => `${v.toFixed(2)}%`}
              />
              <DeltaLine
                label="Max win"
                before={plan.before.maxWin}
                after={plan.after !== null ? plan.after.maxWin : null}
                format={formatCurrency}
              />
            </div>

            {plan.relaxations.length > 0 && (
              <ul className="list-disc space-y-0.5 rounded-lg border border-amber-500/30 bg-amber-500/10 py-2 pl-7 pr-3 text-xs text-amber-600 dark:text-amber-400">
                {plan.relaxations.map((r, i) => (
                  <li key={`${r.lever}-${i}`}>
                    {relaxationLine(r, { tag: plan.intendedHitRate })}
                  </li>
                ))}
              </ul>
            )}

            {/* The SAME renderer the pool table uses (D1 steal). */}
            <CardDiffTable
              rows={pending?.frozenRows ?? []}
              contextPrice={plan.priceAfter}
            />
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel onClick={onClose}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={onContinue}>
              {CONFIRM_STEP1_CONTINUE}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      )}

      {plan && step === 2 && (
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle
              className={cn(
                !pending?.changed && "text-rose-600 dark:text-rose-400",
              )}
            >
              {pending?.changed ? F10_PLAN_CHANGED : CONFIRM_STEP2_TITLE}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pending?.changed ? (
                "The pool or plan moved while this confirm was open. Close and review the fresh plan before pushing."
              ) : (
                <>
                  {plan.name}: {formatCurrency(plan.price)} →{" "}
                  {formatCurrency(plan.priceAfter)} ticket. One live MAIN
                  write, revertable from History.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {pending?.error && (
            <div className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-400">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
              <span>{pending.error}</span>
            </div>
          )}

          <AlertDialogFooter>
            {/* Initial focus lands HERE — Enter can only cancel, never push. */}
            <AlertDialogCancel autoFocus onClick={onClose}>
              Cancel
            </AlertDialogCancel>
            {!pending?.changed && (
              <AlertDialogAction
                variant="destructive"
                disabled={pushing}
                onClick={onConfirm}
                // Pointer-only (§6): the audit's stale-approve rode a keyboard
                // shortcut — Enter/Space never fire the production write.
                onKeyDown={(e: React.KeyboardEvent) => {
                  if (e.key === "Enter" || e.key === " ") e.preventDefault();
                }}
              >
                {pushing && <Loader2 className="size-4 animate-spin" />}
                {CONFIRM_STEP2_ACTION}
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      )}
    </AlertDialog>
  );
}
