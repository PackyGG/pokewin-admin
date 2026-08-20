"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

import { resetVipPerksQualificationAction } from "./actions";

export function VipPerksResetButton({
  userId,
  playerLabel,
}: {
  userId: string;
  playerLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function handleConfirm() {
    startTransition(async () => {
      const result = await resetVipPerksQualificationAction(userId);
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success("Started a new 30-day window for " + playerLabel);
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 px-2 text-[11px]"
          />
        }
      >
        <RotateCcw className="size-3" aria-hidden />
        Reset window
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Reset qualification window?</AlertDialogTitle>
          <AlertDialogDescription>
            This starts a fresh 30-day initial qualification window for{" "}
            <strong className="text-foreground">{playerLabel}</strong>. Their
            channel and Packy account stay linked, but prior progress in the
            expired window is not carried forward.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleConfirm} disabled={isPending}>
            {isPending ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden />
                Resetting…
              </>
            ) : (
              <>
                <RotateCcw className="size-4" aria-hidden />
                Start new 30-day window
              </>
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
