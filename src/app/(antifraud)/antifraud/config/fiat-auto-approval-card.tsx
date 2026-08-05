"use client";

import { useEffect, useState, useTransition } from "react";
import { AlertTriangle, BadgeDollarSign, Loader2, ShieldCheck } from "lucide-react";
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
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { updateFiatAutomaticCreditAction } from "./fiat-auto-approval-actions";

export function GlobalFiatReviewCard({
  initialEnabled,
}: {
  initialEnabled: boolean | null;
}) {
  const [isPending, startTransition] = useTransition();
  const [enabled, setEnabled] = useState(initialEnabled ?? false);
  const [requestedEnabled, setRequestedEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    if (initialEnabled !== null) setEnabled(initialEnabled);
  }, [initialEnabled]);

  if (initialEnabled === null) {
    return (
      <Card className="border-dashed">
        <CardHeader>
          <CardTitle className="text-sm font-medium">
            Fiat Deposit Approval
          </CardTitle>
          <CardDescription>
            Controls whether verified Fiat deposits credit automatically.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="mb-3 flex items-center justify-between gap-3">
            <Badge variant="outline">Unavailable</Badge>
            <Switch
              aria-label="Global Fiat automatic credit"
              checked={false}
              disabled
            />
          </div>
          <div className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <div className="space-y-1">
              <p className="font-medium">Backend setting unavailable</p>
              <p className="text-amber-600/80 dark:text-amber-400/80">
                The authoritative automatic-credit state could not be loaded,
                so the switch is disabled.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  const submit = () => {
    if (requestedEnabled === null) return;
    const nextEnabled = requestedEnabled;
    startTransition(async () => {
      const result = await updateFiatAutomaticCreditAction({
        enabled: nextEnabled,
      });
      if (result.success) {
        setEnabled(result.data.fiat_deposit_automatic_credit_enabled);
        setRequestedEnabled(null);
        toast.success(
          result.data.fiat_deposit_automatic_credit_enabled
            ? "Global Fiat automatic credit enabled"
            : "Global Fiat manual approval enabled",
        );
        return;
      }
      toast.error(result.error);
    });
  };

  return (
    <Card>
      <CardHeader>
        <div className="max-w-3xl space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <BadgeDollarSign className="size-4 text-muted-foreground" />
              Global Fiat automatic credit
            </CardTitle>
            <Badge
              variant="outline"
              className={
                enabled
                  ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                  : "border-amber-500/30 bg-amber-500/15 text-amber-600 dark:text-amber-400"
              }
            >
              {enabled ? "Automatic" : "Admin approval"}
            </Badge>
            <Switch
              aria-label="Global Fiat automatic credit"
              checked={enabled}
              disabled={isPending}
              onCheckedChange={setRequestedEnabled}
            />
          </div>
          <CardDescription>
            When enabled, verified Fiat deposits credit automatically. When
            disabled, deposits wait for an admin decision unless that user
            has the per-account auto-approval override enabled.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="max-w-3xl">
        <div className="flex items-start gap-3 rounded-md border border-blue-500/30 bg-blue-500/5 p-3 text-xs">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-blue-600 dark:text-blue-400" />
          <p className="text-muted-foreground">
            This controls the credit step only. Fraud, KYC, payment-binding,
            dispute, refund, amount, and compliance checks remain enforced in
            either mode.
          </p>
        </div>
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
              {requestedEnabled
                ? "Enable automatic Fiat credit?"
                : "Require admin approval for Fiat deposits?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {requestedEnabled
                ? "Verified Fiat deposits will credit automatically for all users. Existing safety checks still apply."
                : "New verified Fiat deposits will enter the admin review queue. Users with an explicit per-account auto-approval override will still credit automatically."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <Button onClick={submit} disabled={isPending}>
              {isPending && <Loader2 className="size-4 animate-spin" />}
              {isPending ? "Saving..." : "Confirm change"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
