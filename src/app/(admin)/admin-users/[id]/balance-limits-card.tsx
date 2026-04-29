"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Trash2, X, Wallet } from "lucide-react";
import { setAdminLimit, deleteAdminLimit } from "../limits-actions";
import type { limit_period_type } from "@/generated/admin-prisma/client";

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
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  // We rely on the server (via router.refresh) for the source of
  // truth — `initialLimits` is the canonical view. Optimistic local
  // state only existed previously to hide deleted rows; the refresh
  // below handles that without the risk of UI/DB drift.
  const limitMap = new Map(initialLimits.map((l) => [l.period_type, l]));

  function handleSet(periodType: limit_period_type, value: string) {
    const amount = parseFloat(value);
    if (Number.isNaN(amount) || amount <= 0) {
      toast.error("Enter a positive amount");
      return;
    }
    startTransition(async () => {
      const result = await setAdminLimit({
        adminUserId,
        periodType,
        maxAmount: amount,
      });
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success(
        `${PERIOD_LABELS[periodType]} limit set to $${amount.toFixed(2)}`,
      );
      router.refresh();
    });
  }

  function handleDelete(periodType: limit_period_type) {
    startTransition(async () => {
      const result = await deleteAdminLimit(adminUserId, periodType);
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success(`${PERIOD_LABELS[periodType]} limit removed`);
      router.refresh();
    });
  }

  const activeLimitsCount = initialLimits.length;

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
