"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
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
  const [reason, setReason] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [isPending, startTransition] = useTransition();
  const isIp = kind === "ip";
  const Icon = isIp ? Network : Fingerprint;
  const label = isIp ? "IP or network" : "Fingerprint identifier";

  function add(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!value.trim() || reason.trim().length < 4) {
      toast.error(`Enter a ${label.toLowerCase()} and an internal reason.`);
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
          reason: reason.trim(),
          expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
          confirmed: true,
          idempotencyKey: crypto.randomUUID(),
        });
        setRules((current) => [
          saved,
          ...current.filter((rule) => rule.id !== saved.id),
        ]);
        setValue("");
        setReason("");
        setExpiresAt("");
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
    const updateReason = window.prompt(
      rule.enabled
        ? "Why are you disabling this rule?"
        : "Why are you reactivating this rule?",
    );
    if (!updateReason || updateReason.trim().length < 4) return;
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
          reason: updateReason.trim(),
          expiresAt: rule.expiresAt,
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
      <form onSubmit={add} className="h-fit space-y-4 rounded-xl border bg-card p-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Icon className="size-4 text-rose-500" />
          Add blocked {isIp ? "IP" : "fingerprint"}
        </h2>
        <p className="text-xs leading-5 text-muted-foreground">
          Future matches lock withdrawals and open review. Existing linked
          profiles are surfaced without a mass action. KYC is never automatic.
        </p>
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
        <div className="space-y-2">
          <Label htmlFor={`${kind}-reason`}>Internal reason</Label>
          <Input
            id={`${kind}-reason`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={500}
            placeholder="Evidence supporting this restriction"
            disabled={isPending}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${kind}-expiry`}>Optional expiry</Label>
          <Input
            id={`${kind}-expiry`}
            type="datetime-local"
            value={expiresAt}
            onChange={(event) => setExpiresAt(event.target.value)}
            disabled={isPending}
          />
          <p className="text-xs text-muted-foreground">
            Blank keeps the rule permanent.
          </p>
        </div>
        <Button type="submit" className="w-full" disabled={isPending}>
          {isPending ? <Loader2 className="size-4 animate-spin" /> : <Ban className="size-4" />}
          Block {isIp ? "IP" : "fingerprint"}
        </Button>
      </form>

      <section className="overflow-hidden rounded-xl border bg-card">
        <div className="border-b px-4 py-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <ShieldCheck className="size-4 text-cyan-500" />
            {isIp ? "IP" : "Fingerprint"} rules
          </h2>
        </div>
        {rules.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">
            No {isIp ? "IPs" : "fingerprints"} are blocked.
          </p>
        ) : (
          <div className="divide-y">
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
                  <p className="text-xs text-muted-foreground">{rule.reason}</p>
                  <p className="text-[11px] text-muted-foreground">
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
                    {rule.affectedUsers > 0 && (
                      <Link
                        href={`/antifraud/profiles?blocklist=${encodeURIComponent(rule.id)}`}
                        className="text-cyan-600 hover:underline dark:text-cyan-400"
                      >
                        Open affected profiles
                      </Link>
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
