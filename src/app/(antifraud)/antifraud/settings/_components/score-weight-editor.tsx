"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, Pencil, X } from "lucide-react";
import { toast } from "sonner";
import { clientActionError } from "@/lib/errors/client-action-error";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { setAntifraudScoreWeight } from "../actions";

export function ScoreWeightEditor({
  weightKey,
  label,
  points,
}: {
  weightKey: string;
  label: string;
  points: number;
}) {
  const router = useRouter();
  const [editing, setEditing] = React.useState(false);
  const [value, setValue] = React.useState(String(points));
  const [saving, setSaving] = React.useState(false);

  if (!editing) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={cn(
          "h-7 gap-1.5 rounded-md px-2 text-[11px] font-medium tabular-nums",
          points < 0
            ? "border-emerald-500/25 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400"
            : "border-rose-500/25 bg-rose-500/5 text-rose-600 dark:text-rose-400",
        )}
        onClick={() => {
          setValue(String(points));
          setEditing(true);
        }}
      >
        {label}
        <span className="font-semibold">
          {points > 0 ? "+" : ""}
          {points}
        </span>
        <Pencil className="size-3" aria-hidden />
      </Button>
    );
  }

  return (
    <form
      className="flex items-center gap-1"
      onSubmit={async (event) => {
        event.preventDefault();
        const next = Number(value);
        if (!Number.isInteger(next) || next < -500 || next > 500) {
          toast.error("Use a whole number from -500 to 500");
          return;
        }
        setSaving(true);
        try {
          await setAntifraudScoreWeight({
            key: weightKey,
            points: next,
            idempotencyKey: crypto.randomUUID(),
          });
          toast.success(`${label} set to ${next > 0 ? "+" : ""}${next}`);
          setEditing(false);
          router.refresh();
        } catch (error) {
          toast.error(clientActionError(error, "Could not save"));
        } finally {
          setSaving(false);
        }
      }}
    >
      <span className="sr-only">{label}</span>
      <Input
        type="number"
        min={-500}
        max={500}
        step={1}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        className="h-7 w-20 font-mono text-xs"
        aria-label={`${label} points`}
        autoFocus
        disabled={saving}
      />
      <Button
        type="submit"
        size="icon-sm"
        variant="outline"
        aria-label={`Save ${label} points`}
        disabled={saving}
      >
        <Check className="size-3.5" />
      </Button>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label={`Cancel editing ${label}`}
        disabled={saving}
        onClick={() => setEditing(false)}
      >
        <X className="size-3.5" />
      </Button>
    </form>
  );
}
