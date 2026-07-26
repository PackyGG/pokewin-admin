"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Trash2, X, Wallet } from "lucide-react";
import { Spinner } from "@/components/ux";
import { setAdminLimit, deleteAdminLimit } from "../limits-actions";
import type { limit_period_type } from "@/lib/balance-limits";

export type BalanceLimit = {
  id: string;
  admin_user_id: string;
  period_type: limit_period_type;
  max_amount: number;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
};

/* ── Balance Limits Card ── */
const PERIOD_TYPES: limit_period_type[] = ["daily", "weekly", "monthly"];
const PERIOD_LABELS: Record<limit_period_type, string> = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
};

export function BalanceLimitsCard({
  adminUserId,
  initialLimits,
}: {
  adminUserId: string;
  initialLimits: BalanceLimit[];
}) {
  const [isPending, startTransition] = useTransition();

  // Optimistic, no-reload source of truth for THIS card. Setting or clearing a
  // per-period cap only affects this card's own three rows, so we mirror the
  // amounts in local state and update them in place on a successful action —
  // no `router.refresh()` (which would re-run every server component on the
  // detail page, replay FadeIn, and jump the scroll). The action still fires a
  // server-side `revalidatePath` so the next real navigation is fresh; the
  // effect below re-syncs to `initialLimits` when a genuine revalidation
  // streams a new prop in (unless an edit is mid-flight).
  const [limits, setLimits] = useState<BalanceLimit[]>(initialLimits);

  useEffect(() => {
    if (isPending) return;
    setLimits(initialLimits);
  }, [initialLimits, isPending]);

  const limitMap = new Map(limits.map((l) => [l.period_type, l]));

  function handleSet(periodType: limit_period_type, value: string) {
    const amount = parseFloat(value);
    if (Number.isNaN(amount) || amount <= 0) {
      toast.error("Enter a positive amount");
      return;
    }
    // Snapshot for rollback if the action fails.
    const previous = limits;
    // Optimistic upsert of this period's amount — instant, no reload.
    setLimits((prev) => {
      const now = new Date().toISOString();
      const idx = prev.findIndex((l) => l.period_type === periodType);
      if (idx === -1) {
        return [
          ...prev,
          {
            id: `optimistic-${periodType}`,
            admin_user_id: adminUserId,
            period_type: periodType,
            max_amount: amount,
            created_at: now,
            updated_at: now,
            created_by: null,
            updated_by: null,
          },
        ];
      }
      const next = [...prev];
      next[idx] = { ...next[idx], max_amount: amount, updated_at: now };
      return next;
    });
    startTransition(async () => {
      const result = await setAdminLimit({
        adminUserId,
        periodType,
        maxAmount: amount,
      });
      if (!result.success) {
        setLimits(previous);
        toast.error(result.error);
        return;
      }
      toast.success(
        `${PERIOD_LABELS[periodType]} limit set to $${amount.toFixed(2)}`,
      );
    });
  }

  function handleDelete(periodType: limit_period_type) {
    const previous = limits;
    // Optimistic removal — instant, no reload.
    setLimits((prev) => prev.filter((l) => l.period_type !== periodType));
    startTransition(async () => {
      const result = await deleteAdminLimit(adminUserId, periodType);
      if (!result.success) {
        setLimits(previous);
        toast.error(result.error);
        return;
      }
      toast.success(`${PERIOD_LABELS[periodType]} limit removed`);
    });
  }

  const activeLimitsCount = limits.length;

  return (
    <Card id="balance-limits" className="scroll-mt-24">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Wallet className="size-4 text-muted-foreground" />
          Adjust Balance Limit
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Caps how much this admin can adjust user balances within each
          period. {activeLimitsCount === 0 ? "Currently unlimited." : null}
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {PERIOD_TYPES.map((period) => {
          const existing = limitMap.get(period);
          return (
            <LimitRow
              key={period}
              label={PERIOD_LABELS[period]}
              currentAmount={existing ? Number(existing.max_amount) : null}
              disabled={isPending}
              onSet={(value) => handleSet(period, value)}
              onDelete={() => handleDelete(period)}
            />
          );
        })}
      </CardContent>
    </Card>
  );
}

export function LimitRow({
  label,
  currentAmount,
  disabled,
  onSet,
  onDelete,
}: {
  label: string;
  currentAmount: number | null;
  disabled: boolean;
  onSet: (value: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(currentAmount != null ? String(currentAmount) : "");

  if (!editing && currentAmount != null) {
    return (
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">{label}</span>
        <div className="flex items-center gap-1.5">
          <span
            role="button"
            tabIndex={0}
            className="text-sm font-medium cursor-pointer hover:underline"
            onClick={() => { setValue(String(currentAmount)); setEditing(true); }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setValue(String(currentAmount));
                setEditing(true);
              }
            }}
          >
            ${currentAmount.toFixed(2)}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-destructive hover:text-destructive"
            disabled={disabled}
            onClick={onDelete}
          >
            <Trash2 className="size-3" />
          </Button>
        </div>
      </div>
    );
  }

  if (!editing) {
    return (
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">{label}</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-xs"
          onClick={() => setEditing(true)}
        >
          Set limit
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-sm text-muted-foreground">{label}</span>
      <div className="flex items-center gap-1">
        <span className="text-sm text-muted-foreground">$</span>
        <Input
          type="number"
          className="h-7 w-24 text-sm"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          min={0}
          step={0.01}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              onSet(value);
              setEditing(false);
            }
            if (e.key === "Escape") setEditing(false);
          }}
        />
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          disabled={disabled || !value || parseFloat(value) <= 0}
          onClick={() => { onSet(value); setEditing(false); }}
        >
          {disabled && <Spinner size={12} className="text-current" />}
          Save
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          onClick={() => setEditing(false)}
        >
          <X className="size-3" />
        </Button>
      </div>
    </div>
  );
}
