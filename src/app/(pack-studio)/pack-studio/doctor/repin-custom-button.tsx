"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Pin, ArrowRight, ArrowUp, ExternalLink } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { StepUpField } from "@/components/step-up-field";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
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

/** The edge FLOOR every pack targets at minimum (the curve only goes UP from here). */
const FLOOR_TARGET_PCT = "10.99";
/** The edge CEILING a raise may never cross (the curve's cap). */
const CEILING_TARGET_PCT = "11.50";

/**
 * The two flavours this button ships in — same plan → confirm → per-pack write
 * machinery, different target selector:
 *
 *  • `per-pack`        — each pack to ITS curve target (floor + risk premium).
 *  • `floor-raise-only`— every pack to the FLOOR, and ONLY by raising the price.
 *    A pack already at or above the floor is left alone instead of being made
 *    cheaper. The server enforces the raise on fresh truth; this copy just
 *    tells the operator what they're authorizing.
 */
type RepinMode = "per-pack" | "floor-raise-only";

const MODE_COPY: Record<
  RepinMode,
  { button: string; title: string; subtitle: string; running: string; success: string }
> = {
  "per-pack": {
    button: `Re-pin packs to their target edge (≥ ${FLOOR_TARGET_PCT}%)`,
    title: "Re-pin to target edge",
    subtitle: "Price only — card odds are never touched.",
    running: "Re-pinning below-target packs…",
    success: `to their target edge (≥ ${FLOOR_TARGET_PCT}%)`,
  },
  "floor-raise-only": {
    button: `Raise price only to reach ≥ ${FLOOR_TARGET_PCT}%`,
    title: `Raise price to ${FLOOR_TARGET_PCT}–${CEILING_TARGET_PCT}%`,
    subtitle: "Price goes up only — card odds are never touched.",
    running: "Raising prices…",
    success: `to ${FLOOR_TARGET_PCT}–${CEILING_TARGET_PCT}% by raising price`,
  },
};

type Phase = "idle" | "planning" | "ready" | "running" | "done";

function pct(edge: number | null): string {
  if (edge == null || !Number.isFinite(edge)) return "—";
  return `${(edge * 100).toFixed(2)}%`;
}

export function RepinCustomButton({
  candidateIds,
  mode = "per-pack",
  variant = "default",
}: {
  /** Below-target pack ids from the current doctor snapshot. */
  candidateIds: string[];
  /** Which target selector this button runs — see {@link RepinMode}. */
  mode?: RepinMode;
  variant?: "default" | "outline";
}) {
  const router = useRouter();
  const copy = MODE_COPY[mode];
  const raiseOnly = mode === "floor-raise-only";

  const [phase, setPhase] = React.useState<Phase>("idle");
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [progressOpen, setProgressOpen] = React.useState(false);
  const [plan, setPlan] = React.useState<CustomRepinPlan | null>(null);
  const [totp, setTotp] = React.useState("");

  // Progress.
  const [processed, setProcessed] = React.useState(0);
  const [currentName, setCurrentName] = React.useState("");
  const [tally, setTally] = React.useState({ done: 0, failed: 0 });
  const [failures, setFailures] = React.useState<RetuneFailure[]>([]);
  const [fatalError, setFatalError] = React.useState<string | null>(null);
  const stopRef = React.useRef(false);

  const total = plan?.toReprice.length ?? 0;
  // Non-empty is enough client-side: the value is either a 6-digit TOTP or a
  // passkey step-up proof token. require2FA validates the real format server-side.
  // 2FA is the ONLY gate now — the type-to-confirm phrase was removed at the
  // owner's request; the server-side operator + token checks are unchanged.
  const totpValid = totp.trim().length > 0;
  const confirmReady = phase === "ready" && plan !== null && total > 0 && totpValid;

  async function openAndPlan() {
    setPlan(null);
    setTotp("");
    setPhase("planning");
    setConfirmOpen(true);
    try {
      const p = await planCustomRepin(candidateIds, mode);
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
        // A `failed` result is a returned VALUE, so it is usually transient (a
        // DB hiccup, a lost connection) rather than a refusal — refusals come
        // back as `skipped`. Retry a couple of times with a short backoff before
        // recording it, so one blip doesn't leave a pack behind in a long run.
        let res = await repricePackToTargetEdge(row.packId, token, runTarget);
        for (let attempt = 0; res.status === "failed" && attempt < 2; attempt++) {
          if (stopRef.current) break;
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
          res = await repricePackToTargetEdge(row.packId, token, runTarget);
        }
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
      toast.success(`Re-pinned ${done} pack${done === 1 ? "" : "s"} ${copy.success}.`);
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
      <Button size="sm" variant={variant} onClick={openAndPlan} disabled={disabled}>
        {raiseOnly ? (
          <ArrowUp className="mr-1 size-3.5" />
        ) : (
          <Pin className="mr-1 size-3.5" />
        )}
        {copy.button}
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
            <AlertDialogTitle>{copy.title}</AlertDialogTitle>
            <AlertDialogDescription>{copy.subtitle}</AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-3 text-sm">
            {phase === "planning" && !plan && (
              <div className="flex flex-col items-center justify-center gap-2 py-10 text-muted-foreground">
                <Loader2 className="size-5 animate-spin" />
                <span className="text-xs">Checking every pack…</span>
              </div>
            )}

            {plan && (
              <>
                <div className="grid grid-cols-3 gap-2">
                  <CountTile
                    label={raiseOnly ? "Will raise" : "Will re-pin"}
                    value={plan.toReprice.length}
                    accent="emerald"
                  />
                  <CountTile label="On target" value={plan.unchanged.length} accent="muted" />
                  <CountTile label="Skipped" value={plan.skipped.length} accent="amber" />
                </div>

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
                  <div className="pt-1">
                    <StepUpField value={totp} onChange={setTotp} />
                  </div>
                ) : (
                  <p className="rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                    Nothing to do — every pack is already on target or can&apos;t be
                    brought into the band.
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
              {raiseOnly ? "Raise" : "Re-pin"} {total} pack{total === 1 ? "" : "s"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <RetuneProgressDialog
        open={progressOpen}
        running={phase === "running"}
        title={phase === "running" ? copy.running : "Re-pin complete"}
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
