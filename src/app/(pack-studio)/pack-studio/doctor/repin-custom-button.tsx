"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Pin, TriangleAlert, ArrowRight, ExternalLink } from "lucide-react";
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
import { formatCurrency } from "@/lib/utils/format";
import { houseAmountTextClass } from "@/lib/house-pov";
import { cn } from "@/lib/utils";
import {
  authorizeReprice,
  repricePackToTargetEdge,
} from "@/app/(admin)/packs/actions";
import { planCustomRepin, type CustomRepinPlan } from "./retune-actions";
import {
  RetuneProgressDialog,
  type RetuneFailure,
} from "./retune-progress-dialog";

/**
 * "Re-pin packs to their target edge (≥ 10.99%)" (owner-only). Cash packs drift
 * below their house target as card prices move; this re-prices every below-target
 * pack back onto ITS PER-PACK target edge — the edge curve's floor (10.99%) plus
 * a gentle risk premium that rises with the pack's max-win $ exposure + price, so
 * a calm/cheap pack lands at 10.99% while a pricey high-jackpot pack lands a
 * touch above it. It reuses the EXISTING re-price flow end to end — only the
 * price moves, card odds are never touched:
 *
 *   1. `planCustomRepin(ids, "per-pack")` — READ-ONLY dry-run (per-pack targets).
 *   2. type-to-confirm + 2FA once (`authorizeReprice` mints a run token).
 *   3. per-pack `repricePackToTargetEdge(id, token, "per-pack")` in the same
 *      stoppable progress loop as the global re-price tool — the write derives
 *      each pack's curve target server-side from fresh DB truth (never trusts
 *      the dry-run's number).
 *
 * The candidate ids are the below-target packs the doctor grid already
 * surfaced; the dry-run re-derives each price from FRESH DB truth, so a stale
 * grid can't force a bad write (out-of-scope / on-target packs drop out).
 */

const CONFIRM_PHRASE = "REPRICE";
/** The edge FLOOR every pack targets at minimum (the curve only goes UP from here). */
const FLOOR_TARGET_PCT = "10.99";

type Phase = "idle" | "planning" | "ready" | "running" | "done";

function pct(edge: number | null): string {
  if (edge == null || !Number.isFinite(edge)) return "—";
  return `${(edge * 100).toFixed(2)}%`;
}

