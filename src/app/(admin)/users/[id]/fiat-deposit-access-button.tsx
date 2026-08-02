"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { BadgeDollarSign, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import type { FiatDepositAccess } from "@/lib/backend-api/fiat-deposit-access";
import { updateFiatDepositAccessAction } from "./fiat-deposit-access-actions";

export function FiatDepositAccessCard({
  userId,
  data,
  canManage,
}: {
  userId: string;
  data: FiatDepositAccess | null;
  canManage: boolean;
}) {
  const router = useRouter();
  const [access, setAccess] = useState(data);
  const [requestedEnabled, setRequestedEnabled] = useState<boolean | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (!isPending) setAccess(data);
  }, [data, isPending]);

  if (!access) {
    return (
      <Card className="border-dashed">
        <CardContent className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <p className="text-sm font-medium">Fiat access unavailable</p>
            <p className="text-xs text-muted-foreground">
              The current allow-list status could not be loaded. No change can
              be made until the authoritative backend state is available.
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => router.refresh()}
          >
            <RefreshCw className="size-3.5" />
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  const submit = () => {
    if (requestedEnabled === null) return;
    const nextEnabled = requestedEnabled;

    startTransition(async () => {
      const result = await updateFiatDepositAccessAction(userId, nextEnabled);
      if (result.success) {
        setAccess(result.data);
        setRequestedEnabled(null);
        toast.success(
          result.data.enabled
            ? "Fiat deposit allow-list access enabled"
            : "Fiat deposit allow-list access disabled",
        );
        router.refresh();
        return;
      }

      toast.error(result.error);
    });
  };

  const nextLabel = requestedEnabled ? "enable" : "disable";

  return (
    <Card>
      <CardContent className="space-y-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <BadgeDollarSign className="size-4 text-muted-foreground" />
              <span className="text-sm font-medium">Fiat deposit allow-list</span>
              <Badge
                variant="outline"
                className={
                  access.enabled
                    ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                    : "border-rose-500/30 bg-rose-500/15 text-rose-600 dark:text-rose-400"
                }
              >
                {access.enabled ? "Allowed" : "Not allowed"}
              </Badge>
            </div>
            <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
              Controls only whether this user is on the Fiat deposit
              allow-list. Fraud, compliance, KYC, location, and other safety
              locks remain independent and may still block a deposit.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {access.enabled ? "Enabled" : "Disabled"}
            </span>
            <Switch
              aria-label="Fiat deposit allow-list access"
              checked={access.enabled}
              disabled={!canManage || isPending}
              onCheckedChange={setRequestedEnabled}
            />
          </div>
        </div>

        {!canManage && (
          <p className="text-xs text-muted-foreground">
            Administrator access is required to change this setting.
          </p>
        )}
      </CardContent>

      <AlertDialog
        open={requestedEnabled !== null}
        onOpenChange={(open) => {
          if (!open && !isPending) setRequestedEnabled(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {requestedEnabled ? "Enable" : "Disable"} Fiat deposit access?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will {nextLabel} this user&apos;s Fiat deposit allow-list
              access. It will not clear or bypass any fraud, compliance, KYC,
              or location restriction.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <Button onClick={submit} disabled={isPending}>
              {isPending && <Loader2 className="size-4 animate-spin" />}
              {isPending ? "Saving..." : `Confirm ${nextLabel}`}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
