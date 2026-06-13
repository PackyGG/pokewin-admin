"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Target, TriangleAlert, Loader2, ArrowRight, ExternalLink } from "lucide-react";
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
  authorizeReprice,
  repricePackToTargetEdge,
  type RepricePlanSummary,
  type RepricePlanRow,
} from "./actions";

const CONFIRM_PHRASE = "REPRICE";
const TARGET_MIN_PCT = 1;
const TARGET_MAX_PCT = 50;

type Phase = "idle" | "planning" | "ready" | "running" | "done";

/** Render a house-edge fraction (0.1099) as "10.99%". */
function pct(edge: number | null): string {
  if (edge == null || !Number.isFinite(edge)) return "—";
  return `${(edge * 100).toFixed(2)}%`;
}

/**
 * Global "Re-price all active official packs → target edge" tool. Owner-only
 * (the page only mounts it for `motha`; the server actions independently
 * re-check, and the actual writes require a 2FA token).
 *
 * Flow: button → READ-ONLY dry-run preview (custom target %) → type-to-confirm
 * + 2FA code → `authorizeReprice` mints a run token → stoppable, pack-by-pack
 * progress loop that calls the guarded single-pack write once per pack.
 */
export function RepriceAllPacksButton() {
  const router = useRouter();

  const [phase, setPhase] = React.useState<Phase>("idle");
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [progressOpen, setProgressOpen] = React.useState(false);
  const [plan, setPlan] = React.useState<RepricePlanSummary | null>(null);
  /** Target fraction the current `plan` was computed for. */
  const [planTarget, setPlanTarget] = React.useState<number | null>(null);
  const [targetPct, setTargetPct] = React.useState("10.99");
  const [confirmText, setConfirmText] = React.useState("");
  const [totp, setTotp] = React.useState("");

  // Progress state.
  const [processed, setProcessed] = React.useState(0);
  const [currentName, setCurrentName] = React.useState("");
  const [tally, setTally] = React.useState({ repriced: 0, skipped: 0, failed: 0 });
  /** Per-pack failures collected during the run (the real, unmasked reasons). */
  const [failures, setFailures] = React.useState<{ name: string; message: string }[]>([]);
  /** Set only when the whole run aborts (auth/token problem). */
  const [fatalError, setFatalError] = React.useState<string | null>(null);
  const stopRef = React.useRef(false);

  const parsedTarget = parseFloat(targetPct);
  const targetFraction = Number.isFinite(parsedTarget) ? parsedTarget / 100 : NaN;
  const targetValid =
    Number.isFinite(parsedTarget) &&
    parsedTarget >= TARGET_MIN_PCT &&
    parsedTarget <= TARGET_MAX_PCT;
  const planStale =
    plan !== null &&
    planTarget !== null &&
    targetValid &&
    Math.abs(planTarget - targetFraction) > 1e-9;

  const total = plan?.toReprice.length ?? 0;
  const progressPct = total > 0 ? Math.round((processed / total) * 100) : 100;
  const totpValid = /^\d{6}$/.test(totp.trim());
  const confirmReady =
    phase === "ready" &&
    plan !== null &&
    !planStale &&
    total > 0 &&
    confirmText.trim().toUpperCase() === CONFIRM_PHRASE &&
    totpValid;

  function openConfirm() {
    setPlan(null);
    setPlanTarget(null);
    setConfirmText("");
    setTotp("");
    setTargetPct("10.99");
    setPhase("planning");
    setConfirmOpen(true);
    void loadPlan(0.1099);
  }

  async function loadPlan(fraction: number) {
    setPhase("planning");
    try {
      const p = await planRepriceAllPacks(fraction);
      setPlan(p);
      setPlanTarget(p.target);
      setPhase("ready");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to compute the re-price plan",
      );
      if (plan) {
        setPhase("ready");
      } else {
        setPhase("idle");
        setConfirmOpen(false);
      }
    }
  }

  function updatePreview() {
    if (!targetValid) {
      toast.error(`Target must be between ${TARGET_MIN_PCT}% and ${TARGET_MAX_PCT}%.`);
      return;
    }
    void loadPlan(targetFraction);
  }

  async function runReprice() {
    if (!plan || planTarget === null || total === 0) return;
    const rows = plan.toReprice;
    const runTarget = planTarget;

    // 2FA gate: verify the code ONCE and get a short-lived run token.
    let token: string;
    try {
      const res = await authorizeReprice(totp.trim());
      token = res.token;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "2FA verification failed");
      return;
    }

    stopRef.current = false;
    setProcessed(0);
    setCurrentName("");
    setTally({ repriced: 0, skipped: 0, failed: 0 });
    setFailures([]);
    setFatalError(null);
    setConfirmOpen(false);
    setProgressOpen(true);
    setPhase("running");

    let repriced = 0;
    let skipped = 0;
    let failed = 0;
    const fails: { name: string; message: string }[] = [];

    for (let i = 0; i < rows.length; i++) {
      if (stopRef.current) break;
      const row = rows[i];
      setCurrentName(row.name);
      try {
        const res = await repricePackToTargetEdge(row.packId, token, runTarget);
        if (res.status === "repriced") {
          repriced++;
        } else if (res.status === "failed") {
          // ONE pack failed — record its REAL reason and KEEP GOING so a single
          // bad pack can't block the rest of the batch.
          failed++;
          fails.push({ name: res.name || row.name, message: res.reason || "Write failed" });
          setFailures([...fails]);
        } else {
          skipped++; // unchanged / out-of-scope
        }
        setProcessed(i + 1);
        setTally({ repriced, skipped, failed });
      } catch (err) {
        // A THROWN error means auth / 2FA-token / target — abort the whole run.
        const message = err instanceof Error ? err.message : "Authorization failed";
        setProcessed(i);
        setTally({ repriced, skipped, failed });
        setFatalError(message);
        setCurrentName("");
        setPhase("done");
        toast.error(`Run aborted: ${message}`);
        router.refresh();
        return;
      }
    }

    setCurrentName("");
    setTally({ repriced, skipped, failed });
    setPhase("done");
    if (stopRef.current) {
      toast.message(
        `Stopped — re-priced ${repriced}${failed ? `, ${failed} failed` : ""}.`,
      );
    } else if (failed > 0) {
      toast.warning(`Re-priced ${repriced} · ${failed} failed — see details.`);
    } else {
      toast.success(
        `Re-priced ${repriced} pack${repriced === 1 ? "" : "s"} to ~${targetPct}%.`,
      );
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
    setPlanTarget(null);
    setConfirmText("");
    setTotp("");
    setProcessed(0);
    setCurrentName("");
    setTally({ repriced: 0, skipped: 0, failed: 0 });
    setFailures([]);
    setFatalError(null);
  }

  const isProd = plan?.dbEnv === "prod";

  return (
    <>
      <Button variant="outline" size="sm" onClick={openConfirm}>
        <Target className="mr-1 size-3.5" />
        Re-price packs
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
            <AlertDialogTitle>Re-price active official packs</AlertDialogTitle>
            <AlertDialogDescription>
              Active official packs only. Only the pack <strong>price</strong> changes —{" "}
              <strong>card odds are never touched</strong>. Review the plan, type{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono">{CONFIRM_PHRASE}</code>{" "}
              and your 2FA code to run. Each pack is written one at a time and the run is
              stoppable.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-3 text-sm">
            {/* Target % entry */}
            <div className="space-y-1.5">
              <Label htmlFor="reprice-target">Target house edge (%)</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="reprice-target"
                  type="number"
                  min={TARGET_MIN_PCT}
                  max={TARGET_MAX_PCT}
                  step="0.01"
                  value={targetPct}
                  onChange={(e) => setTargetPct(e.target.value)}
                  className="w-32"
                  aria-invalid={!targetValid}
                  disabled={phase === "planning"}
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={updatePreview}
                  disabled={
                    !targetValid || phase === "planning" || (!planStale && plan !== null)
                  }
                >
                  {phase === "planning" ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    "Update preview"
                  )}
                </Button>
              </div>
              {!targetValid && (
                <p className="text-xs text-rose-600 dark:text-rose-400">
                  Enter a target between {TARGET_MIN_PCT}% and {TARGET_MAX_PCT}%.
                </p>
              )}
              {planStale && targetValid && (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  Preview is for {planTarget != null ? pct(planTarget) : "—"} — click “Update
                  preview” to recompute for {parsedTarget}%.
                </p>
              )}
            </div>

            {phase === "planning" && !plan && (
              <div className="flex items-center justify-center gap-2 py-6 text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Computing the re-price plan…
              </div>
            )}

            {plan && (
              <>
                {/* DB-env banner */}
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

                <div className="grid grid-cols-3 gap-2">
                  <CountTile label="Will re-price" value={plan.counts.toReprice} accent="emerald" />
                  <CountTile label="Already on target" value={plan.counts.unchanged} accent="muted" />
                  <CountTile label="Skipped" value={plan.counts.skipped} accent="amber" />
                </div>

                <p className="text-xs text-muted-foreground">
                  Target {pct(plan.target)} · written only within {pct(plan.acceptMin)}–
                  {pct(plan.acceptMax)} · hard cap {pct(plan.hardMin)}–{pct(plan.hardMax)}.
                  Packs that can&apos;t hit it (cheap packs — 1¢ is too coarse a step) are
                  skipped.
                </p>

                {plan.toReprice.length > 0 && (
                  <div className="rounded-lg border">
                    <p className="border-b px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                      Largest price changes
                    </p>
                    <div className="max-h-40 overflow-y-auto">
                      {plan.toReprice.slice(0, 12).map((r) => (
                        <ChangeRow key={r.packId} row={r} />
                      ))}
                    </div>
                    {plan.toReprice.length > 12 && (
                      <p className="border-t px-3 py-1.5 text-[11px] text-muted-foreground">
                        +{plan.toReprice.length - 12} more will also be re-priced.
                      </p>
                    )}
                  </div>
                )}

                {plan.skipped.length > 0 && (
                  <details className="rounded-lg border">
                    <summary className="cursor-pointer px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                      {plan.skipped.length} skipped — why? (click to open a pack)
                    </summary>
                    <div className="max-h-44 overflow-y-auto border-t">
                      {plan.skipped.slice(0, 30).map((r) => (
                        <div
                          key={r.packId}
                          className="flex flex-col gap-0.5 border-b px-3 py-1.5 last:border-b-0"
                        >
                          <PackLink packId={r.packId} name={r.name} />
                          <span className="text-[11px] text-muted-foreground">{r.reason}</span>
                        </div>
                      ))}
                    </div>
                  </details>
                )}

                {total > 0 ? (
                  <div className="space-y-3 pt-1">
                    <div className="space-y-1.5">
                      <Label htmlFor="reprice-confirm">Type {CONFIRM_PHRASE} to confirm</Label>
                      <Input
                        id="reprice-confirm"
                        value={confirmText}
                        onChange={(e) => setConfirmText(e.target.value)}
                        placeholder={CONFIRM_PHRASE}
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="reprice-totp">2FA code</Label>
                      <Input
                        id="reprice-totp"
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
                    Nothing to re-price at {pct(plan.target)} — every active official pack is
                    already on target (or can&apos;t be brought into the band).
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
            <Button onClick={runReprice} disabled={!confirmReady} className="w-full sm:w-auto">
              Re-price {total} pack{total === 1 ? "" : "s"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Progress (non-dismissable while running) ────────────────── */}
      <Dialog
        open={progressOpen}
        onOpenChange={(o) => {
          if (phase === "running") return;
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
                : fatalError
                  ? "The run was aborted. Packs processed before it stay re-priced."
                  : failures.length > 0
                    ? "Done — some packs failed and were skipped; the rest were re-priced."
                    : "Done. Packs already on target were left untouched."}
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

            {fatalError && (
              <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-400">
                <span className="font-medium">Run aborted:</span> {fatalError}
              </div>
            )}

            {failures.length > 0 && (
              <div className="rounded-lg border border-rose-500/30">
                <p className="border-b border-rose-500/30 px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider text-rose-600 dark:text-rose-400">
                  {failures.length} failed
                </p>
                <div className="max-h-40 overflow-y-auto">
                  {failures.map((f, i) => (
                    <div key={i} className="border-b px-3 py-1.5 text-xs last:border-b-0">
                      <span className="font-medium">{f.name}:</span>{" "}
                      <span className="text-muted-foreground">{f.message}</span>
                    </div>
                  ))}
                </div>
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

/** Pack name as a link that opens the pack in a new tab (right-click friendly). */
function PackLink({ packId, name }: { packId: string; name: string }) {
  return (
    <a
      href={`/packs/${packId}`}
      target="_blank"
      rel="noreferrer"
      className="inline-flex min-w-0 items-center gap-1 truncate font-medium hover:underline"
    >
      <span className="truncate">{name}</span>
      <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
    </a>
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
      <PackLink packId={row.packId} name={row.name} />
      <span className="flex shrink-0 items-center gap-1.5 tabular-nums">
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
