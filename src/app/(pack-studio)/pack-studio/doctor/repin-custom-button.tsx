"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, ArrowRight, ArrowUp, ExternalLink } from "lucide-react";
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
 * "Raise price only to reach ≥ 10.99%" (owner-only). Cash packs drift below the
 * house edge floor as card prices move; this lifts every under-floor pack back
 * into the 10.99–11.50% band using the ONE lever the owner allows here — putting
 * the price UP. A pack already at or above the floor is left alone, never made
 * cheaper, and card odds are never touched.
 *
 *   1. `planCustomRepin(ids, "floor-raise-only")` — READ-ONLY dry-run.
 *   2. 2FA once (`authorizeReprice` mints a run token). No type-to-confirm —
 *      removed at the owner's request; the operator + token gates are unchanged.
 *   3. per-pack `repricePackToTargetEdge(id, token, "floor-raise-only")` in a
 *      stoppable progress loop — the write re-derives each price from FRESH DB
 *      truth and re-asserts both rules, never trusting the dry-run's number.
 *
 * The candidate ids are the packs the doctor snapshot scores UNDER the floor, so
 * the count on the button is exactly "packs earning under 10.99%" and falls as
 * the run lifts them.
 *
 * The sibling "re-pin to per-pack target edge" button was removed 2026-07-23
 * (owner: "we dont need it"), along with this component's mode switch.
 */

/** The edge FLOOR every pack is raised to at minimum. */
const FLOOR_TARGET_PCT = "10.99";
/** The edge CEILING a raise may never cross (the curve's cap). */
const CEILING_TARGET_PCT = "11.50";

type Phase = "idle" | "planning" | "ready" | "running" | "done";

function pct(edge: number | null): string {
  if (edge == null || !Number.isFinite(edge)) return "—";
  return `${(edge * 100).toFixed(2)}%`;
}

export function RepinCustomButton({
  candidateIds,
}: {
  /** Pack ids scored UNDER the edge floor in the current doctor snapshot. */
  candidateIds: string[];
}) {
  const router = useRouter();

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
  // Re-entrancy latch for `run()`. The confirm button is only gated on
  // `phase === "ready"`, and `run()` awaits `authorizeReprice` BEFORE anything
  // flips the phase or closes the dialog — so a second click landing inside
  // that window started a SECOND per-pack write loop over the same packs. A ref
  // (not state) because it must be true synchronously, inside the same click.
  const runningRef = React.useRef(false);

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
      const p = await planCustomRepin(candidateIds, "floor-raise-only");
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
    if (runningRef.current) return;
    runningRef.current = true;
    // Disable the confirm button for the whole 2FA round-trip too, not just
    // from the moment the loop starts.
    setPhase("running");
    const rows = plan.toReprice;
    // Re-pass the SAME target selector the dry-run used so the write plans each
    // pack identically — never the dry-run's number. The server re-reads fresh
    // price + pool per pack and re-asserts the raise-only + band rules.
    const runTarget = plan.target;

    let token: string;
    try {
      const res = await authorizeReprice(totp.trim());
      token = res.token;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "2FA verification failed.");
      // Nothing was written — hand the dialog back so the operator can retype
      // the code and retry.
      runningRef.current = false;
      setPhase("ready");
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
        runningRef.current = false;
        toast.error(`Run aborted: ${message}`);
        router.refresh();
        return;
      }
    }

    setCurrentName("");
    setTally({ done, failed });
    setPhase("done");
    runningRef.current = false;
    if (stopRef.current) {
      toast.message(`Stopped — re-priced ${done}${failed ? `, ${failed} failed` : ""}.`);
    } else if (failed > 0) {
      toast.warning(`Re-priced ${done} · ${failed} failed — see details.`);
    } else {
      toast.success(`Raised ${done} pack${done === 1 ? "" : "s"} into the ${FLOOR_TARGET_PCT}–${CEILING_TARGET_PCT}% band.`);
    }
    router.refresh();
  }

  function closeProgress() {
    runningRef.current = false;
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
        <ArrowUp className="mr-1 size-3.5" />
        Raise price to ≥ {FLOOR_TARGET_PCT}%
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
            <AlertDialogTitle>
              Raise price to {FLOOR_TARGET_PCT}–{CEILING_TARGET_PCT}%
            </AlertDialogTitle>
            <AlertDialogDescription>
              Price goes up only — card odds are never touched.
            </AlertDialogDescription>
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
                    label="Will raise"
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
                        +{plan.toReprice.length - 12} more will also be raised.
                      </p>
                    )}
                  </div>
                )}

                {/* WHY a pack was skipped. Without this the operator sees a bare
                    "7 skipped" and has no way to tell a coarse-1¢ pack from an
                    inactive one — the reasons are already on every row, so show
                    them rather than making the number a mystery. */}
                {plan.skipped.length > 0 && (
                  <div className="rounded-lg border">
                    <p className="border-b px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                      Skipped — why
                    </p>
                    <div className="max-h-32 overflow-y-auto">
                      {plan.skipped.map((r) => (
                        <div
                          key={r.packId}
                          className="border-b px-3 py-1.5 last:border-b-0"
                        >
                          <a
                            href={`/packs/${r.packId}`}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex min-w-0 items-center gap-1 truncate text-xs font-medium hover:underline"
                          >
                            <span className="truncate">{r.name}</span>
                            <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
                          </a>
                          <p className="text-[11px] text-muted-foreground">
                            {r.reason}
                          </p>
                        </div>
                      ))}
                    </div>
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
              Raise {total} pack{total === 1 ? "" : "s"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <RetuneProgressDialog
        open={progressOpen}
        running={phase === "running"}
        title={phase === "running" ? "Raising prices…" : "Done"}
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
