"use client";

import { useEffect, useState, useTransition } from "react";
import { CheckCircle2, Loader2, RefreshCw, ShieldOff, Users } from "lucide-react";
import { useRouter } from "next/navigation";
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

type ControllerSummary = {
  allowed: boolean;
  label: string;
  detail: string;
};

function controllerSummary(
  status: FiatAccessControlStatus,
): ControllerSummary {
  const existing = status.existingAccounts;
  const signup = status.newSignups;
  const existingConfigured = existing.generation > 0;
  const signupConfigured = signup.generation > 0;
  const rolloutActive = ["queued", "running"].includes(existing.status);

  if (rolloutActive) {
    return {
      allowed: existing.enabled || signup.enabled,
      label: existing.enabled
        ? "Fiat access is turning on"
        : "Fiat access is turning off",
      detail: `${existing.succeeded.toLocaleString()} existing accounts are confirmed ${
        existing.enabled ? "allowed" : "blocked"
      }. New signups are ${signup.enabled ? "allowed" : "blocked"}.`,
    };
  }

  if (existing.status === "stalled") {
    return {
      allowed: existing.enabled || signup.enabled,
      label: "Fiat access rollout is retrying",
      detail: `${existing.succeeded.toLocaleString()} existing accounts are confirmed ${
        existing.enabled ? "allowed" : "blocked"
      }; ${existing.failed.toLocaleString()} still need retry. New signups are ${
        signup.enabled ? "allowed" : "blocked"
      }.`,
    };
  }

  const existingAllowed = existingConfigured && existing.enabled;
  const signupAllowed = signupConfigured && signup.enabled;
  if (existingAllowed && signupAllowed) {
    return {
      allowed: true,
      label: "Fiat allowed for all accounts",
      detail: "The controller allows existing accounts and automatically allows new signups.",
    };
  }
  if (existingAllowed) {
    return {
      allowed: true,
      label: "Fiat allowed for existing accounts only",
      detail: "Existing accounts are allowed by the controller. New signups are blocked.",
    };
  }
  if (signupAllowed) {
    return {
      allowed: true,
      label: "Fiat allowed for new signups only",
      detail: "New signups are allowed by the controller. Existing accounts are blocked.",
    };
  }
  return {
    allowed: false,
    label: "Fiat blocked by the account controller",
    detail:
      existingConfigured || signupConfigured
        ? "The controller does not currently allow either account group."
        : "No account-access policy has been applied yet.",
  };
}

function existingAccessLabel(
  existing: FiatAccessControlStatus["existingAccounts"],
): string {
  if (existing.generation === 0) return "Not configured";
  if (["queued", "running"].includes(existing.status)) {
    return existing.enabled ? "Turning access on" : "Turning access off";
  }
  if (existing.status === "stalled") {
    return existing.enabled ? "Access on · retrying" : "Access off · retrying";
  }
  return existing.enabled ? "Controller allows" : "Controller blocks";
}

