"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
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
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function handleSave() {
    const num = parseFloat(inputValue);
    if (isNaN(num) || num < 0) {
      toast.error("Invalid amount");
      return;
    }
    startTransition(async () => {
      try {
        await adjustRainBase(rainId, num);
        toast.success("Base amount updated");
        setEditing(false);
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to update");
      }
    });
  }

  function handleCancel() {
    setInputValue(String(value));
    setEditing(false);
  }

  if (!isActive) {
    return <span>{formatCurrency(value)}</span>;
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
        setEditing(true);
      }}
    >
      {formatCurrency(value)}
      <Pencil className="size-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
    </span>
  );
}
