"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Target, TriangleAlert, Loader2, ArrowRight } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatCurrency } from "@/lib/utils/format";
import { houseAmountTextClass } from "@/lib/house-pov";
import { cn } from "@/lib/utils";
import {
  planRepriceAllPacks,
  repricePackToTargetEdge,
  type RepricePlanSummary,
  type RepricePlanRow,
} from "./actions";

const CONFIRM_PHRASE = "REPRICE";

/** A confirm/preview/progress phase. */
type Phase = "idle" | "planning" | "ready" | "running" | "done";

/** Render a house-edge fraction (0.1099) as "10.99%". */
function pct(edge: number | null): string {
  if (edge == null || !Number.isFinite(edge)) return "—";
  return `${(edge * 100).toFixed(2)}%`;
}

/**
 * Global "Re-price all packs → 10.99% edge" tool. Admin-only (the page only
 * mounts it for admins; the server actions independently re-check).
 *
 * Flow: button → READ-ONLY dry-run preview in a type-to-confirm dialog → a
 * stoppable, pack-by-pack progress modal that calls the guarded single-pack
 * write action once per pack. Nothing is written until the operator types the
 * confirm phrase and presses the action; each pack is its own audited write.
 */
export function RepriceAllPacksButton() {
  const router = useRouter();

  const [phase, setPhase] = React.useState<Phase>("idle");
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [progressOpen, setProgressOpen] = React.useState(false);
  const [plan, setPlan] = React.useState<RepricePlanSummary | null>(null);
  const [confirmText, setConfirmText] = React.useState("");

  // Progress state.
  const [processed, setProcessed] = React.useState(0);
  const [currentName, setCurrentName] = React.useState("");
  const [tally, setTally] = React.useState({ repriced: 0, skipped: 0, failed: 0 });
  const [failure, setFailure] = React.useState<{ name: string; message: string } | null>(
    null,
  );
  // Stop is read inside the async loop — a ref so the latest value is seen.
  const stopRef = React.useRef(false);

  const total = plan?.toReprice.length ?? 0;
  const progressPct = total > 0 ? Math.round((processed / total) * 100) : 100;
  const confirmReady =
    phase === "ready" && total > 0 && confirmText.trim().toUpperCase() === CONFIRM_PHRASE;

  function openConfirm() {
    setPlan(null);
    setConfirmText("");
    setPhase("planning");
    setConfirmOpen(true);
    void loadPlan();
  }

  async function loadPlan() {
    try {
      const p = await planRepriceAllPacks();
      setPlan(p);
      setPhase("ready");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to compute the re-price plan",
      );
      setConfirmOpen(false);
      setPhase("idle");
    }
  }

  async function runReprice() {
    if (!plan || total === 0) return;
    const rows = plan.toReprice;
    stopRef.current = false;
    setProcessed(0);
    setCurrentName("");
    setTally({ repriced: 0, skipped: 0, failed: 0 });
    setFailure(null);
    setConfirmOpen(false);
    setProgressOpen(true);
    setPhase("running");

    let repriced = 0;
    let skipped = 0;

    for (let i = 0; i < rows.length; i++) {
      if (stopRef.current) break;
      const row = rows[i];
      setCurrentName(row.name);
      try {
        const res = await repricePackToTargetEdge(row.packId);
        if (res.status === "repriced") repriced++;
        else skipped++;
        setProcessed(i + 1);
        setTally({ repriced, skipped, failed: 0 });
      } catch (err) {
        // Fail CLOSED: stop the whole run on the first write error. Packs
        // already written stay written; re-running is safe (idempotent).
        const message = err instanceof Error ? err.message : "Write failed";
        setProcessed(i + 1);
        setTally({ repriced, skipped, failed: 1 });
        setFailure({ name: row.name, message });
        setCurrentName("");
        setPhase("done");
        toast.error(`Stopped at "${row.name}": ${message}`);
        router.refresh();
        return;
      }
    }

    setCurrentName("");
    setTally({ repriced, skipped, failed: 0 });
    setPhase("done");
    if (stopRef.current) {
      toast.message(`Stopped — re-priced ${repriced} pack${repriced === 1 ? "" : "s"}.`);
    } else {
      toast.success(`Re-priced ${repriced} pack${repriced === 1 ? "" : "s"} to ~10.99%.`);
    }
    router.refresh();
  }

  function requestStop() {
    stopRef.current = true;
  }

  function closeProgress() {
    setProgressOpen(false);
    setPhase("idle");
    setPlan(null);
    setConfirmText("");
    setProcessed(0);
    setCurrentName("");
    setTally({ repriced: 0, skipped: 0, failed: 0 });
    setFailure(null);
  }

  const isProd = plan?.dbEnv === "prod";

  return (
    <>
      <Button variant="outline" size="sm" onClick={openConfirm}>
        <Target className="mr-1 size-3.5" />
        Re-price → 10.99%
      </Button>

      {/* ── Confirm + read-only preview ─────────────────────────────── */}
      <AlertDialog
        open={confirmOpen}
        onOpenChange={(o) => {
          if (!o) {
            setConfirmOpen(false);
            setPhase("idle");
          }
        }}
      >
        <AlertDialogContent className="sm:max-w-lg">
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-rose-500/10 text-rose-600 dark:text-rose-400">
              <TriangleAlert />
            </AlertDialogMedia>
            <AlertDialogTitle>Re-price every official pack to 10.99%</AlertDialogTitle>
            <AlertDialogDescription>
              Official packs only. Only the pack <strong>price</strong> changes —{" "}
              <strong>card odds are never touched</strong>. Review the plan below, then
              type{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono">{CONFIRM_PHRASE}</code>{" "}
              to enable the action. Each pack is written one at a time and the run is
              stoppable.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {phase === "planning" && (
            <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Computing the re-price plan…
            </div>
          )}

          {phase !== "planning" && plan && (
            <div className="space-y-3 text-sm">
              {/* DB-env banner — prod vs dev must be unmistakable. */}
              <div
                className={cn(
                  "flex items-center justify-between rounded-lg border px-3 py-2 text-xs font-medium",
                  isProd
                    ? "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400"
                    : "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
                )}
              >
                <span>
                  Target DB:{" "}
                  <span className="font-semibold uppercase">{plan.dbEnv}</span>
                  {isProd ? " — LIVE production game DB" : " — dev game DB"}
                </span>
              </div>

              {/* Counts */}
              <div className="grid grid-cols-3 gap-2">
                <CountTile label="Will re-price" value={plan.counts.toReprice} accent="emerald" />
                <CountTile label="Already on target" value={plan.counts.unchanged} accent="muted" />
                <CountTile label="Skipped" value={plan.counts.skipped} accent="amber" />
              </div>

              <p className="text-xs text-muted-foreground">
                Target {pct(plan.target)} · written only if achievable within{" "}
                {pct(plan.acceptMin)}–{pct(plan.acceptMax)} · hard cap{" "}
                {pct(plan.hardMin)}–{pct(plan.hardMax)} (packs that can&apos;t hit it are
                skipped, never re-priced off-target).
              </p>

              {/* Preview of the largest changes */}
              {plan.toReprice.length > 0 && (
                <div className="rounded-lg border">
                  <p className="border-b px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    Largest price changes
                  </p>
                  <div className="max-h-44 overflow-y-auto">
                    {plan.toReprice.slice(0, 12).map((r) => (
                      <ChangeRow key={r.packId} row={r} />
                    ))}
                  </div>
                  {plan.toReprice.length > 12 && (
                    <p className="border-t px-3 py-1.5 text-[11px] text-muted-foreground">
                      +{plan.toReprice.length - 12} more pack
                      {plan.toReprice.length - 12 === 1 ? "" : "s"} will also be re-priced.
                    </p>
                  )}
                </div>
              )}

              {/* Skipped reasons (collapsed-ish) */}
              {plan.skipped.length > 0 && (
                <details className="rounded-lg border">
                  <summary className="cursor-pointer px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    {plan.skipped.length} skipped — why?
                  </summary>
                  <div className="max-h-40 overflow-y-auto border-t">
                    {plan.skipped.slice(0, 20).map((r) => (
                      <div
                        key={r.packId}
                        className="flex flex-col gap-0.5 border-b px-3 py-1.5 last:border-b-0"
                      >
                        <span className="truncate font-medium">{r.name}</span>
                        <span className="text-[11px] text-muted-foreground">{r.reason}</span>
                      </div>
                    ))}
                  </div>
                </details>
              )}

              {total > 0 ? (
                <div className="space-y-1.5 pt-1">
                  <Label htmlFor="reprice-confirm">
                    Type {CONFIRM_PHRASE} to confirm
                  </Label>
                  <Input
                    id="reprice-confirm"
                    value={confirmText}
                    onChange={(e) => setConfirmText(e.target.value)}
                    placeholder={CONFIRM_PHRASE}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
              ) : (
                <p className="rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                  Nothing to re-price — every official pack is already at the 10.99%
                  target (or can&apos;t be brought into the safe band).
                </p>
              )}
            </div>
          )}

          <AlertDialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setConfirmOpen(false);
                setPhase("idle");
              }}
              className="w-full sm:w-auto"
            >
              Cancel
            </Button>
            <Button
              onClick={runReprice}
              disabled={!confirmReady}
              className="w-full sm:w-auto"
            >
              Re-price {total} pack{total === 1 ? "" : "s"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Progress (non-dismissable while running) ────────────────── */}
      <Dialog
        open={progressOpen}
        onOpenChange={(o) => {
          if (phase === "running") return; // can't dismiss mid-run
          if (!o) closeProgress();
        }}
      >
        <DialogContent className="sm:max-w-md" showCloseButton={phase !== "running"}>
          <DialogHeader>
            <DialogTitle>
              {phase === "running" ? "Re-pricing packs…" : "Re-price complete"}
            </DialogTitle>
            <DialogDescription>
              {phase === "running"
                ? "Writing one pack at a time. You can stop after the current pack."
                : failure
                  ? "The run stopped on an error. Packs processed before it stay re-priced."
                  : "Done. Packs already at target were left untouched."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary motion-safe:transition-all motion-safe:duration-300 motion-safe:ease-out"
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                {processed} / {total} processed
              </span>
              <span className="tabular-nums">{progressPct}%</span>
            </div>

            {phase === "running" && currentName && (
              <p className="flex items-center gap-2 truncate text-sm">
                <Loader2 className="size-3.5 shrink-0 animate-spin" />
                <span className="truncate">{currentName}</span>
              </p>
            )}

            <div className="grid grid-cols-3 gap-2 pt-1">
              <CountTile label="Re-priced" value={tally.repriced} accent="emerald" />
              <CountTile label="Skipped" value={tally.skipped} accent="amber" />
              <CountTile label="Failed" value={tally.failed} accent={tally.failed ? "rose" : "muted"} />
            </div>

            {failure && (
              <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-400">
                <span className="font-medium">{failure.name}:</span> {failure.message}
              </div>
            )}
          </div>

          <DialogFooter>
            {phase === "running" ? (
              <Button variant="outline" onClick={requestStop} className="w-full sm:w-auto">
                Stop after current
              </Button>
            ) : (
              <Button onClick={closeProgress} className="w-full sm:w-auto">
                Close
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function CountTile({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent: "emerald" | "amber" | "rose" | "muted";
}) {
  const tone =
    accent === "emerald"
      ? "text-emerald-600 dark:text-emerald-400"
      : accent === "amber"
        ? "text-amber-600 dark:text-amber-400"
        : accent === "rose"
          ? "text-rose-600 dark:text-rose-400"
          : "text-foreground";
  return (
    <div className="rounded-lg border bg-muted/20 px-2.5 py-2 text-center">
      <p className={cn("text-lg font-semibold tabular-nums leading-none", tone)}>{value}</p>
      <p className="mt-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
    </div>
  );
}

function ChangeRow({ row }: { row: RepricePlanRow }) {
  return (
    <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5 last:border-b-0">
      <span className="min-w-0 flex-1 truncate">{row.name}</span>
      <span className="flex items-center gap-1.5 tabular-nums">
        <span className="text-muted-foreground">{formatCurrency(row.priceBefore)}</span>
        <ArrowRight className="size-3 text-muted-foreground" />
        <span className="font-medium">
          {row.priceAfter != null ? formatCurrency(row.priceAfter) : "—"}
        </span>
        <span className={cn("ml-1 text-[11px]", houseAmountTextClass(row.edgeAfter ?? 0))}>
          {pct(row.edgeAfter)}
        </span>
      </span>
    </div>
  );
}
