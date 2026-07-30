"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Ban,
  Fingerprint,
  Loader2,
  Network,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  IdentifierBlocklistKind,
  IdentifierBlocklistRule,
} from "@/lib/antifraud/identifier-blocklists-api";
import { formatRelative } from "@/lib/utils/format";
import {
  addIdentifierBlocklistRule,
  setIdentifierBlocklistRuleState,
} from "./identifier-blocklist-actions";

export function IdentifierBlocklistClient({
  kind,
  initialRules,
}: {
  kind: IdentifierBlocklistKind;
  initialRules: IdentifierBlocklistRule[];
}) {
  const router = useRouter();
  const [rules, setRules] = useState(initialRules);
  const [value, setValue] = useState("");
  const [matchMode, setMatchMode] = useState<"exact" | "cidr">("exact");
  const [isPending, startTransition] = useTransition();
  const isIp = kind === "ip";
  const Icon = isIp ? Network : Fingerprint;
  const label = isIp ? "IP or network" : "Fingerprint identifier";

  function add(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!value.trim()) {
      toast.error(`Enter a ${label.toLowerCase()}.`);
      return;
    }
    if (
      !window.confirm(
        `Block this ${isIp ? "IP/network" : "fingerprint"}? Existing matches will be added for review only.`,
      )
    ) {
      return;
    }
    startTransition(async () => {
      try {
        const saved = await addIdentifierBlocklistRule({
          kind,
          value: value.trim(),
          matchMode: isIp ? matchMode : "exact",
          confirmed: true,
          idempotencyKey: crypto.randomUUID(),
        });
        setRules((current) => [
          saved,
          ...current.filter((rule) => rule.id !== saved.id),
        ]);
        setValue("");
        toast.success(`${saved.value} is now blocked.`);
        router.refresh();
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "The rule could not be added.",
        );
      }
    });
  }

  function toggle(rule: IdentifierBlocklistRule) {
    if (
      !window.confirm(
        `${rule.enabled ? "Disable" : "Reactivate"} ${rule.value}?`,
      )
    ) {
      return;
    }
    startTransition(async () => {
      try {
        const saved = await setIdentifierBlocklistRuleState({
          kind,
          id: rule.id,
          enabled: !rule.enabled,
          confirmed: true,
          idempotencyKey: crypto.randomUUID(),
        });
        setRules((current) =>
          current.map((entry) => (entry.id === saved.id ? saved : entry)),
        );
        toast.success(saved.enabled ? "Rule reactivated." : "Rule disabled.");
        router.refresh();
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "The rule could not be changed.",
        );
      }
    });
  }

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,0.7fr)_minmax(0,1.3fr)]">
      <form onSubmit={add} className="h-fit space-y-4 rounded-xl border border-border/60 bg-card p-3 sm:p-4">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Icon className="size-4 text-rose-500" />
            Add blocked {isIp ? "IP" : "fingerprint"}
          </h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Future matches lock withdrawals and open review. Existing linked
            profiles are surfaced without a mass action. KYC is never automatic.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${kind}-identifier`}>{label}</Label>
          <Input
            id={`${kind}-identifier`}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={isIp ? "203.0.113.8 or 2001:db8::/64" : "visitor identifier"}
            autoComplete="off"
            spellCheck={false}
            disabled={isPending}
          />
        </div>
        {isIp && (
          <div className="space-y-2">
            <Label>Match scope</Label>
            <Select
              value={matchMode}
              onValueChange={(next) => {
                if (next === "exact" || next === "cidr") setMatchMode(next);
              }}
              disabled={isPending}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="exact">Exact address</SelectItem>
                <SelectItem value="cidr">CIDR network</SelectItem>
              </SelectContent>
            </Select>
            {matchMode === "cidr" && (
              <p className="text-xs text-amber-700 dark:text-amber-300">
                Networks can affect many legitimate users. Confirm the prefix
                and review the affected-account count after saving.
              </p>
            )}
          </div>
        )}
        <Button type="submit" className="w-full" disabled={isPending}>
          {isPending ? <Loader2 className="size-4 animate-spin" /> : <Ban className="size-4" />}
          Block {isIp ? "IP" : "fingerprint"}
        </Button>
      </form>

      <section className="overflow-hidden rounded-xl border border-border/60 bg-card">
        <div className="flex items-center justify-between gap-2 border-b border-border/60 px-4 py-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <ShieldCheck className="size-4 text-cyan-500" />
            {isIp ? "IP" : "Fingerprint"} rules
          </h2>
          <span className="text-[10px] font-semibold uppercase tracking-wide tabular-nums text-muted-foreground">
            {rules.length} {rules.length === 1 ? "rule" : "rules"}
          </span>
        </div>
        {rules.length === 0 ? (
          <div className="px-4 py-14 text-center">
            <Icon className="mx-auto mb-3 size-6 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              No {isIp ? "IPs" : "fingerprints"} are blocked.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border/60">
            {rules.map((rule) => (
              <div
                key={rule.id}
                className="grid gap-3 px-4 py-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="break-all font-mono text-sm font-semibold">
                      {rule.value}
                    </span>
                    <Badge variant="outline">{rule.matchMode}</Badge>
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
                  </div>
                  <p className="text-[11px] tabular-nums text-muted-foreground">
                    {rule.matchCount} detections · {rule.affectedUsers} users ·{" "}
                    {rule.matches24h}/24h · {rule.matches7d}/7d ·{" "}
                    {rule.matches30d}/30d · {rule.lockReviewCount} lock/review ·{" "}
                    {rule.reviewOnlyCount} historical review
                  </p>
                  <div className="flex flex-wrap gap-3 text-[11px] text-muted-foreground">
                    <span>Updated {formatRelative(rule.updatedAt)}</span>
                    {rule.lastMatchAt && (
                      <span>Last match {formatRelative(rule.lastMatchAt)}</span>
                    )}
                  </div>
                </div>
                <Button
                  type="button"
                  variant={rule.enabled ? "outline" : "destructive"}
                  size="sm"
                  disabled={isPending}
                  onClick={() => toggle(rule)}
                >
                  {rule.enabled ? "Disable" : "Reactivate"}
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
