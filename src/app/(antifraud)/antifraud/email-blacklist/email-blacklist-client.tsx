"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Ban, Loader2, MailWarning, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

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
  const [isPending, startTransition] = useTransition();

  function addDomain(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submittedDomain = domain.trim();
    if (!submittedDomain) {
      toast.error("Enter an email domain.");
      return;
    }
    startTransition(async () => {
      try {
        const saved = await addFiatEmailDomain({
          domain: submittedDomain,
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
    startTransition(async () => {
      try {
        const saved = await setFiatEmailDomainState({
          id: rule.id,
          enabled: !rule.enabled,
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
        className="h-fit space-y-4 rounded-xl border bg-card p-4"
      >
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <MailWarning className="size-4 text-rose-500" />
            Add blocked domain
          </h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Exact domain matches from new signups and Whop checkout emails
            receive an automatic crypto and item withdrawal lock.
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
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Ban className="size-4" />
          )}
          Block domain
        </Button>
      </form>

      <section className="overflow-hidden rounded-xl border bg-card">
        <div className="border-b px-4 py-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <ShieldCheck className="size-4 text-cyan-500" />
            Email domain rules
          </h2>
        </div>
        {rules.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">
            No email domains are blacklisted.
          </p>
        ) : (
          <div className="divide-y">
            {rules.map((rule) => (
              <div
                key={rule.id}
                className="grid gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-semibold">
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
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {rule.affectedUsers} affected users · {rule.matchCount} matches
                    {rule.pendingLocks > 0
                      ? ` · ${rule.pendingLocks} locks pending`
                      : ""}{" "}
                    · updated {formatRelative(rule.updatedAt)}
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
    </div>
  );
}
