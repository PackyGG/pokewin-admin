"use client";

/**
 * Per-user withdrawal wager-requirement standing (read-only display) with
 * optional admin controls to adjust or clear the frozen debt counter.
 *
 * This card shows the user's actual standing against the FROZEN-RATE DEBT
 * gate (backend rework 2026-06-14): a PARTIAL lock where the
 * locked debt (`balances.wager_requirement_remaining`) reserves that many
 * balance dollars and `withdrawable = max(0, available − locked)` is free to
 * leave. Sourced read-only from the backend-written `balances` columns (see
 * `getUserWagerProgress`).
 *
 * `data === null` → the frozen-debt column isn't on the connected DB (drift)
 * or the user has no balances row → render a muted "not available" state
 * instead of crashing the Account tab.
 *
 * House-POV finance colors: the locked debt is user money we owe but is gated
 * → rose. Withdrawable-now / wagered-cleared are neutral state info → blue.
 * Nothing is framed green (no user-POV "available = good").
 */

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Wallet, Gauge, Lock, AlertTriangle, Info } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { formatCurrency } from "@/lib/utils/format";
import {
  setUserWagerRemainingAction,
  refreshUserWagerProgressAction,
} from "./wager-requirement-actions";
import type { UserWagerProgress } from "@/lib/queries/users-wager-progress";

const BPS_PER_X = 10000;
const formatX = (bps: number): string =>
  `${(bps / BPS_PER_X).toLocaleString("en-US", { maximumFractionDigits: 2 })}×`;

