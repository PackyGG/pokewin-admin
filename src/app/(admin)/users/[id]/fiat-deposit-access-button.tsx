"use client";

import { useEffect, useState, useTransition } from "react";
import { BadgeDollarSign } from "lucide-react";
import { toast } from "sonner";

import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  getFiatDepositAccessAction,
  updateFiatDepositAccessAction,
} from "./fiat-deposit-access-actions";

export function FiatDepositAccessButton({ userId }: { userId: string }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    let active = true;
    void getFiatDepositAccessAction(userId).then((result) => {
      if (!active) return;
      if (result.success) {
        setEnabled(result.data.enabled);
        setLoadError(null);
      } else {
        setLoadError(result.error);
      }
    });
    return () => {
      active = false;
    };
  }, [userId]);

  const update = (nextEnabled: boolean) => {
    const previousEnabled = enabled;
    setEnabled(nextEnabled);

    startTransition(async () => {
      const result = await updateFiatDepositAccessAction(userId, nextEnabled);
      if (result.success) {
        setEnabled(result.data.enabled);
        setLoadError(null);
        toast.success(
          result.data.enabled
            ? "Fiat deposits enabled"
            : "Fiat deposits disabled",
        );
      } else {
        setEnabled(previousEnabled);
        toast.error(result.error);
      }
    });
  };

  return (
    <div
      className={cn(
        "flex h-8 items-center gap-2 rounded-md border px-2.5 text-xs font-medium",
        enabled === true &&
          "border-emerald-500/40 text-emerald-600 dark:text-emerald-400",
        enabled === false &&
          "border-rose-500/40 text-rose-600 dark:text-rose-400",
        enabled === null && "text-muted-foreground",
      )}
      title={loadError ?? undefined}
    >
      <span className="flex items-center gap-1.5">
        <BadgeDollarSign className="size-3.5" />
        {enabled === null
          ? loadError
            ? "Fiat unavailable"
            : "Fiat loading"
          : `Fiat ${enabled ? "on" : "off"}`}
      </span>
      <Switch
        aria-label="Fiat deposit access"
        checked={enabled ?? false}
        disabled={enabled === null || isPending}
        onCheckedChange={update}
      />
    </div>
  );
}
