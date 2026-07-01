"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Pencil, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCurrency } from "@/lib/utils/format";
import { adjustRainBase } from "./actions";

export function InlineBaseCell({
  rainId,
  value,
  isActive,
}: {
  rainId: string;
  value: number;
  isActive: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [inputValue, setInputValue] = useState(String(value));
  // Optimistic display value — flips the instant the save resolves so the
  // cell shows the new base amount without a full-route router.refresh()
  // (which re-fetches every server component and dumps the admin's scroll
  // position). The server stays source of truth via the revalidateTag /
  // revalidatePath the action fires; the effect below re-syncs to a genuine
  // prop change (unless a save is mid-flight).
  const [displayValue, setDisplayValue] = useState(value);
  const [isPending, startTransition] = useTransition();

  // Re-sync to the server-truth prop when a real revalidation streams a new
  // value in — never while a save is in flight, so the stale pre-mutation
  // prop can't clobber the optimistic value we just set.
  useEffect(() => {
    if (isPending) return;
    setDisplayValue(value);
  }, [value, isPending]);

  function handleSave() {
    const num = parseFloat(inputValue);
    if (isNaN(num) || num < 0) {
      toast.error("Invalid amount");
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

  if (!isActive) {
    return <span>{formatCurrency(displayValue)}</span>;
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
        <Input
          type="number"
          step="0.01"
          min="0"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          className="w-[90px] h-7 text-sm"
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
          <Check className="size-3" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          onClick={handleCancel}
          disabled={isPending}
        >
          <X className="size-3" />
        </Button>
      </div>
    );
  }

  return (
    <span
      className="group inline-flex items-center gap-1 cursor-pointer"
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        setInputValue(String(displayValue));
        setEditing(true);
      }}
    >
      {formatCurrency(displayValue)}
      <Pencil className="size-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
    </span>
  );
}