export function RepinCustomButton({
  candidateIds,
}: {
  /** Below-target pack ids from the current doctor snapshot. */
  candidateIds: string[];
}) {
  const router = useRouter();

  const [phase, setPhase] = React.useState<Phase>("idle");
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [progressOpen, setProgressOpen] = React.useState(false);
  const [plan, setPlan] = React.useState<CustomRepinPlan | null>(null);
  const [confirmText, setConfirmText] = React.useState("");
  const [totp, setTotp] = React.useState("");

  // Progress.
  const [processed, setProcessed] = React.useState(0);
  const [currentName, setCurrentName] = React.useState("");
  const [tally, setTally] = React.useState({ done: 0, failed: 0 });
  const [failures, setFailures] = React.useState<RetuneFailure[]>([]);
  const [fatalError, setFatalError] = React.useState<string | null>(null);
  const stopRef = React.useRef(false);

  const total = plan?.toReprice.length ?? 0;
  const totpValid = /^\d{6}$/.test(totp.trim());
  const confirmReady =
    phase === "ready" &&
    plan !== null &&
    total > 0 &&
    confirmText.trim().toUpperCase() === CONFIRM_PHRASE &&
    totpValid;

  async function openAndPlan() {
    setPlan(null);
    setConfirmText("");
    setTotp("");
    setPhase("planning");
    setConfirmOpen(true);
    try {
      const p = await planCustomRepin(candidateIds, "per-pack");
      setPlan(p);
      setPhase("ready");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to compute the re-pin plan.");
      setPhase("idle");
      setConfirmOpen(false);
    }
  }

  async function run() {
    if (!plan || total === 0) return;
    const rows = plan.toReprice;
    // Re-pass the SAME target selector the dry-run used ("per-pack" here) so the
    // write derives each pack's curve target identically — never the dry-run's
    // number. The server re-reads fresh price + max-win per pack.
    const runTarget = plan.target;

    let token: string;
    try {
      const res = await authorizeReprice(totp.trim());
      token = res.token;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "2FA verification failed.");
      return;
    }

    stopRef.current = false;
    setProcessed(0);
    setCurrentName("");
    setTally({ done: 0, failed: 0 });
    setFailures([]);
    setFatalError(null);
    setConfirmOpen(false);
    setProgressOpen(true);
    setPhase("running");

    let done = 0;
    let failed = 0;
    const fails: RetuneFailure[] = [];

    for (let i = 0; i < rows.length; i++) {
      if (stopRef.current) break;
      const row = rows[i]!;
      setCurrentName(row.name);
      try {
        const res = await repricePackToTargetEdge(row.packId, token, runTarget);
        if (res.status === "repriced") {
          done++;
        } else if (res.status === "failed") {
          failed++;
          fails.push({ name: res.name || row.name, message: res.reason || "Write failed." });
          setFailures([...fails]);
        }
        // unchanged / skipped → neither done nor failed (out of scope / on target).
        setProcessed(i + 1);
        setTally({ done, failed });
      } catch (err) {
        // A THROWN error = auth / token problem → abort.
        const message = err instanceof Error ? err.message : "Authorization failed.";
        setProcessed(i);
        setTally({ done, failed });
        setFatalError(message);
        setCurrentName("");
        setPhase("done");
        toast.error(`Run aborted: ${message}`);
        router.refresh();
        return;
      }
    }

    setCurrentName("");
    setTally({ done, failed });
    setPhase("done");
    if (stopRef.current) {
      toast.message(`Stopped — re-priced ${done}${failed ? `, ${failed} failed` : ""}.`);
    } else if (failed > 0) {
      toast.warning(`Re-priced ${done} · ${failed} failed — see details.`);
    } else {
      toast.success(`Re-pinned ${done} pack${done === 1 ? "" : "s"} to their target edge (≥ ${FLOOR_TARGET_PCT}%).`);
    }
    router.refresh();
  }

  function closeProgress() {
    setProgressOpen(false);
    setPhase("idle");
    setPlan(null);
    setProcessed(0);
    setCurrentName("");
    setTally({ done: 0, failed: 0 });
    setFailures([]);
    setFatalError(null);
  }

  const disabled = candidateIds.length === 0;

  return (
    <>
      <Button size="sm" onClick={openAndPlan} disabled={disabled}>
        <Pin className="mr-1 size-3.5" />
        Re-pin packs to their target edge (≥ {FLOOR_TARGET_PCT}%)
        {candidateIds.length > 0 ? ` (${candidateIds.length})` : ""}
      </Button>

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
            <AlertDialogTitle>Re-pin packs to their target edge</AlertDialogTitle>
            <AlertDialogDescription>
              Re-prices every below-target pack back to <strong>its own</strong>{" "}
              target edge — the floor {FLOOR_TARGET_PCT}% plus a gentle risk
              premium for pricier, higher-jackpot packs. Only the pack{" "}
              <strong>price</strong> changes —{" "}
              <strong>card odds are never touched</strong>. Each pack is written one at a
              time and the run is stoppable. Type{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono">{CONFIRM_PHRASE}</code>{" "}
              and your 2FA code to run.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-3 text-sm">
            {phase === "planning" && !plan && (
              <div className="flex items-center justify-center gap-2 py-6 text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Computing the re-pin plan…
              </div>
            )}

            {plan && (
              <>
                <div className="grid grid-cols-3 gap-2">
                  <CountTile label="Will re-pin" value={plan.toReprice.length} accent="emerald" />
                  <CountTile label="On target" value={plan.unchanged.length} accent="muted" />
                  <CountTile label="Skipped" value={plan.skipped.length} accent="amber" />
                </div>

                <p className="text-xs text-muted-foreground">
                  Each pack targets its own curve edge (floor{" "}
                  {pct(plan.targetFloor)}, rising for pricier / higher-jackpot
                  packs). Written only within ±0.05% of that pack&apos;s target;
                  packs that can&apos;t hit it (1¢ step too coarse) are skipped.
                </p>

                {plan.toReprice.length > 0 && (
                  <div className="rounded-lg border">
                    <p className="border-b px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                      Largest price changes
                    </p>
                    <div className="max-h-40 overflow-y-auto">
                      {plan.toReprice.slice(0, 12).map((r) => (
                        <div
                          key={r.packId}
                          className="flex items-center justify-between gap-2 border-b px-3 py-1.5 last:border-b-0"
                        >
                          <a
                            href={`/packs/${r.packId}`}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex min-w-0 items-center gap-1 truncate font-medium hover:underline"
                          >
                            <span className="truncate">{r.name}</span>
                            <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
                          </a>
                          <span className="flex shrink-0 items-center gap-1.5 tabular-nums">
                            <span className="text-muted-foreground">
                              {formatCurrency(r.priceBefore)}
                            </span>
                            <ArrowRight className="size-3 text-muted-foreground" />
                            <span className="font-medium">
                              {r.priceAfter != null ? formatCurrency(r.priceAfter) : "—"}
                            </span>
                            <span
                              className={cn(
                                "ml-1 text-[11px]",
                                houseAmountTextClass(r.edgeAfter ?? 0),
                              )}
                            >
                              {pct(r.edgeAfter)}
                            </span>
                          </span>
                        </div>
                      ))}
                    </div>
                    {plan.toReprice.length > 12 && (
                      <p className="border-t px-3 py-1.5 text-[11px] text-muted-foreground">
                        +{plan.toReprice.length - 12} more will also be re-pinned.
                      </p>
                    )}
                  </div>
                )}

                {total > 0 ? (
                  <div className="space-y-3 pt-1">
                    <div className="space-y-1.5">
                      <Label htmlFor="repin-confirm">Type {CONFIRM_PHRASE} to confirm</Label>
                      <Input
                        id="repin-confirm"
                        value={confirmText}
                        onChange={(e) => setConfirmText(e.target.value)}
                        placeholder={CONFIRM_PHRASE}
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="repin-totp">2FA code</Label>
                      <Input
                        id="repin-totp"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        maxLength={6}
                        value={totp}
                        onChange={(e) => setTotp(e.target.value.replace(/\D/g, ""))}
                        placeholder="123456"
                        className="w-40 tracking-[0.3em]"
                        aria-invalid={totp.length > 0 && !totpValid}
                      />
                    </div>
                  </div>
                ) : (
                  <p className="rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                    Nothing to re-pin — every below-target pack is already on target
                    or can&apos;t be brought into the band.
                  </p>
                )}
              </>
            )}
          </div>

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
            <Button onClick={run} disabled={!confirmReady} className="w-full sm:w-auto">
              Re-pin {total} pack{total === 1 ? "" : "s"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <RetuneProgressDialog
        open={progressOpen}
        running={phase === "running"}
        title={phase === "running" ? "Re-pinning below-target packs…" : "Re-pin complete"}
        runningLabel="Writing one pack at a time. You can stop after the current pack."
        verb="Re-pinned"
        processed={processed}
        total={total}
        currentName={currentName}
        doneCount={tally.done}
        failedCount={tally.failed}
        failures={failures}
        fatalError={fatalError}
        onStop={() => {
          stopRef.current = true;
        }}
        onClose={closeProgress}
      />
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
  accent: "emerald" | "amber" | "muted";
}) {
  const tone =
    accent === "emerald"
      ? "text-emerald-600 dark:text-emerald-400"
      : accent === "amber"
        ? "text-amber-600 dark:text-amber-400"
        : "text-foreground";
  return (
    <div className="rounded-lg border bg-muted/20 px-2.5 py-2 text-center">
      <p className={cn("text-lg font-semibold tabular-nums leading-none", tone)}>
        {value}
      </p>
      <p className="mt-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
    </div>
  );
}
