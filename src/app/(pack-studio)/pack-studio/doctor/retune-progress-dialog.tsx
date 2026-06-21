"use client";

import { Loader2 } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Shared stoppable progress dialog for the bulk Pack-Doctor write loops (bulk
 * re-tune + custom re-pin). Mirrors the global re-price tool's progress modal:
 * a non-dismissable bar while running, a per-pack "current" line, done/failed
 * tallies, an aborted-run banner, and a collapsible per-pack failure list.
 *
 * Pure presentation — the parent owns the loop, the stop ref, and the tallies;
 * this only renders them and emits `onStop` / `onClose`.
 */

export type RetuneFailure = { name: string; message: string };

export function RetuneProgressDialog({
  open,
  running,
  title,
  runningLabel,
  verb,
  processed,
  total,
  currentName,
  doneCount,
  failedCount,
  failures,
  fatalError,
  onStop,
  onClose,
}: {
  open: boolean;
  running: boolean;
  title: string;
  /** Description shown while running. */
  runningLabel: string;
  /** Past-tense verb for the done tile + done summary (e.g. "Re-tuned"). */
  verb: string;
  processed: number;
  total: number;
  currentName: string;
  doneCount: number;
  failedCount: number;
  failures: RetuneFailure[];
  fatalError: string | null;
  onStop: () => void;
  onClose: () => void;
}) {
  const progressPct = total > 0 ? Math.round((processed / total) * 100) : 100;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (running) return;
        if (!o) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md" showCloseButton={!running}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {running
              ? runningLabel
              : fatalError
                ? "The run was aborted. Packs processed before it stay written."
                : failures.length > 0
                  ? "Done — some packs failed and were skipped; the rest were written."
                  : "Done. Every selected pack was processed."}
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

          {running && currentName && (
            <p className="flex items-center gap-2 truncate text-sm">
              <Loader2 className="size-3.5 shrink-0 animate-spin" />
              <span className="truncate">{currentName}</span>
            </p>
          )}

          <div className="grid grid-cols-2 gap-2 pt-1">
            <CountTile label={verb} value={doneCount} accent="emerald" />
            <CountTile
              label="Failed"
              value={failedCount}
              accent={failedCount ? "rose" : "muted"}
            />
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
          {running ? (
            <Button variant="outline" onClick={onStop} className="w-full sm:w-auto">
              Stop after current
            </Button>
          ) : (
            <Button onClick={onClose} className="w-full sm:w-auto">
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CountTile({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent: "emerald" | "rose" | "muted";
}) {
  const tone =
    accent === "emerald"
      ? "text-emerald-600 dark:text-emerald-400"
      : accent === "rose"
        ? "text-rose-600 dark:text-rose-400"
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
