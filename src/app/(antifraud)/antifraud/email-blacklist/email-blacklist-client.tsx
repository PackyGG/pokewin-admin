"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Ban, Loader2, MailWarning, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { EmptyState } from "@/components/empty-state";
import { SectionHeading } from "@/components/modern-panels";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { FiatEmailDomainRule } from "@/lib/antifraud/fiat-email-domains-api";
import { formatRelative } from "@/lib/utils/format";
import {
  addFiatEmailDomain,
  setFiatEmailDomainState,
} from "./actions";

export function EmailBlacklistClient({
  initialRules,
}: {
  initialRules: FiatEmailDomainRule[];
}) {
  const router = useRouter();
  const [rules, setRules] = useState(initialRules);
  const [domain, setDomain] = useState("");
  // Confirmation state for the two destructive flows. Replaces the native
  // window.confirm/window.prompt pair — same wording, same validation.
  const [pendingDomain, setPendingDomain] = useState<string | null>(null);
  const [toggleTarget, setToggleTarget] = useState<FiatEmailDomainRule | null>(
    null,
  );
  const [toggleReason, setToggleReason] = useState("");
  const [isPending, startTransition] = useTransition();
  const isCheckingHistory = rules.some(
    (rule) => rule.enabled && !rule.backfillComplete,
  );

  useEffect(() => {
    if (!isCheckingHistory) return;
    const timer = window.setInterval(() => router.refresh(), 3_000);
    return () => window.clearInterval(timer);
  }, [isCheckingHistory, router]);

  function addDomain(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submittedDomain = domain.trim();
    if (!submittedDomain) {
      toast.error("Enter an email domain.");
      return;
    }
    setPendingDomain(submittedDomain);
  }

  function confirmAddDomain() {
    const submittedDomain = pendingDomain;
    if (!submittedDomain) return;
    setPendingDomain(null);
    startTransition(async () => {
      try {
        const saved = await addFiatEmailDomain({
          domain: submittedDomain,
          confirmed: true,
          idempotencyKey: crypto.randomUUID(),
        });
        setRules((current) => [
          saved,
          ...current.filter((rule) => rule.id !== saved.id),
        ]);
        setDomain("");
        toast.success(`${saved.domain} is now blocked.`);
        router.refresh();
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "The domain could not be added.",
        );
      }
    });
  }

  function toggleRule(rule: FiatEmailDomainRule) {
    setToggleReason("");
    setToggleTarget(rule);
  }

  function confirmToggleRule() {
    const rule = toggleTarget;
    const updateReason = toggleReason;
    if (!rule) return;
    if (!updateReason || updateReason.trim().length < 4) return;
    setToggleTarget(null);
    setToggleReason("");
    startTransition(async () => {
      try {
        const saved = await setFiatEmailDomainState({
          id: rule.id,
          enabled: !rule.enabled,
          reason: updateReason.trim(),
          expiresAt: rule.expiresAt,
          confirmed: true,
          idempotencyKey: crypto.randomUUID(),
        });
        setRules((current) =>
          current.map((entry) => (entry.id === saved.id ? saved : entry)),
        );
        toast.success(
          saved.enabled
            ? `${saved.domain} is blocking again.`
            : `${saved.domain} is disabled.`,
        );
        router.refresh();
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : "The blacklist rule could not be changed.",
        );
      }
    });
  }

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
      <form
        onSubmit={addDomain}
        className="h-fit space-y-4 rounded-xl border border-border/60 bg-card p-3 sm:p-4"
      >
        <div>
          <SectionHeading icon={MailWarning} title="Add blocked domain" />
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Exact domain matches from new signups and Whop checkout emails
            are automatically banned and sent to staff review. Existing
            matching accounts are never mass-actioned.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="email-domain">Email domain</Label>
          <Input
            id="email-domain"
            value={domain}
            onChange={(event) => setDomain(event.target.value)}
            placeholder="stolas.org"
            autoComplete="off"
            spellCheck={false}
            disabled={isPending}
          />
        </div>
        <Button type="submit" className="w-full" disabled={isPending}>
          {isPending ? (
            <Loader2 className="size-4 motion-safe:animate-spin" />
          ) : (
            <Ban className="size-4" />
          )}
          Block domain
        </Button>
      </form>

      <section className="overflow-hidden rounded-xl border border-border/60 bg-card">
        <div className="border-b border-border/60 px-4 py-3">
          <SectionHeading
            icon={ShieldCheck}
            title="Email domain rules"
            action={
              <span className="text-[10px] font-semibold uppercase tracking-wide tabular-nums text-muted-foreground">
                {rules.length} {rules.length === 1 ? "rule" : "rules"}
              </span>
            }
          />
        </div>
        {rules.length === 0 ? (
          <EmptyState
            icon={MailWarning}
            title="No email domains are blacklisted."
          />
        ) : (
          <div className="divide-y divide-border/60">
            {rules.map((rule) => (
              <div
                key={rule.id}
                className="grid gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="break-all font-mono text-sm font-semibold">
                      @{rule.domain}
                    </span>
                    <Badge
                      variant="outline"
                      className={
                        rule.enabled
                          ? "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400"
                          : ""
                      }
                    >
                      {rule.enabled ? "Blocking" : "Disabled"}
                    </Badge>
                    {!rule.backfillComplete && rule.enabled && (
                      <Badge
                        variant="outline"
                        className="border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                      >
                        Checking history
                      </Badge>
                    )}
                  </div>
                  <p className="text-[11px] tabular-nums text-muted-foreground">
                    {rule.affectedUsers} affected users · {rule.matchCount} matches
                    {rule.pendingLocks > 0
                      ? ` · ${rule.pendingLocks} locks pending`
                      : ""}{" "}
                    · {rule.matches24h}/24h · {rule.matches7d}/7d ·{" "}
                    {rule.matches30d}/30d · updated {formatRelative(rule.updatedAt)}
                  </p>
                </div>
                <Button
                  type="button"
                  variant={rule.enabled ? "outline" : "destructive"}
                  size="sm"
                  disabled={isPending}
                  onClick={() => toggleRule(rule)}
                >
                  {rule.enabled ? "Disable" : "Enable"}
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>

      <AlertDialog
        open={pendingDomain !== null}
        onOpenChange={(open) => {
          if (!open && !isPending) setPendingDomain(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Add this domain to the Fraud blacklist?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Existing matches will not be mass-locked.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <p className="break-all font-mono text-sm font-semibold">
            @{pendingDomain ?? ""}
          </p>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmAddDomain}
              disabled={isPending || !pendingDomain}
            >
              Block domain
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={toggleTarget !== null}
        onOpenChange={(open) => {
          if (!open && !isPending) {
            setToggleTarget(null);
            setToggleReason("");
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {toggleTarget?.enabled
                ? `Disable @${toggleTarget.domain}?`
                : `Reactivate @${toggleTarget?.domain ?? ""}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              The reason is recorded in the Antifraud audit.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor="email-domain-toggle-reason">
              {toggleTarget?.enabled
                ? "Why are you disabling this rule?"
                : "Why are you reactivating this rule?"}
            </Label>
            <Input
              id="email-domain-toggle-reason"
              value={toggleReason}
              onChange={(event) => setToggleReason(event.target.value)}
              maxLength={500}
              autoComplete="off"
              disabled={isPending}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant={toggleTarget?.enabled ? "default" : "destructive"}
              onClick={confirmToggleRule}
              disabled={isPending || toggleReason.trim().length < 4}
            >
              {toggleTarget?.enabled ? "Disable" : "Reactivate"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
