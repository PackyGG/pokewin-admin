"use client";

import { useState, useTransition } from "react";
import { Loader2, ShieldCheck, Users } from "lucide-react";
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import type { FiatAccessControlStatus } from "@/lib/antifraud/monitor-api";
import { updateFiatDepositAccessControlAction } from "./fiat-deposit-access-control-actions";

type Scope = "existing-accounts" | "new-signups";

export function FiatDepositAccessControlCard({
  initialStatus,
}: {
  initialStatus: FiatAccessControlStatus | null;
}) {
  const [status, setStatus] = useState(initialStatus);
  const [requested, setRequested] = useState<{ scope: Scope; enabled: boolean } | null>(null);
  const [isPending, startTransition] = useTransition();

  if (!status || !status.configured) {
    return (
      <Card className="border-dashed">
        <CardHeader>
          <CardTitle className="text-sm font-medium">Backend Fiat access</CardTitle>
          <CardDescription>The per-account Fiat controller is unavailable, so both switches are disabled.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const submit = () => {
    if (!requested) return;
    startTransition(async () => {
      const result = await updateFiatDepositAccessControlAction(requested);
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      setStatus(result.data);
      setRequested(null);
      toast.success(
        requested.scope === "existing-accounts"
          ? "Existing-account Fiat access rollout queued"
          : `New-signup Fiat access ${requested.enabled ? "enabled" : "disabled"}`,
      );
    });
  };

  const existing = status.existingAccounts;
  const signup = status.newSignups;
  const existingRolloutActive = ["queued", "running", "stalled"].includes(
    existing.status,
  );
  return (
    <Card>
      <CardHeader>
        <div className="max-w-3xl space-y-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Users className="size-4 text-muted-foreground" />
            Backend Fiat access
          </CardTitle>
          <CardDescription>
            These switches update the backend&apos;s per-account <code>fiat_deposits_enabled</code> controller. They do not change the site-wide Fiat lock or automatic credit.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="max-w-3xl space-y-3">
        <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium">Fiat access for existing accounts</p>
              <Badge variant="outline">{existing.status.replace("_", " ")}</Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              Applies the selected controller value to every account registered before confirmation.
              {existing.generation > 0 && ` ${existing.succeeded.toLocaleString()} confirmed`}
              {existing.failed > 0 && ` · ${existing.failed.toLocaleString()} retrying`}.
              {existingRolloutActive && " Wait for this rollout to finish before changing it again."}
            </p>
          </div>
          <Switch
            aria-label="Fiat access for existing accounts"
            checked={existing.enabled}
            disabled={isPending || existingRolloutActive}
            onCheckedChange={(enabled) => setRequested({ scope: "existing-accounts", enabled })}
          />
        </div>

        <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium">Fiat access for new signups</p>
              <Badge variant="outline">{signup.enabled ? "Access on" : "Access off"}</Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              Automatically sets the same backend controller for every account created after this switch changes.
            </p>
          </div>
          <Switch
            aria-label="Fiat access for new signups"
            checked={signup.enabled}
            disabled={isPending}
            onCheckedChange={(enabled) => setRequested({ scope: "new-signups", enabled })}
          />
        </div>

        <div className="flex items-start gap-3 rounded-md border border-blue-500/30 bg-blue-500/5 p-3 text-xs">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-blue-600 dark:text-blue-400" />
          <p className="text-muted-foreground">Country, KYC, fraud, payment, and user-specific locks remain enforced even when controller access is on.</p>
        </div>
      </CardContent>

      <AlertDialog open={requested !== null} onOpenChange={(open) => !open && !isPending && setRequested(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {requested?.scope === "existing-accounts"
                ? `${requested.enabled ? "Enable" : "Disable"} Fiat access for all existing accounts?`
                : `${requested?.enabled ? "Enable" : "Disable"} Fiat access for new signups?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {requested?.scope === "existing-accounts"
                ? "This starts a durable bulk rollout through the backend per-user endpoint. Progress and retries remain visible here."
                : `Accounts created after confirmation will automatically receive fiat_deposits_enabled = ${requested?.enabled ? "true" : "false"}.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <Button
              onClick={submit}
              disabled={isPending}
              variant={requested?.enabled ? "default" : "destructive"}
            >
              {isPending && <Loader2 className="size-4 animate-spin" />}
              {isPending ? "Saving..." : "Confirm change"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