export function UserWagerProgressCard({
  userId,
  data,
  canManage,
}: {
  userId: string;
  data: UserWagerProgress | null;
  canManage: boolean;
}) {
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  // Locally-tracked standing. Seeded from the `data` prop and updated via a
  // SCOPED re-fetch after a debt mutation — NOT a `router.refresh()` (which
  // re-suspends the page and loses scroll). The gate figures (withdrawable /
  // locked / per-source unwagered) are recomputed server-side, so we re-read
  // them exactly rather than fabricating an optimistic value. Re-synced to the
  // prop whenever the narrow `users-detail-${userId}` revalidation or the 60s
  // AutoRefresh streams a fresh value in (never while a mutation is in flight).
  const [localData, setLocalData] = useState<UserWagerProgress | null>(data);
  useEffect(() => {
    if (isPending) return;
    setLocalData(data);
  }, [data, isPending]);

  const handleClearDebt = () => {
    startTransition(async () => {
      const result = await setUserWagerRemainingAction({
        userId,
        amountUsd: "0",
      });
      if (result.success) {
        // Re-read the recomputed standing in place — no full-route refresh.
        const fresh = await refreshUserWagerProgressAction(userId);
        setLocalData(fresh);
        toast.success("Wager debt cleared — user can withdraw immediately");
      } else {
        toast.error(result.error);
      }
    });
  };

  if (!localData) {
    return (
      <Card className="border-dashed">
        <CardContent>
          <div className="flex items-start gap-3 rounded-md border border-muted-foreground/30 bg-muted/40 p-3 text-xs text-muted-foreground">
            <AlertTriangle className="size-4 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-medium text-foreground">
                Wager standing not available
              </p>
              <p>
                This user has no balance record, or the connected database
                doesn&apos;t carry the sweepstakes wager-requirement column. No
                withdrawal gate can be shown.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  const {
    completedUsd,
    remainingUsd,
    withdrawableUsd,
    availableBalanceUsd,
    exempt,
    met,
    sources,
    totalLockedUsd,
    gameWeights,
    backendAvailable,
  } = localData;

  // Balance composition: of the available balance, how much is free to
  // withdraw vs reserved behind the locked debt. Only meaningful when there is
  // a balance to split.
  const hasBalance = availableBalanceUsd > 0;
  const lockedPct = hasBalance
    ? Math.min(100, (remainingUsd / availableBalanceUsd) * 100)
    : 0;
  const withdrawablePct = Math.max(0, 100 - lockedPct);
  const debtExceedsBalance = remainingUsd > availableBalanceUsd + 0.005;

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-xl border bg-card">
        <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Withdrawal access
              </span>
              <Badge
                variant="outline"
                className={
                  exempt
                    ? "border-amber-500/30 text-amber-600 dark:text-amber-400"
                    : met
                      ? "border-blue-500/30 text-blue-600 dark:text-blue-400"
                      : "border-rose-500/30 text-rose-600 dark:text-rose-400"
                }
              >
                {exempt ? "Exempt" : met ? "Requirement met" : "Wager required"}
              </Badge>
            </div>
            <p className="mt-2 text-2xl font-bold tabular-nums tracking-tight sm:text-3xl">
              {formatCurrency(withdrawableUsd)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              available to withdraw from a {formatCurrency(availableBalanceUsd)}{" "}
              balance
            </p>
          </div>
          {!exempt && remainingUsd > 0 && (
            <div className="shrink-0 sm:text-right">
              <p className="text-xs font-medium text-muted-foreground">
                Still gated
              </p>
              <p className="mt-1 text-xl font-semibold tabular-nums text-rose-600 dark:text-rose-400">
                {formatCurrency(remainingUsd)}
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                weighted wager needed to unlock
              </p>
            </div>
          )}
        </div>

        <div className="border-t bg-muted/20 p-4">
          <div className="mb-2 flex items-center justify-between gap-3 text-[11px]">
            <span className="font-medium text-muted-foreground">
              Current balance access
            </span>
            <span className="tabular-nums text-muted-foreground">
              {Math.round(withdrawablePct)}% withdrawable
            </span>
          </div>
          {hasBalance ? (
            <>
              <div
                className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted"
                aria-label={`${Math.round(withdrawablePct)}% of the current balance is withdrawable`}
              >
                <div
                  className="h-full bg-blue-500 motion-safe:transition-[width] motion-safe:duration-700"
                  style={{ width: `${withdrawablePct}%` }}
                />
                <div
                  className="h-full bg-rose-500 motion-safe:transition-[width] motion-safe:duration-700"
                  style={{ width: `${lockedPct}%` }}
                />
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] tabular-nums">
                <span className="inline-flex items-center gap-1.5 text-blue-600 dark:text-blue-400">
                  <span className="size-1.5 rounded-full bg-blue-500" />
                  {formatCurrency(withdrawableUsd)} withdrawable
                </span>
                <span className="inline-flex items-center gap-1.5 text-rose-600 dark:text-rose-400">
                  <span className="size-1.5 rounded-full bg-rose-500" />
                  {formatCurrency(
                    Math.min(remainingUsd, availableBalanceUsd),
                  )}{" "}
                  locked
                </span>
                {debtExceedsBalance && (
                  <span className="text-muted-foreground">
                    Debt exceeds balance by{" "}
                    {formatCurrency(remainingUsd - availableBalanceUsd)}
                  </span>
                )}
              </div>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              There is no current balance to withdraw
              {remainingUsd > 0
                ? `; ${formatCurrency(remainingUsd)} of wager debt remains.`
                : "."}
            </p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 overflow-hidden rounded-xl border bg-card sm:grid-cols-3">
        <CompactMetric
          icon={Wallet}
          label="Available balance"
          value={formatCurrency(availableBalanceUsd)}
        />
        <CompactMetric
          icon={Lock}
          label="Wager debt"
          value={exempt ? "$0.00" : formatCurrency(remainingUsd)}
          tone="rose"
          className="border-l"
        />
        <CompactMetric
          icon={Gauge}
          label="Lifetime weighted wager"
          value={formatCurrency(completedUsd)}
          className="col-span-2 border-t sm:col-span-1 sm:border-l sm:border-t-0"
        />
      </div>

      <div className="rounded-xl border bg-card p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold">Source detail</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Lifetime funding and separate bonus-source counters. These do not
              add up to the wager debt above.
            </p>
          </div>
        </div>

        <div className="mt-3 hidden overflow-x-auto sm:block">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-[11px] uppercase tracking-wider text-muted-foreground">
                <th className="py-1.5 pr-2 text-left font-medium">Source</th>
                <th className="px-2 py-1.5 text-right font-medium">Lifetime</th>
                <th className="px-2 py-1.5 text-right font-medium">Weight</th>
                <th className="py-1.5 pl-2 text-right font-medium">
                  Unwagered
                </th>
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => (
                <tr
                  key={s.key}
                  className="border-b border-border/40 last:border-0"
                >
                  <td className="py-1.5 pr-2 text-left">{s.label}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {formatCurrency(s.lifetimeTotalUsd)}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                    {s.requirementBps != null ? formatX(s.requirementBps) : "—"}
                  </td>
                  <td className="py-1.5 pl-2 text-right tabular-nums">
                    {s.lockedUsd > 0 ? (
                      <span className="text-rose-600 dark:text-rose-400">
                        {formatCurrency(s.lockedUsd)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t font-medium">
                <td className="py-1.5 pr-2 text-left">Total unwagered</td>
                <td className="px-2 py-1.5 text-right tabular-nums">—</td>
                <td className="px-2 py-1.5 text-right" />
                <td className="py-1.5 pl-2 text-right tabular-nums">
                  {totalLockedUsd > 0 ? (
                    <span className="text-rose-600 dark:text-rose-400">
                      {formatCurrency(totalLockedUsd)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        <div className="mt-3 divide-y rounded-lg border sm:hidden">
          {sources.map((source) => (
            <div key={source.key} className="space-y-2 p-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium">{source.label}</span>
                <span className="text-sm font-semibold tabular-nums">
                  {formatCurrency(source.lifetimeTotalUsd)}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                <span>
                  Current weight{" "}
                  {source.requirementBps != null
                    ? formatX(source.requirementBps)
                    : "—"}
                </span>
                <span
                  className={
                    source.lockedUsd > 0
                      ? "tabular-nums text-rose-600 dark:text-rose-400"
                      : "tabular-nums"
                  }
                >
                  {source.lockedUsd > 0
                    ? `${formatCurrency(source.lockedUsd)} unwagered`
                    : "No source funds locked"}
                </span>
              </div>
            </div>
          ))}
        </div>

        {gameWeights && (
          <div className="mt-4 border-t pt-3">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Current game weights
            </p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <WeightCell label="Packs" value={formatX(gameWeights.packsBps)} />
              <WeightCell
                label="Battles"
                value={formatX(gameWeights.battlesBps)}
              />
              <WeightCell
                label="Upgrader"
                value={formatX(gameWeights.upgraderBps)}
              />
              <WeightCell label="Keno" value={formatX(gameWeights.kenoBps)} />
            </div>
          </div>
        )}

        <details className="group mt-4 border-t pt-3 text-xs text-muted-foreground">
          <summary className="flex cursor-pointer list-none items-center gap-2 font-medium text-foreground">
            <Info className="size-3.5" /> How this is calculated
          </summary>
          <p className="mt-2 max-w-4xl leading-relaxed">
            Credits add debt at the wager rate active when they were issued, and
            real weighted wagers reduce it. Withdrawable balance is the
            available balance minus remaining debt. Source-level unwagered funds
            are separate counters and can differ from this withdrawal gate.
            {!backendAvailable &&
              " Current weight settings are unavailable, but the balance and debt figures remain exact."}
          </p>
        </details>
      </div>

      {/* Admin controls — only shown to admins (canManage). */}
      {canManage && (
        <div className="flex flex-wrap justify-end gap-2 border-t pt-4">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setAdjustOpen(true)}
          >
            Adjust remaining debt
          </Button>
          {remainingUsd > 0 && (
            <Button
              size="sm"
              variant="ghost"
              onClick={handleClearDebt}
              disabled={isPending}
            >
              {isPending ? "Working…" : "Clear debt"}
            </Button>
          )}
        </div>
      )}

      <AdjustRemainingDialog
        userId={userId}
        currentRemainingUsd={remainingUsd}
        open={adjustOpen}
        onOpenChange={setAdjustOpen}
        onSaved={setLocalData}
      />
    </div>
  );
}

function CompactMetric({
  icon: Icon,
  label,
  value,
  tone = "blue",
  className = "",
}: {
  icon: typeof Wallet;
  label: string;
  value: string;
  tone?: "blue" | "rose";
  className?: string;
}) {
  return (
    <div className={`min-w-0 p-3.5 ${className}`}>
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        <Icon
          className={`size-3.5 ${tone === "rose" ? "text-rose-500" : "text-blue-500"}`}
        />{" "}
        {label}
      </div>
      <p
        className={`mt-1.5 truncate text-base font-semibold tabular-nums ${tone === "rose" ? "text-rose-600 dark:text-rose-400" : ""}`}
      >
        {value}
      </p>
    </div>
  );
}

function WeightCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-muted/20 px-3 py-2">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="mt-0.5 text-sm font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function AdjustRemainingDialog({
  userId,
  currentRemainingUsd,
  open,
  onOpenChange,
  onSaved,
}: {
  userId: string;
  currentRemainingUsd: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Push the recomputed standing up after a save so the parent card refreshes
  // in place — no `router.refresh()`. The dialog re-reads it server-side (the
  // gate figures are recomputed) via `refreshUserWagerProgressAction`.
  onSaved: (next: UserWagerProgress | null) => void;
}) {
  const [value, setValue] = useState(
    currentRemainingUsd > 0 ? currentRemainingUsd.toFixed(2) : "",
  );
  const [isPending, startTransition] = useTransition();

  // Reset the form whenever the dialog re-opens so a previous cancel
  // doesn't leave stale input.
  useEffect(() => {
    if (open) {
      setValue(currentRemainingUsd > 0 ? currentRemainingUsd.toFixed(2) : "");
    }
  }, [open, currentRemainingUsd]);

  const handleSave = () => {
    const trimmed = value.trim();
    if (trimmed === "") {
      toast.error("Enter an amount (0 to clear the debt entirely)");
      return;
    }
    const num = Number(trimmed);
    if (!Number.isFinite(num) || num < 0) {
      toast.error("Amount must be a non-negative number");
      return;
    }

    startTransition(async () => {
      const result = await setUserWagerRemainingAction({
        userId,
        amountUsd: num.toFixed(2),
      });
      if (result.success) {
        // Re-read the recomputed standing and hand it to the parent — the card
        // updates in place instead of a full-route refresh (no scroll jump).
        const fresh = await refreshUserWagerProgressAction(userId);
        onSaved(fresh);
        toast.success("Wager remaining debt updated");
        onOpenChange(false);
      } else {
        toast.error(result.error);
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Adjust Wager Remaining</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              New remaining debt (USD)
            </Label>
            <Input
              type="number"
              step="0.01"
              min="0"
              placeholder="e.g. 0 to clear debt entirely"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
            <p className="text-[11px] text-muted-foreground">
              Sets the exact wager-remaining debt for this user.{" "}
              <code className="font-mono">0</code> = user can withdraw
              immediately.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={isPending}>
            {isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
