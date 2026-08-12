"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { AlertTriangle, Loader2, RotateCcw, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { clientActionError } from "@/lib/errors/client-action-error";

import { StepUpField } from "@/components/step-up-field";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { SignupIngestionFailure } from "@/lib/antifraud/signup-failures-api";
import { formatDateTime, formatRelative } from "@/lib/utils/format";
import { resolveSignupFailure, retrySignupFailure } from "../signup-failure-actions";

export function SignupFailureManager({
  failures,
}: {
  failures: SignupIngestionFailure[];
}) {
  if (failures.length === 0) return null;

  return (
    <section id="signup-recovery" className="scroll-mt-24 space-y-3">
      <div className="flex items-start gap-3 rounded-xl border border-amber-500/25 bg-amber-500/5 px-4 py-3">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <div>
          <p className="text-sm font-semibold">Signup recovery queue</p>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
            These accounts did not finish automated assessment. Transient
            failures retry on their displayed schedule; act only when a row
            says it needs attention. Resolve only when no assessment should be
            created. Manual actions require fresh verification and are audited.
          </p>
        </div>
      </div>

      <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60 bg-card">
        {failures.map((failure) => {
          const automaticRetryScheduled = failure.nextRetryAt !== null;
          return (
            <li
              key={failure.userId}
              className="flex flex-col gap-3 px-4 py-3 lg:flex-row lg:items-center"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    href={`/users/${encodeURIComponent(failure.userId)}`}
                    className="break-all font-mono text-xs font-medium hover:underline"
                  >
                    {failure.userId}
                  </Link>
                  <Badge variant="outline">
                    {failure.failureCount.toLocaleString()} attempts
                  </Badge>
                  <Badge
                    variant="outline"
                    className={
                      automaticRetryScheduled
                        ? "border-cyan-500/30 bg-cyan-500/5 text-cyan-700 dark:text-cyan-300"
                        : "border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-300"
                    }
                  >
                    {automaticRetryScheduled
                      ? "Automatic retry"
                      : "Action required"}
                  </Badge>
                  <code className="text-[10px] text-muted-foreground">
                    {failure.errorCode}
                  </code>
                </div>
                <p className="mt-1 text-sm">{failure.errorSummary}</p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  First failed {formatRelative(failure.firstFailedAt)} · Last
                  tried {formatRelative(failure.lastFailedAt)} (
                  {formatDateTime(failure.lastFailedAt)})
                </p>
                <p className="mt-1 text-[11px] font-medium text-muted-foreground">
                  {failure.nextRetryAt
                    ? `Next automatic retry ${formatRelative(failure.nextRetryAt)} (${formatDateTime(failure.nextRetryAt)})`
                    : recoveryInstruction(failure.failureKind)}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                {!automaticRetryScheduled && (
                  <FailureAction failure={failure} action="retry" />
                )}
                <FailureAction failure={failure} action="resolve" />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function recoveryInstruction(
  kind: SignupIngestionFailure["failureKind"],
): string {
  if (kind === "provider_configuration") {
    return "Automatic retries paused · fix the provider configuration, then retry.";
  }
  if (kind === "invalid_payload") {
    return "Automatic retries paused · inspect the account before retrying or resolving.";
  }
  return "Automatic retries exhausted · verify the dependency is healthy, then retry.";
}

function FailureAction({
  failure,
  action,
}: {
  failure: SignupIngestionFailure;
  action: "retry" | "resolve";
}) {
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [credential, setCredential] = useState("");
  const [pending, startTransition] = useTransition();
  const resolving = action === "resolve";

  function submit(): void {
    startTransition(async () => {
      try {
        const common = {
          userId: failure.userId,
          reason,
          credential,
          idempotencyKey: crypto.randomUUID(),
        };
        if (resolving) {
          await resolveSignupFailure({ ...common, confirmation });
        } else {
          await retrySignupFailure(common);
        }
        setReason("");
        setConfirmation("");
        setCredential("");
        toast.success(
          resolving ? "Signup failure resolved." : "Signup queued for retry.",
        );
      } catch (error) {
        toast.error(clientActionError(error, "The action failed."));
      }
    });
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={
          <Button
            type="button"
            size="sm"
            variant={resolving ? "outline" : "default"}
            disabled={pending}
          />
        }
      >
        {pending ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : resolving ? (
          <ShieldCheck className="size-3.5" />
        ) : (
          <RotateCcw className="size-3.5" />
        )}
        {resolving ? "Resolve" : "Retry"}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {resolving ? "Resolve without assessment?" : "Retry signup assessment?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {resolving
              ? "This removes the account from automatic recovery without creating an assessment. Use only after manual review."
              : "The monitor will retry the complete signup assessment on its next recovery pass."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-2">
          <Label htmlFor={`${action}-${failure.userId}-reason`}>Reason</Label>
          <Input
            id={`${action}-${failure.userId}-reason`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={500}
            disabled={pending}
          />
        </div>
        {resolving && (
          <div className="space-y-2">
            <Label htmlFor={`resolve-${failure.userId}-confirmation`}>
              Type RESOLVE to confirm
            </Label>
            <Input
              id={`resolve-${failure.userId}-confirmation`}
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              autoComplete="off"
              disabled={pending}
            />
          </div>
        )}
        <StepUpField
          value={credential}
          onChange={setCredential}
          disabled={pending}
          label="Fresh TOTP or passkey"
        />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={submit}
            disabled={
              pending ||
              reason.trim().length < 4 ||
              !credential ||
              (resolving && confirmation !== "RESOLVE")
            }
          >
            {pending ? "Applying…" : resolving ? "Resolve failure" : "Queue retry"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
