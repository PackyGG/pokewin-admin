"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Pencil, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCurrency } from "@/lib/utils/format";
import { adjustRainBase } from "../actions";

function EditableAmount({
  label,
  value,
  rainId,
  isActive,
}: {
  label: string;
  value: number;
  rainId: string;
  isActive: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [inputValue, setInputValue] = useState(String(value));
  // Optimistic display value — flips the moment the save resolves so the
  // amount updates in place without a full-route router.refresh() (which
  // re-runs every server component and loses the admin's scroll position).
  // The server stays source of truth via the revalidateTag / revalidatePath
  // the action fires; the effect re-syncs to a genuine prop change unless a
  // save is mid-flight.
  const [displayValue, setDisplayValue] = useState(value);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (isPending) return;
    setDisplayValue(value);
  }, [value, isPending]);

  function handleSave() {
    const num = parseFloat(inputValue);
    if (isNaN(num) || num < 0) {
      toast.error("Please enter a valid amount");
      return;
    }
    // Optimistic flip — instant, no reload.
    const previous = displayValue;
    setDisplayValue(num);
    setEditing(false);
    startTransition(async () => {
      try {
        await adjustRainBase(rainId, num);
        toast.success("Base amount updated");
      } catch (e) {
        // Roll back to the last server-truth value and surface the error.
        setDisplayValue(previous);
        setInputValue(String(previous));
        toast.error(e instanceof Error ? e.message : "Failed to update");
      }
    });
  }

  function handleCancel() {
    setInputValue(String(displayValue));
    setEditing(false);
  }

  if (editing) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">{label}:</span>
        <Input
          type="number"
          step="0.01"
          min="0"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          className="w-[120px] h-7 text-sm"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSave();
            if (e.key === "Escape") handleCancel();
          }}
        />
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          onClick={handleSave}
          disabled={isPending}
        >
          <Check className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          onClick={handleCancel}
          disabled={isPending}
        >
          <X className="size-3.5" />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-muted-foreground">{label}:</span>
      <span className="text-sm">{formatCurrency(displayValue)}</span>
      {isActive && (
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          onClick={() => {
            setInputValue(String(displayValue));
            setEditing(true);
          }}
        >
          <Pencil className="size-3" />
        </Button>
      )}
    </div>
  );
}

export function RainDetailsCard({
  rainId,
  baseAmountUsd,
  isActive,
}: {
  rainId: string;
  baseAmountUsd: number;
  isActive: boolean;
}) {
  return (
    <EditableAmount
      label="Base Amount"
      value={baseAmountUsd}
      rainId={rainId}
      isActive={isActive}
    />
  );
}