export function FiatDepositAccessControlCard({
  initialStatus,
}: {
  initialStatus: FiatAccessControlStatus | null;
}) {
  const router = useRouter();
  const [status, setStatus] = useState(initialStatus);
  const [requested, setRequested] = useState<{ scope: Scope; enabled: boolean } | null>(null);
  // Staged position of the existing-accounts switch while no policy has ever
  // been written (generation 0). In that state the monitor reports a fabricated
  // `enabled: false` default rather than an observed backend value, so binding
  // the switch to it would leave `enabled: true` as the only value an operator
  // could ever submit — the switch could only ever grant fiat access, never
  // revoke it. Staging locally lets the operator settle on either direction
  // before confirming. Once generation > 0 this is ignored entirely.
  const [pendingExisting, setPendingExisting] = useState(false);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (!isPending) setStatus(initialStatus);
  }, [initialStatus, isPending]);

  const rolloutActive = status
    ? ["queued", "running"].includes(status.existingAccounts.status)
    : false;
  useEffect(() => {
    if (!rolloutActive) return;
    const timer = window.setInterval(() => router.refresh(), 5_000);
    return () => window.clearInterval(timer);
  }, [rolloutActive, router]);

  if (!status || !status.configured) {
    return (
      <Card className="border-dashed">
        <CardHeader>
          <CardTitle className="text-sm font-medium">Backend Fiat access</CardTitle>
          <CardDescription>The per-account Fiat controller is unavailable, so both switches are disabled.</CardDescription>
        </CardHeader>
        <CardContent>
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
    if (!requested) return;
    startTransition(async () => {
      const result = await updateFiatDepositAccessControlAction(requested);
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      setStatus(result.data);
      if (requested.scope === "existing-accounts") {
        setPendingExisting(requested.enabled);
      }
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
  // Only a live rollout locks the switch. A `stalled` rollout just means at
  // least one user is in retry backoff, and the monitor retries with no attempt
  // ceiling — treating that as "active" let one permanently failing user wedge
  // existing-account fiat policy forever. The monitor now supersedes a stalled
  // rollout instead of refusing (see FiatAccessRolloutInProgressError).
  const existingRolloutActive = ["queued", "running"].includes(existing.status);
  const existingStalled = existing.status === "stalled";
  // Before the first policy exists there is no observed backend state to show,
  // so the switch reflects the value that is staged for confirmation.
  const existingUnconfigured = existing.generation === 0;
  const summary = controllerSummary(status);
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
        <div
          role="status"
          className={`flex items-start gap-3 rounded-lg border p-3 ${
            summary.allowed
              ? "border-emerald-500/30 bg-emerald-500/5"
              : "border-amber-500/30 bg-amber-500/5"
          }`}
        >
          {summary.allowed ? (
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
          ) : (
            <ShieldOff className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          )}
          <div className="space-y-1">
            <p className="text-sm font-semibold">{summary.label}</p>
            <p className="text-xs text-muted-foreground">
              {summary.detail} Site-wide availability, location policy, KYC,
              and fraud locks can still block an individual checkout.
            </p>
          </div>
        </div>

        <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium">Fiat access for existing accounts</p>
              <Badge variant={existing.enabled ? "default" : "outline"}>
                {existingAccessLabel(existing)}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              Applies the selected controller value to every account registered before confirmation.
              {existing.generation > 0 &&
                ` ${existing.processed.toLocaleString()} processed · ${existing.succeeded.toLocaleString()} confirmed`}
              {existing.failed > 0 && ` · ${existing.failed.toLocaleString()} retrying`}.
              {existingRolloutActive && " Wait for this rollout to finish before changing it again."}
              {existingUnconfigured &&
                " No rollout has ever been applied, so this switch shows the value you are about to apply — not a value read from the backend."}
            </p>
            {existing.cutoffAt && (
              <p className="text-xs text-muted-foreground">
                Scope frozen {new Date(existing.cutoffAt).toLocaleString()}
                {existing.completedAt
                  ? ` · Completed ${new Date(existing.completedAt).toLocaleString()}`
                  : existingRolloutActive
                    ? " · Refreshing automatically"
                    : ""}
              </p>
            )}
            {existingStalled && (
              <p className="text-xs text-muted-foreground">
                This rollout is still retrying at least one account. You can wait for recovery or confirm a new value to supersede it and cancel the outstanding retries.
                {existing.lastError ? ` Last error: ${existing.lastError}` : ""}
              </p>
            )}
          </div>
          <Switch
            aria-label="Fiat access for existing accounts"
            checked={existingUnconfigured ? pendingExisting : existing.enabled}
            disabled={isPending || existingRolloutActive}
            onCheckedChange={(enabled) => {
              if (existingUnconfigured) setPendingExisting(enabled);
              setRequested({ scope: "existing-accounts", enabled });
            }}
          />
        </div>

        <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium">Fiat access for new signups</p>
              <Badge variant="outline">
                {signup.generation === 0
                  ? "Not configured"
                  : signup.enabled
                    ? "Controller allows"
                    : "Controller blocks"}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              Automatically sets the same backend controller for every account created after this switch changes.
            </p>
            {signup.generation > 0 && (
              <p className="text-xs text-muted-foreground">
                {signup.processed.toLocaleString()} signup accounts processed
                {signup.failed > 0
                  ? ` · ${signup.failed.toLocaleString()} failed`
                  : " · no failures"}
                {signup.effectiveAt
                  ? ` · Effective ${new Date(signup.effectiveAt).toLocaleString()}`
                  : ""}
              </p>
            )}
          </div>
          <Switch
            aria-label="Fiat access for new signups"
            checked={signup.enabled}
            disabled={isPending}
            onCheckedChange={(enabled) => setRequested({ scope: "new-signups", enabled })}
          />
        </div>

        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={isPending}
          onClick={() => router.refresh()}
        >
          <RefreshCw className="size-3.5" />
          Refresh status
        </Button>

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
                ? `Every account registered before confirmation will be written to fiat_deposits_enabled = ${
                    requested.enabled ? "true" : "false"
                  }, which ${
                    requested.enabled
                      ? "GRANTS fiat deposit access to the entire existing account base"
                      : "REVOKES fiat deposit access from the entire existing account base"
                  }. This is a durable per-user rollout through the backend: it cannot be undone by cancelling, only by running the opposite rollout afterwards.${
                    existingStalled
                      ? " It also supersedes the current stalled rollout and cancels its outstanding retries."
                      : ""
                  } Progress and retries remain visible here.`
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
