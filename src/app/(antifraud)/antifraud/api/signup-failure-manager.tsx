"use client";

import { useState, useTransition } from "react";
import { RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";

import {
  resolveSignupFailureAction,
  retrySignupFailureAction,
} from "./actions";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { formatDateTime } from "@/lib/utils/format";
import type { SignupIngestionFailure } from "@/lib/antifraud/signup-failures-api";

export function SignupFailureManager({
  configured,
  error,
  failures,
}: {
  configured: boolean;
  error: boolean;
  failures: SignupIngestionFailure[];
}) {
  const [working, startTransition] = useTransition();
  const [resolving, setResolving] = useState<SignupIngestionFailure | null>(
    null,
  );
  const [reason, setReason] = useState("");

  if (!configured) {
    return (
      <StatusNotice
        icon={TriangleAlert}
        title="Monitor admin access is not configured"
        description="Add the Antifraud monitor URL and admin token to manage signup recovery."
      />
    );
  }
  if (error) {
    return (
      <StatusNotice
        icon={TriangleAlert}
        title="Signup recovery is unavailable"
        description="The dashboard could not load the monitor's durable failure queue."
        destructive
      />
    );
  }
  if (failures.length === 0) {
    return (
      <StatusNotice
        icon={ShieldCheck}
        title="No pending signup failures"
        description="Every durable signup ingestion failure has recovered or been reviewed."
        success
      />
    );
  }

  function retry(failure: SignupIngestionFailure) {
    startTransition(async () => {
      try {
        await retrySignupFailureAction({
          userId: failure.userId,
          idempotencyKey: crypto.randomUUID(),
          reason: "Manual retry from Antifraud operations",
        });
        toast.success("Signup assessment queued for immediate retry.");
      } catch (caught) {
        toast.error(
          caught instanceof Error ? caught.message : "Retry failed.",
        );
      }
    });
  }

  function resolve() {
    if (!resolving || reason.trim().length < 3) {
      toast.error("Enter a review reason.");
      return;
    }
    startTransition(async () => {
      try {
        await resolveSignupFailureAction({
          userId: resolving.userId,
          idempotencyKey: crypto.randomUUID(),
          reason,
        });
        toast.success("Signup failure marked reviewed.");
        setResolving(null);
        setReason("");
      } catch (caught) {
        toast.error(
          caught instanceof Error ? caught.message : "Resolve failed.",
        );
      }
    });
  }

  return (
    <>
      <div className="space-y-3">
        {failures.map((failure) => (
          <article
            key={failure.userId}
            className="space-y-3 rounded-xl border border-amber-500/25 bg-card p-4"
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    href={`/users/${encodeURIComponent(failure.userId)}`}
                    className="font-mono text-sm font-semibold text-primary hover:underline"
                  >
                    {failure.userId}
                  </Link>
                  <span className="rounded-md bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">
                    {failure.failureCount} attempts
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  First failed {formatDateTime(failure.firstFailedAt)} · Last
                  failed {formatDateTime(failure.lastFailedAt)}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={working}
                  onClick={() => retry(failure)}
                >
                  <RefreshCw className="size-4" />
                  Retry now
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={working}
                  onClick={() => setResolving(failure)}
                >
                  Mark reviewed
                </Button>
              </div>
            </div>
            <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-muted/60 p-3 text-xs text-foreground">
              {failure.error}
            </pre>
          </article>
        ))}
      </div>

      <AlertDialog
        open={Boolean(resolving)}
        onOpenChange={(open) => {
          if (!open && !working) {
            setResolving(null);
            setReason("");
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Mark this failed assessment as reviewed?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This removes it from monitor readiness without creating the
              missing assessment. Retry first unless the error is permanently
              invalid and you have reviewed the account separately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Why is it safe to close this failure?"
            maxLength={500}
            disabled={working}
          />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={working}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={working || reason.trim().length < 3}
              onClick={(event) => {
                event.preventDefault();
                resolve();
              }}
            >
              Mark reviewed
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function StatusNotice({
  icon: Icon,
  title,
  description,
  destructive = false,
  success = false,
}: {
  icon: React.ElementType;
  title: string;
  description: string;
  destructive?: boolean;
  success?: boolean;
}) {
  return (
    <div
      className={`flex gap-3 rounded-xl border p-4 ${
        destructive
          ? "border-red-500/25 bg-red-500/5"
          : success
            ? "border-emerald-500/25 bg-emerald-500/5"
            : "border-border/60 bg-card"
      }`}
    >
      <Icon
        className={`mt-0.5 size-4 shrink-0 ${
          destructive
            ? "text-red-500"
            : success
              ? "text-emerald-500"
              : "text-muted-foreground"
        }`}
      />
      <div>
        <p className="text-sm font-semibold">{title}</p>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}
