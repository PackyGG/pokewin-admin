"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Ban, Fingerprint, Loader2, Network, ShieldAlert, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { clientActionError } from "@/lib/errors/client-action-error";

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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { IdentifierBlocklistKind, IdentifierBlocklistRule } from "@/lib/antifraud/identifier-blocklists-api";
import { formatRelative } from "@/lib/utils/format";
import { addIdentifierBlocklistRule, setIdentifierBlocklistRuleEffect, setIdentifierBlocklistRuleState } from "./identifier-blocklist-actions";

export function IdentifierBlocklistClient({ kind, initialRules }: {
  kind: IdentifierBlocklistKind;
  initialRules: IdentifierBlocklistRule[];
}) {
  const router = useRouter();
  const [rules, setRules] = useState(initialRules);
  const [value, setValue] = useState("");
  const [matchMode, setMatchMode] = useState<"exact" | "cidr">("exact");
  // Confirmation state for the three destructive flows. Replaces the native
  // window.confirm calls — identical wording, identical arguments.
  const [pendingValue, setPendingValue] = useState<string | null>(null);
  const [pendingToggle, setPendingToggle] = useState<IdentifierBlocklistRule | null>(null);
  const [pendingMove, setPendingMove] = useState<IdentifierBlocklistRule | null>(null);
  const [isPending, startTransition] = useTransition();
  const isIp = kind === "ip";
  const Icon = isIp ? Network : Fingerprint;
  const label = isIp ? "IP or network" : "Fingerprint identifier";

  function saveLocal(saved: IdentifierBlocklistRule) {
    setRules((current) => [saved, ...current.filter((rule) => rule.id !== saved.id)]);
    router.refresh();
  }

  function add(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!value.trim()) return toast.error(`Enter a ${label.toLowerCase()}.`);
    setPendingValue(value.trim());
  }

  function confirmAdd() {
    const submitted = pendingValue;
    if (!submitted) return;
    setPendingValue(null);
    startTransition(async () => {
      try {
        const result = await addIdentifierBlocklistRule({ kind, value: submitted, matchMode: isIp ? matchMode : "exact", confirmed: true, idempotencyKey: crypto.randomUUID() });
        if (!result.success) {
          toast.error(result.error);
          return;
        }
        const saved = result.data;
        saveLocal(saved);
        setValue("");
        toast.success(`${saved.value} is now blocked.`);
      } catch (error) {
        toast.error(clientActionError(error, "The rule could not be added."));
      }
    });
  }

  function toggle(rule: IdentifierBlocklistRule) {
    setPendingToggle(rule);
  }

  function confirmToggle() {
    const rule = pendingToggle;
    if (!rule) return;
    setPendingToggle(null);
    startTransition(async () => {
      try {
        const result = await setIdentifierBlocklistRuleState({ kind, id: rule.id, enabled: !rule.enabled, effect: rule.effect, confirmed: true, idempotencyKey: crypto.randomUUID() });
        if (!result.success) {
          toast.error(result.error);
          return;
        }
        const saved = result.data;
        saveLocal(saved);
        toast.success(saved.enabled ? "Rule reactivated." : "Rule disabled.");
      } catch (error) {
        toast.error(clientActionError(error, "The rule could not be changed."));
      }
    });
  }

  function nextEffect(rule: IdentifierBlocklistRule): "block" | "known_vpn" {
    return rule.effect === "block" ? "known_vpn" : "block";
  }

  function move(rule: IdentifierBlocklistRule) {
    setPendingMove(rule);
  }

  function confirmMove() {
    const rule = pendingMove;
    if (!rule) return;
    const effect = nextEffect(rule);
    setPendingMove(null);
    startTransition(async () => {
      try {
        const result = await setIdentifierBlocklistRuleEffect({ kind, id: rule.id, enabled: rule.enabled, effect, confirmed: true, idempotencyKey: crypto.randomUUID() });
        if (!result.success) {
          toast.error(result.error);
          return;
        }
        const saved = result.data;
        saveLocal(saved);
        toast.success(effect === "known_vpn" ? "IP moved to Known VPN." : "Hard blocking restored.");
      } catch (error) {
        toast.error(clientActionError(error, "The policy could not be changed."));
      }
    });
  }

  function rulesSection(sectionRules: IdentifierBlocklistRule[], title: string, knownVpn = false) {
    const SectionIcon = knownVpn ? ShieldAlert : ShieldCheck;
    return (
      <section className="overflow-hidden rounded-xl border border-border/60 bg-card">
        <div className="border-b border-border/60 px-4 py-3">
          <SectionHeading
            icon={SectionIcon}
            title={title}
            action={<span className="text-[10px] font-semibold uppercase tracking-wide tabular-nums text-muted-foreground">{sectionRules.length} {sectionRules.length === 1 ? "rule" : "rules"}</span>}
          />
          {knownVpn && <p className="mt-1 text-xs text-muted-foreground">Adds 15 risk points to signup and Fiat checks. Never directly bans, locks, or opens review.</p>}
        </div>
        {sectionRules.length === 0 ? (
          <EmptyState icon={SectionIcon} title={knownVpn ? "No IPs are classified as known VPNs." : `No ${isIp ? "IPs" : "fingerprints"} are blocked.`} compact />
        ) : (
          <div className="divide-y divide-border/60">
            {sectionRules.map((rule) => (
              <div key={rule.id} className="grid gap-3 px-4 py-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="break-all font-mono text-sm font-semibold">{rule.value}</span>
                    <Badge variant="outline">{rule.matchMode}</Badge>
                    <Badge variant="outline" className={rule.enabled ? (knownVpn ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300" : "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400") : ""}>{rule.enabled ? (knownVpn ? "Risk only" : "Blocking") : "Disabled"}</Badge>
                    {isIp && <Badge variant="outline" className={rule.vpnStatus === "detected" ? "border-purple-500/30 bg-purple-500/10 text-purple-700 dark:text-purple-300" : ""}>{rule.vpnStatus === "detected" ? "VPN/proxy detected" : "VPN evidence unknown"}</Badge>}
                  </div>
                  {rule.vpnStatus === "detected" && <p className="text-[11px] text-purple-700 dark:text-purple-300">Provider evidence: {rule.vpnProviders.join(", ") || "stored provider signal"}{rule.vpnLastDetectedAt ? ` · ${formatRelative(rule.vpnLastDetectedAt)}` : ""}</p>}
                  <p className="text-[11px] tabular-nums text-muted-foreground">{rule.matchCount} detections · {rule.affectedUsers} users · {rule.matches24h}/24h · {rule.matches7d}/7d · {rule.matches30d}/30d · {rule.lockReviewCount} lock/review · {rule.reviewOnlyCount} historical review</p>
                  <div className="flex flex-wrap gap-3 text-[11px] text-muted-foreground"><span>Updated {formatRelative(rule.updatedAt)}</span>{rule.lastMatchAt && <span>Last match {formatRelative(rule.lastMatchAt)}</span>}</div>
                </div>
                <div className="flex flex-wrap gap-2 lg:justify-end">
                  {isIp && <Button type="button" variant="outline" size="sm" disabled={isPending} onClick={() => move(rule)}>{knownVpn ? "Restore blocking" : "Move to known VPN"}</Button>}
                  <Button type="button" variant={rule.enabled ? "outline" : "destructive"} size="sm" disabled={isPending} onClick={() => toggle(rule)}>{rule.enabled ? "Disable" : "Reactivate"}</Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    );
  }

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,0.7fr)_minmax(0,1.3fr)]">
      <form onSubmit={add} className="h-fit space-y-4 rounded-xl border border-border/60 bg-card p-3 sm:p-4">
        <div><SectionHeading icon={Icon} title={`Add blocked ${isIp ? "IP" : "fingerprint"}`} /><p className="mt-1 text-xs leading-5 text-muted-foreground">Future matches lock withdrawals and open review. Existing linked profiles are surfaced without a mass action. KYC is never automatic.</p></div>
        <div className="space-y-2"><Label htmlFor={`${kind}-identifier`}>{label}</Label><Input id={`${kind}-identifier`} value={value} onChange={(event) => setValue(event.target.value)} placeholder={isIp ? "203.0.113.8 or 2001:db8::/64" : "visitor identifier"} autoComplete="off" spellCheck={false} disabled={isPending} /></div>
        {isIp && <div className="space-y-2"><Label>Match scope</Label><Select value={matchMode} onValueChange={(next) => { if (next === "exact" || next === "cidr") setMatchMode(next); }} disabled={isPending}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="exact">Exact address</SelectItem><SelectItem value="cidr">CIDR network</SelectItem></SelectContent></Select>{matchMode === "cidr" && <p className="text-xs text-amber-700 dark:text-amber-300">Networks can affect many legitimate users. Confirm the prefix and review the affected-account count after saving.</p>}</div>}
        <Button type="submit" className="w-full" disabled={isPending}>{isPending ? <Loader2 className="size-4 motion-safe:animate-spin" /> : <Ban className="size-4" />}Block {isIp ? "IP" : "fingerprint"}</Button>
      </form>
      <div className="space-y-5">
        {rulesSection(rules.filter((rule) => rule.effect === "block"), `${isIp ? "IP" : "Fingerprint"} blocking rules`)}
        {isIp && rulesSection(rules.filter((rule) => rule.effect === "known_vpn"), "Known VPN", true)}
      </div>

      <AlertDialog
        open={pendingValue !== null}
        onOpenChange={(open) => {
          if (!open && !isPending) setPendingValue(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Block this {isIp ? "IP/network" : "fingerprint"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Existing matches will be added for review only.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <p className="break-all font-mono text-sm font-semibold">
            {pendingValue ?? ""}
          </p>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={confirmAdd}
              disabled={isPending || !pendingValue}
            >
              Block {isIp ? "IP" : "fingerprint"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={pendingToggle !== null}
        onOpenChange={(open) => {
          if (!open && !isPending) setPendingToggle(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingToggle
                ? `${pendingToggle.enabled ? "Disable" : "Reactivate"} ${pendingToggle.value}?`
                : ""}
            </AlertDialogTitle>
            <AlertDialogDescription>
              The change is recorded in the Antifraud audit.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant={pendingToggle?.enabled ? "default" : "destructive"}
              onClick={confirmToggle}
              disabled={isPending || !pendingToggle}
            >
              {pendingToggle?.enabled ? "Disable" : "Reactivate"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={pendingMove !== null}
        onOpenChange={(open) => {
          if (!open && !isPending) setPendingMove(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingMove
                ? nextEffect(pendingMove) === "known_vpn"
                  ? `Move ${pendingMove.value} to Known VPN?`
                  : `Restore hard blocking for ${pendingMove.value}?`
                : ""}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingMove && nextEffect(pendingMove) === "known_vpn"
                ? "It will add 15 risk points but will no longer directly ban, lock, or open review."
                : "Future matches can lock withdrawals and open review."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmMove}
              disabled={isPending || !pendingMove}
            >
              {pendingMove && nextEffect(pendingMove) === "known_vpn"
                ? "Move to known VPN"
                : "Restore blocking"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
