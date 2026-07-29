"use client";

import { useEffect, useState, useTransition } from "react";
import { BadgeDollarSign } from "lucide-react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  getFiatDepositAccessAction,
  updateFiatDepositAccessAction,
} from "./fiat-deposit-access-actions";

export function FiatDepositAccessButton({ userId }: { userId: string }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
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
    startTransition(async () => {
      const result = await updateFiatDepositAccessAction(userId, nextEnabled);
      if (result.success) {
        setEnabled(result.data.enabled);
        setLoadError(null);
        setOpen(false);
        toast.success(
          result.data.enabled
            ? "Fiat deposits enabled"
            : "Fiat deposits disabled",
        );
      } else {
        toast.error(result.error);
      }
    });
  };

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger
        render={
          <Button
            size="sm"
            variant="outline"
            className={cn(
              enabled === true &&
                "border-emerald-500/40 text-emerald-600 hover:bg-emerald-500/10 dark:text-emerald-400",
              enabled === false &&
                "border-rose-500/40 text-rose-600 hover:bg-rose-500/10 dark:text-rose-400",
            )}
          />
        }
      >
        <BadgeDollarSign className="size-3.5" />
        {enabled === null ? "Fiat access" : `Fiat ${enabled ? "on" : "off"}`}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Fiat deposit access</AlertDialogTitle>
          <AlertDialogDescription>
            {enabled === null
              ? loadError ??
                "The current status is still loading. You can set it explicitly."
              : `Fiat deposits are currently ${enabled ? "enabled" : "disabled"} for this user.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          {(enabled === true || enabled === null) && (
            <Button
              variant="destructive"
              disabled={isPending}
              onClick={() => update(false)}
            >
              {isPending ? "Updating…" : "Turn fiat off"}
            </Button>
          )}
          {(enabled === false || enabled === null) && (
            <Button disabled={isPending} onClick={() => update(true)}>
              {isPending ? "Updating…" : "Turn fiat on"}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
