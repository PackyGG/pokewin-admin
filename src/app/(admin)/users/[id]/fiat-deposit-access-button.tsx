"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { BadgeDollarSign, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
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
import type { FiatEligibilityOverride } from "@/lib/antifraud/fiat-eligibility-overrides-api";
import type { FiatDepositAccess } from "@/lib/backend-api/fiat-deposit-access";
import {
  updateFiatDepositAccessAction,
  updatePreFiatAlwaysAllowAction,
} from "./fiat-deposit-access-actions";

export function FiatDepositAccessCard({
  userId,
  data,
  preFiatOverride,
  canManage,
}: {
  userId: string;
  data: FiatDepositAccess | null;
  preFiatOverride: FiatEligibilityOverride | null;
  canManage: boolean;
}) {
  const router = useRouter();
  const [access, setAccess] = useState(data);
  const [requestedEnabled, setRequestedEnabled] = useState<boolean | null>(null);
  const [alwaysAllow, setAlwaysAllow] = useState(preFiatOverride);
  const [requestedAlwaysAllow, setRequestedAlwaysAllow] = useState<
    boolean | null
  >(null);
  const [isPending, startTransition] = useTransition();
  const [overridePending, startOverrideTransition] = useTransition();

  useEffect(() => {
    if (!isPending) setAccess(data);
  }, [data, isPending]);

  useEffect(() => {
    if (!overridePending) setAlwaysAllow(preFiatOverride);
  }, [overridePending, preFiatOverride]);

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

  const submitAlwaysAllow = () => {
    if (requestedAlwaysAllow === null) return;
    const nextEnabled = requestedAlwaysAllow;
    startOverrideTransition(async () => {
      const result = await updatePreFiatAlwaysAllowAction(userId, nextEnabled);
      if (result.success) {
        setAlwaysAllow(result.data);
        setRequestedAlwaysAllow(null);
        toast.success(
          result.data.enabled
            ? "Pre-Fiat checks will always pass for this user"
            : "Pre-Fiat always-pass override disabled",
        );
        router.refresh();
        return;
      }
      toast.error(result.error);
    });
  };

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

        <div className="flex flex-col gap-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <ShieldCheck className="size-4 text-amber-600 dark:text-amber-400" />
              <span className="text-sm font-medium">
                Always pass pre-Fiat check
              </span>
              <Badge
                variant="outline"
                className={
                  alwaysAllow?.enabled
                    ? "border-amber-500/30 bg-amber-500/15 text-amber-700 dark:text-amber-300"
                    : "text-muted-foreground"
                }
              >
                {alwaysAllow
                  ? alwaysAllow.enabled ? "Bypassing" : "Normal checks"
                  : "Unavailable"}
              </Badge>
            </div>
            <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
              Returns an audited allow before automatic pre-Fiat scoring,
              provider checks, blocklists, or open Fraud cases are evaluated.
              The separate Fiat allow-list and downstream platform restrictions
              remain independent.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {overridePending && <Loader2 className="size-4 animate-spin" />}
            <Switch
              aria-label="Always pass pre-Fiat check"
              checked={alwaysAllow?.enabled ?? false}
              disabled={!canManage || !alwaysAllow || overridePending}
              onCheckedChange={setRequestedAlwaysAllow}
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

      <AlertDialog
        open={requestedAlwaysAllow !== null}
        onOpenChange={(open) => {
          if (!open && !overridePending) setRequestedAlwaysAllow(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {requestedAlwaysAllow ? "Enable" : "Disable"} pre-Fiat
              always-pass?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {requestedAlwaysAllow
                ? "Every authenticated production pre-Fiat request for this user will be allowed without automatic scoring or provider checks. The bypass is durable and audited."
                : "This user will immediately return to the normal automatic pre-Fiat checks."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={overridePending}>
              Cancel
            </AlertDialogCancel>
            <Button onClick={submitAlwaysAllow} disabled={overridePending}>
              {overridePending && <Loader2 className="size-4 animate-spin" />}
              {overridePending ? "Saving..." : "Confirm"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
