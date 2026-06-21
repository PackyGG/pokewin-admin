"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatCurrency, formatRelative } from "@/lib/utils/format";
import { getUserDeposits, type UserDepositRow } from "./actions";

const QUICK_PERCENTS = [3, 5, 10] as const;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * OPTIONAL deposit-bonus calculator for the Adjust Balance dialog
 * (`deposit_bonus` category). Lets the admin multi-select the user's
 * deposits and apply a % (3 / 5 / custom) to auto-fill the bonus amount —
 * or ignore it entirely and just type an amount. Calls `onCompute` with the
 * computed amount + a descriptive reason whenever the selection/% changes
 * to a valid figure; calls `onClear` when the calculation is emptied so the
 * parent can stop forcing the computed amount.
 */
export function DepositBonusCalculator({
  userId,
  onCompute,
  onClear,
}: {
  userId: string;
  onCompute: (amount: number, reason: string) => void;
  onClear: () => void;
}) {
  const [deposits, setDeposits] = useState<UserDepositRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [percent, setPercent] = useState("");
  // Keep the latest callbacks without making them effect deps (avoids loops
  // when the parent re-renders after we set the amount).
  const onComputeRef = useRef(onCompute);
  const onClearRef = useRef(onClear);
  onComputeRef.current = onCompute;
  onClearRef.current = onClear;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getUserDeposits(userId)
      .then((rows) => {
        if (!cancelled) setDeposits(rows);
      })
      .catch(() => {
        if (!cancelled) setDeposits([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const selectedDeposits = (deposits ?? []).filter((d) => selected.has(d.id));
  const selectedSum = selectedDeposits.reduce((a, d) => a + d.amount, 0);
  // Bonus already credited for the selected deposits (cap-aware). The live
  // system pays 5% but caps at $20/6h, so a whale's deposit may already have a
  // partial bonus — a top-up must subtract it so we don't double-pay.
  const bonusAlreadyPaid = round2(
    selectedDeposits.reduce((a, d) => a + d.bonusPaid, 0),
  );
  const pct = Number(percent);
  const validPct = percent.trim() !== "" && Number.isFinite(pct) && pct > 0;
  const gross =
    selectedSum > 0 && validPct ? round2(selectedSum * (pct / 100)) : 0;
  const computed =
    selectedSum > 0 && validPct
      ? Math.max(0, round2(gross - bonusAlreadyPaid))
      : 0;

  // Push the computed amount up whenever it changes to a valid figure, and
  // clear when it goes back to zero.
  useEffect(() => {
    if (computed > 0) {
      const n = selected.size;
      const reason =
        bonusAlreadyPaid > 0
          ? `Deposit bonus top-up: ${pct}% of ${formatCurrency(selectedSum)} = ${formatCurrency(gross)} − ${formatCurrency(bonusAlreadyPaid)} already paid (${n} deposit${n !== 1 ? "s" : ""})`
          : `Deposit bonus: ${pct}% of ${formatCurrency(selectedSum)} (${n} deposit${n !== 1 ? "s" : ""})`;
      onComputeRef.current(computed, reason);
    } else {
      onClearRef.current();
    }
  }, [computed, gross, pct, selectedSum, bonusAlreadyPaid, selected.size]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="space-y-2 rounded-md border border-dashed bg-muted/20 p-2.5">
      <Label className="text-xs text-muted-foreground">
        Calculate from deposits (optional)
      </Label>

      {loading ? (
        <div className="flex items-center justify-center py-3">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        </div>
      ) : !deposits || deposits.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">
          No completed deposits to calculate from — enter an amount manually.
        </p>
      ) : (
        <>
          <div className="max-h-40 space-y-1 overflow-y-auto pr-1">
            {deposits.map((d) => (
              <label
                key={d.id}
                className="flex cursor-pointer items-center justify-between gap-2 rounded px-1.5 py-1 text-xs hover:bg-muted"
              >
                <span className="flex items-center gap-2">
                  <Checkbox
                    checked={selected.has(d.id)}
                    onCheckedChange={() => toggle(d.id)}
                  />
                  <span className="text-muted-foreground">
                    {formatRelative(d.createdAt)}
                  </span>
                </span>
                <span className="flex items-baseline gap-1.5 font-medium tabular-nums">
                  {d.bonusPaid > 0 && (
                    <span className="text-[10px] font-normal text-muted-foreground">
                      · bonus {formatCurrency(d.bonusPaid)}
                    </span>
                  )}
                  {formatCurrency(d.amount)}
                </span>
              </label>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            <span className="text-[11px] text-muted-foreground">Rate:</span>
            {QUICK_PERCENTS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPercent(String(p))}
                className={`rounded-md border px-2 py-0.5 text-xs font-medium transition-colors ${
                  percent === String(p)
                    ? "border-primary bg-primary/15 text-primary"
                    : "border-border text-muted-foreground hover:bg-muted"
                }`}
              >
                {p}%
              </button>
            ))}
            <div className="relative">
              <Input
                type="text"
                inputMode="decimal"
                placeholder="Custom %"
                value={percent}
                onChange={(e) =>
                  setPercent(e.target.value.replace(/[^0-9.]/g, ""))
                }
                className="h-7 w-24 pr-5 text-xs"
              />
              <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground">
                %
              </span>
            </div>
          </div>

          <div className="space-y-0.5 border-t pt-1 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">
                {selected.size} selected · {formatCurrency(selectedSum)}
              </span>
              <span className="font-semibold tabular-nums">
                Bonus: {formatCurrency(computed)}
              </span>
            </div>
            {bonusAlreadyPaid > 0 && (
              <div className="flex items-center justify-end gap-1 text-[10px] tabular-nums text-muted-foreground">
                <span>{formatCurrency(gross)} gross</span>
                <span>−</span>
                <span>{formatCurrency(bonusAlreadyPaid)} already paid</span>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
