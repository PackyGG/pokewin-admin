"use client";

/**
 * Per-user withdrawal wager-requirement standing (read-only display) with
 * optional admin controls to adjust or clear the frozen debt counter.
 *
 * Sibling to `user-wager-requirement-card.tsx` (which manages the per-user
 * override CONFIG). This card shows the user's actual standing against the
 * FROZEN-RATE DEBT gate (backend rework 2026-06-14): a PARTIAL lock where the
 * locked debt (`balances.wager_requirement_remaining`) reserves that many
 * balance dollars and `withdrawable = max(0, available − locked)` is free to
 * leave. Sourced read-only from the backend-written `balances` columns (see
 * `getUserWagerProgress`).
 *
 * `data === null` → the frozen-debt column isn't on the connected DB (drift)
 * or the user has no balances row → render a muted "not available" state
 * instead of crashing the Account tab.
 *
 * House-POV finance colors (CLAUDE.md): the locked debt is user money we owe
 * but is gated → rose. Withdrawable-now / wagered-cleared are neutral state
 * info → blue. Nothing is framed green (no user-POV "available = good").
 */

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  Wallet,
  Gauge,
  Lock,
  Gem,
  AlertTriangle,
  Target,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
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
import { StatPanel, KpiTile } from "@/components/modern-panels";
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
      const result = await setUserWagerRemainingAction({ userId, amountUsd: "0" });
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
    shards,
    shardWagerProgress,
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
    <div className="space-y-3">
      {exempt ? (
        <div className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs font-medium text-amber-600 dark:text-amber-400">
          <AlertTriangle className="size-4 shrink-0" />
          User is EXEMPT (0× override) — no wager requirement gates their
          withdrawals.
        </div>
      ) : met ? (
        <div className="flex items-center gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-2.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
          <Lock className="size-4 shrink-0" />
          Requirement met — the full balance is free to withdraw (no locked
          debt remaining).
        </div>
      ) : null}

      {/* Top KPIs — withdrawable / cleared neutral (blue); locked debt rose. */}
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
        <KpiTile
          icon={Wallet}
          label="Withdrawable now"
          accent="blue"
          value={formatCurrency(withdrawableUsd)}
          sub={`of ${formatCurrency(availableBalanceUsd)} balance`}
        />
        <KpiTile
          icon={Lock}
          label="Locked behind wager"
          accent="rose"
          value={exempt ? "$0.00" : formatCurrency(remainingUsd)}
          sub={exempt ? "exempt" : "must be wagered off"}
        />
        <KpiTile
          icon={Gauge}
          label="Wagered cleared"
          accent="blue"
          value={formatCurrency(completedUsd)}
          sub="lifetime weighted"
        />
      </div>

      {/* Balance composition — withdrawable (blue) vs locked (rose) of the
          available balance. */}
      {!exempt && remainingUsd > 0 && (
        <div className="space-y-1">
          {hasBalance ? (
            <>
              <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-blue-500 motion-safe:transition-[width] motion-safe:duration-700"
                  style={{ width: `${withdrawablePct}%` }}
                />
                <div
                  className="h-full bg-rose-500 motion-safe:transition-[width] motion-safe:duration-700"
                  style={{ width: `${lockedPct}%` }}
                />
              </div>
              <p className="text-[11px] tabular-nums text-muted-foreground">
                {formatCurrency(withdrawableUsd)} withdrawable ·{" "}
                <span className="text-rose-600 dark:text-rose-400">
                  {formatCurrency(Math.min(remainingUsd, availableBalanceUsd))}{" "}
                  locked
                </span>
                {debtExceedsBalance && (
                  <>
                    {" "}
                    · debt {formatCurrency(remainingUsd)} exceeds the balance
                  </>
                )}
              </p>
            </>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              No withdrawable balance —{" "}
              <span className="text-rose-600 dark:text-rose-400">
                {formatCurrency(remainingUsd)}
              </span>{" "}
              still locked behind the wager requirement.
            </p>
          )}
        </div>
      )}

      {/* Per-source breakdown — informational: lifetime totals, current
          weights, and the still-unwagered (rose) balance per source. */}
      <StatPanel title="Per-source breakdown" icon={Target} accent="blue">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-[11px] uppercase tracking-wider text-muted-foreground">
                <th className="py-1.5 pr-2 text-left font-medium">Source</th>
                <th className="px-2 py-1.5 text-right font-medium">Lifetime</th>
                <th className="px-2 py-1.5 text-right font-medium">Weight</th>
                <th className="py-1.5 pl-2 text-right font-medium">Unwagered</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.key} className="border-b border-border/40 last:border-0">
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

        {/* Game weights + shards (informational). */}
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
          {gameWeights && (
            <span className="inline-flex items-center gap-1.5">
              <Gauge className="size-3.5" />
              Game weights — packs {formatX(gameWeights.packsBps)} · battles{" "}
              {formatX(gameWeights.battlesBps)} · upgrader{" "}
              {formatX(gameWeights.upgraderBps)}
            </span>
          )}
          {shards > 0 && (
            <span className="inline-flex items-center gap-1.5">
              <Gem className="size-3.5" />
              {shards.toLocaleString("en-US")} shards ·{" "}
              {shardWagerProgress.toLocaleString("en-US", {
                maximumFractionDigits: 2,
              })}{" "}
              shard-wager progress
            </span>
          )}
        </div>

        {/* How the gate works + honest note on the two locked counters. */}
        <p className="mt-3 border-t pt-2 text-[11px] leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground">How this works:</span>{" "}
          Withdrawals are gated by a frozen-rate debt — each deposit/bonus
          credit adds to it (at the rate in effect then), each real weighted
          wager burns it down.{" "}
          <span className="font-medium">Withdrawable now</span> = max(0,
          available balance − locked debt); the locked debt is read straight
          from <code className="font-mono">balances.wager_requirement_remaining</code>.
          The per-source <span className="font-medium">Unwagered</span> column
          is a separate counter (each bonus source&apos;s still-unspent funds) —
          it can differ from the locked debt, and the deposit part of the debt
          has no per-source row.
          {!backendAvailable &&
            " The wager-weight backend config wasn't reachable, so the per-source weights are hidden — the gate figures above are still exact (read from the balance columns)."}
        </p>
      </StatPanel>

      {/* Admin controls — only shown to admins (canManage). */}
      {canManage && (
        <div className="flex flex-wrap gap-2 pt-1">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setAdjustOpen(true)}
          >
            Adjust remaining debt
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={handleClearDebt}
            disabled={isPending}
          >
            {isPending ? "Working…" : "Clear debt"}
          </Button>
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
