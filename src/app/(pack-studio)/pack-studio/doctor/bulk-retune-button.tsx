"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { SlidersHorizontal, TriangleAlert } from "lucide-react";
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
  authorizePackRetune,
  applyPackRetune,
  type PackRetuneTargets,
} from "@/app/(admin)/packs/actions";
import {
  RetuneProgressDialog,
  type RetuneFailure,
} from "./retune-progress-dialog";

/**
 * Bulk "Re-tune selected" action (owner-only). Applies the SAME retune targets
 * (edge / win-rate / max-win cap / near-miss floor) across every selected pack
 * using the same stoppable, one-at-a-time progress loop as the global re-price
 * tool (`RepriceAllPacksButton`): type-to-confirm + 2FA once (`authorizePackRetune`
 * mints a run token), then per-pack `applyPackRetune` with live progress.
 *
 * Each pack is its own audited write; a single pack whose pool can't hit the
 * targets surfaces its REAL error and the run KEEPS GOING (one bad pack can't
 * block the rest). A thrown auth/token error aborts the whole run.
 */

const CONFIRM_PHRASE = "RETUNE";

type Phase = "idle" | "confirm" | "running" | "done";

function parsePct(raw: string): number | null {
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n / 100 : null;
}
function parseUsd(raw: string): number | null {
  const t = raw.trim();
  if (t === "") return null;
  const n = parseFloat(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function BulkRetuneButton({
  selected,
}: {
  /** The selected pack ids (+ display names) from the doctor grid. */
  selected: { packId: string; name: string }[];
}) {
  const router = useRouter();
  const [phase, setPhase] = React.useState<Phase>("idle");
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [progressOpen, setProgressOpen] = React.useState(false);

  const [targetEdgePct, setTargetEdgePct] = React.useState("10.99");
  const [targetWinRatePct, setTargetWinRatePct] = React.useState("20");
  const [maxWinCapUsd, setMaxWinCapUsd] = React.useState("");
  const [nearMissMinPct, setNearMissMinPct] = React.useState("10");
  const [confirmText, setConfirmText] = React.useState("");
  const [totp, setTotp] = React.useState("");

  // Progress.
  const [processed, setProcessed] = React.useState(0);
  const [currentName, setCurrentName] = React.useState("");
  const [tally, setTally] = React.useState({ done: 0, failed: 0 });
  const [failures, setFailures] = React.useState<RetuneFailure[]>([]);
  const [fatalError, setFatalError] = React.useState<string | null>(null);
  const stopRef = React.useRef(false);

  const count = selected.length;

  const targetEdge = parsePct(targetEdgePct);
  const targetWinRate = parsePct(targetWinRatePct);
  const maxWinCap = parseUsd(maxWinCapUsd);
  const nearMissMin = parsePct(nearMissMinPct);
  const targetsValid =
    targetEdge != null &&
    targetEdge > 0 &&
    targetEdge < 1 &&
    targetWinRate != null &&
    targetWinRate >= 0 &&
    targetWinRate < 1 &&
    (maxWinCapUsd.trim() === "" || maxWinCap != null) &&
    nearMissMin != null &&
    nearMissMin >= 0 &&
    nearMissMin < 1;

  const totpValid = /^\d{6}$/.test(totp.trim());
  const confirmReady =
    phase === "confirm" &&
    count > 0 &&
    targetsValid &&
    confirmText.trim().toUpperCase() === CONFIRM_PHRASE &&
    totpValid;

  function open() {
    setConfirmText("");
    setTotp("");
    setPhase("confirm");
    setConfirmOpen(true);
  }

  function buildTargets(): PackRetuneTargets {
    return {
      targetEdge: targetEdge ?? undefined,
      targetWinRate: targetWinRate!,
      maxWinCap: maxWinCap ?? undefined,
      nearMissMin: nearMissMin ?? undefined,
    };
  }

  async function run() {
    if (!confirmReady) return;
    const targets = buildTargets();

    let token: string;
    try {
      const res = await authorizePackRetune(totp.trim());
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

    for (let i = 0; i < selected.length; i++) {
      if (stopRef.current) break;
      const row = selected[i]!;
      setCurrentName(row.name);
      try {
        await applyPackRetune(row.packId, token, targets);
        done++;
        setProcessed(i + 1);
        setTally({ done, failed });
      } catch (err) {
        // applyPackRetune THROWS on any failure (auth OR a single pack's
        // infeasibility). Distinguish: an auth/token error must abort the run;
        // a per-pack infeasibility should record + continue.
        const message = err instanceof Error ? err.message : "Re-tune failed.";
        const isAuth =
          message.includes("authorization expired") ||
          message.includes("restricted to the owner") ||
          message.includes("Not authorized");
        if (isAuth) {
          setProcessed(i);
          setTally({ done, failed });
          setFatalError(message);
          setCurrentName("");
          setPhase("done");
          toast.error(`Run aborted: ${message}`);
          router.refresh();
          return;
        }
        failed++;
        fails.push({ name: row.name, message });
        setFailures([...fails]);
        setProcessed(i + 1);
        setTally({ done, failed });
      }
    }

    setCurrentName("");
    setTally({ done, failed });
    setPhase("done");
    if (stopRef.current) {
      toast.message(`Stopped — re-tuned ${done}${failed ? `, ${failed} failed` : ""}.`);
    } else if (failed > 0) {
      toast.warning(`Re-tuned ${done} · ${failed} failed — see details.`);
    } else {
      toast.success(`Re-tuned ${done} pack${done === 1 ? "" : "s"}.`);
    }
    router.refresh();
  }

  function closeProgress() {
    setProgressOpen(false);
    setPhase("idle");
    setProcessed(0);
    setCurrentName("");
    setTally({ done: 0, failed: 0 });
    setFailures([]);
    setFatalError(null);
  }

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={open}
        disabled={count === 0}
      >
        <SlidersHorizontal className="mr-1 size-3.5" />
        Re-tune selected{count > 0 ? ` (${count})` : ""}
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
            <AlertDialogTitle>Re-tune {count} selected pack{count === 1 ? "" : "s"}</AlertDialogTitle>
            <AlertDialogDescription>
              Rewrites the per-card <strong>odds</strong> of every selected pack to the
              SAME targets below. Each pack is written one at a time and the run is
              stoppable. Card values + prices are never touched. A pack whose pool
              can&apos;t hit the targets is skipped with its reason; the rest continue.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="grid grid-cols-2 gap-3 text-sm">
            <LeverInput id="brt-edge" label="Target edge (%)" value={targetEdgePct} onChange={setTargetEdgePct} invalid={targetEdge == null || targetEdge <= 0 || targetEdge >= 1} />
            <LeverInput id="brt-win" label="Target win-rate (%)" value={targetWinRatePct} onChange={setTargetWinRatePct} invalid={targetWinRate == null || targetWinRate < 0 || targetWinRate >= 1} />
            <LeverInput id="brt-cap" label="Max-win cap ($, optional)" value={maxWinCapUsd} onChange={setMaxWinCapUsd} invalid={maxWinCapUsd.trim() !== "" && maxWinCap == null} />
            <LeverInput id="brt-nm" label="Near-miss floor (%)" value={nearMissMinPct} onChange={setNearMissMinPct} invalid={nearMissMin == null || nearMissMin < 0 || nearMissMin >= 1} />

            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="brt-confirm">Type {CONFIRM_PHRASE} to confirm</Label>
              <Input
                id="brt-confirm"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={CONFIRM_PHRASE}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="brt-totp">2FA code</Label>
              <Input
                id="brt-totp"
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
              Re-tune {count} pack{count === 1 ? "" : "s"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <RetuneProgressDialog
        open={progressOpen}
        running={phase === "running"}
        title={phase === "running" ? "Re-tuning packs…" : "Re-tune complete"}
        runningLabel="Writing one pack at a time. You can stop after the current pack."
        verb="Re-tuned"
        processed={processed}
        total={count}
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

function LeverInput({
  id,
  label,
  value,
  onChange,
  invalid,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  invalid: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Input
        id={id}
        type="number"
        step="0.01"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={invalid}
        className="h-8"
      />
    </div>
  );
}
