"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Pencil } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCurrency } from "@/lib/utils/format";
import { updateCreatorLimits } from "../actions";

type Limits = {
  id: string;
  currencyLimitAmount: number;
  percentageLimit: number;
  tipLimit: number | null;
  currencyLimitResetDays: number | null;
} | null;

export function LimitsCard({
  userId,
  limits,
}: {
  userId: string;
  limits: Limits;
}) {
  const [editing, setEditing] = useState(false);
  const [currencyLimit, setCurrencyLimit] = useState(String(limits?.currencyLimitAmount ?? ""));
  const [percentageLimit, setPercentageLimit] = useState(String(limits?.percentageLimit ?? ""));
  const [tipLimit, setTipLimit] = useState(String(limits?.tipLimit ?? ""));
  const [resetDays, setResetDays] = useState(String(limits?.currencyLimitResetDays ?? ""));
  const [isPending, startTransition] = useTransition();

  function handleSave() {
    startTransition(async () => {
      try {
        await updateCreatorLimits(userId, {
          currencyLimitAmount: currencyLimit ? parseFloat(currencyLimit) : null,
          percentageLimit: percentageLimit ? parseFloat(percentageLimit) : null,
          tipLimit: tipLimit ? parseFloat(tipLimit) : null,
          currencyLimitResetDays: resetDays ? parseInt(resetDays, 10) : null,
        });
        toast.success("Limits updated");
        setEditing(false);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to update limits");
      }
    });
  }

  function handleCancel() {
    setCurrencyLimit(String(limits?.currencyLimitAmount ?? ""));
    setPercentageLimit(String(limits?.percentageLimit ?? ""));
    setTipLimit(String(limits?.tipLimit ?? ""));
    setResetDays(String(limits?.currencyLimitResetDays ?? ""));
    setEditing(false);
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-sm font-medium">Withdrawal Limits</CardTitle>
        {!editing && (
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
            <Pencil className="mr-1 size-3.5" />
            Edit
          </Button>
        )}
        {editing && (
          <div className="flex gap-1">
            <Button size="sm" onClick={handleSave} disabled={isPending}>
              {isPending ? "Saving..." : "Save"}
            </Button>
            <Button variant="ghost" size="sm" onClick={handleCancel} disabled={isPending}>
              Cancel
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {editing ? (
          <>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground w-36">Currency Limit:</span>
              <Input
                type="number"
                step="0.01"
                min="0"
                placeholder="No limit"
                value={currencyLimit}
                onChange={(e) => setCurrencyLimit(e.target.value)}
                className="w-[150px] h-7 text-sm"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground w-36">Percentage Limit:</span>
              <Input
                type="number"
                step="0.0001"
                min="0"
                max="1"
                placeholder="No limit"
                value={percentageLimit}
                onChange={(e) => setPercentageLimit(e.target.value)}
                className="w-[150px] h-7 text-sm"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground w-36">Tip Limit:</span>
              <Input
                type="number"
                step="0.01"
                min="0"
                placeholder="No limit"
                value={tipLimit}
                onChange={(e) => setTipLimit(e.target.value)}
                className="w-[150px] h-7 text-sm"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground w-36">Reset Days:</span>
              <Input
                type="number"
                min="1"
                placeholder="No reset"
                value={resetDays}
                onChange={(e) => setResetDays(e.target.value)}
                className="w-[150px] h-7 text-sm"
              />
            </div>
          </>
        ) : (
          <>
            <InfoRow label="Currency Limit">
              {limits?.currencyLimitAmount ? formatCurrency(limits.currencyLimitAmount) : "No limit"}
            </InfoRow>
            <InfoRow label="Percentage Limit">
              {limits?.percentageLimit ? `${(limits.percentageLimit * 100).toFixed(2)}%` : "No limit"}
            </InfoRow>
            <InfoRow label="Tip Limit">
              {limits?.tipLimit ? formatCurrency(limits.tipLimit) : "No limit"}
            </InfoRow>
            <InfoRow label="Reset Days">
              {limits?.currencyLimitResetDays ? `${limits.currencyLimitResetDays} days` : "No reset"}
            </InfoRow>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-muted-foreground">{label}:</span>
      <span className="text-sm">{children}</span>
    </div>
  );
}
