"use client";

import { useRef, useState, useTransition } from "react";
import { Fingerprint, Loader2, Network, UsersRound } from "lucide-react";
import { toast } from "sonner";
import { clientActionError } from "@/lib/errors/client-action-error";

import { HostLink } from "@/components/host-link";
import { StepUpField } from "@/components/step-up-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ANTIFRAUD_BAN_REASON_PRESETS } from "@/lib/ban-reasons";
import type { FingerprintAltAccount } from "@/lib/queries/user-fingerprint-alts";
import { formatCurrency, formatRelative } from "@/lib/utils/format";
import {
  fetchReviewLinkedAccounts,
  massBanReviewLinkedAccounts,
} from "../actions";

const MAX_MASS_BAN = 250;

export function LinkedAccountsDialog({ reviewId }: { reviewId: string }) {
  const [open, setOpen] = useState(false);
  const [accounts, setAccounts] = useState<FingerprintAltAccount[] | null>(null);
  const [canMassBan, setCanMassBan] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reasonOption, setReasonOption] = useState("");
  const [customReason, setCustomReason] = useState("");
  const [credential, setCredential] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, startLoading] = useTransition();
  const [banning, startBanning] = useTransition();
  const idempotencyKey = useRef<string | null>(null);
  const effectiveReason =
    reasonOption === "custom" ? customReason.trim() : reasonOption;

  function load() {
    startLoading(async () => {
      try {
        const result = await fetchReviewLinkedAccounts({ reviewId });
        if (!result.success) {
          setAccounts([]);
          toast.error(result.error);
          return;
        }
        setAccounts(result.data.accounts);
        setCanMassBan(result.data.canMassBan);
        setSelected(new Set());
      } catch (error) {
        setAccounts([]);
        toast.error(clientActionError(error, "Linked accounts could not be loaded"));
      }
    });
  }

  function toggle(userId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(userId)) next.delete(userId);
      else if (next.size < MAX_MASS_BAN) next.add(userId);
      return next;
    });
  }

  function banSelected() {
    if (
      selected.size === 0 ||
      effectiveReason.length < 4 ||
      !credential ||
      confirm !== "BAN SELECTED"
    ) return;
    startBanning(async () => {
      try {
        idempotencyKey.current ??= crypto.randomUUID();
        const result = await massBanReviewLinkedAccounts({
          reviewId,
          userIds: [...selected],
          reason: effectiveReason,
          credential,
          idempotencyKey: idempotencyKey.current,
        });
        if (!result.success) {
          toast.error(result.error);
          return;
        }
        const outcome = result.data;
        const banned = new Set(outcome.bannedUserIds);
        setAccounts((current) =>
          (current ?? []).map((account) =>
            banned.has(account.id)
              ? {
                  ...account,
                  isBanned: true,
                  canBan: false,
                  protectedReason: "Already banned",
                }
              : account,
          ),
        );
        setSelected(new Set());
        setCredential("");
        setConfirm("");
        idempotencyKey.current = null;
        toast.success(`Banned ${outcome.bannedCount} linked account${outcome.bannedCount === 1 ? "" : "s"}.`);
      } catch (error) {
        toast.error(clientActionError(error, "The linked accounts could not be banned"));
      }
    });
  }

  const eligible = (accounts ?? []).filter((account) => account.canBan);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next && accounts === null && !loading) load();
      }}
    >
      <DialogTrigger
        render={
          <Button type="button" size="sm" variant="outline" className="h-8 px-2.5 text-xs" />
        }
      >
        <UsersRound className="size-4" />
        Linked accounts
      </DialogTrigger>
      <DialogContent className="sm:max-w-4xl">
        <DialogTitle className="flex items-center gap-2">
          <UsersRound className="size-4 text-amber-500" />
          Shared IP and fingerprint accounts
        </DialogTitle>
        <DialogDescription>
          Exact signup-IP and high-confidence Fingerprint matches. A match is
          evidence—not proof. Long-standing accounts with normal deposits,
          wagering, and withdrawals may be completely legitimate.
        </DialogDescription>

        {loading || accounts === null ? (
          <div className="flex min-h-40 items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" /> Loading linked accounts…
          </div>
        ) : accounts.length === 0 ? (
          <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            No other account shares this account&apos;s captured device or signup IP.
          </div>
        ) : (
          <>
            <div className="max-h-[48vh] space-y-2 overflow-y-auto pr-1">
              {accounts.map((account) => (
                <div
                  key={account.id}
                  className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[auto_minmax(0,1fr)_repeat(3,minmax(5rem,auto))] sm:items-center"
                >
                  {canMassBan ? (
                    <Checkbox
                      checked={selected.has(account.id)}
                      disabled={!account.canBan || banning}
                      onCheckedChange={() => toggle(account.id)}
                      aria-label={`Select ${account.username ?? account.id}`}
                    />
                  ) : (
                    <span className="size-4" />
                  )}
                  <div className="min-w-0">
                    <HostLink
                      href={`/users/${account.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block truncate text-sm font-semibold hover:underline"
                    >
                      {account.username ?? account.email ?? account.id}
                    </HostLink>
                    <p className="truncate font-mono text-[10px] text-muted-foreground">
                      {account.id}
                    </p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {account.sharedDeviceCount > 0 && (
                        <Badge variant="outline" className="text-[10px]">
                          <Fingerprint className="size-3" /> {account.sharedDeviceCount} device
                        </Badge>
                      )}
                      {account.sharedIp && (
                        <Badge variant="outline" className="text-[10px]">
                          <Network className="size-3" /> Same signup IP
                        </Badge>
                      )}
                      <Badge variant="outline" className="text-[10px]">
                        Joined {formatRelative(account.createdAt)}
                      </Badge>
                      {account.protectedReason && (
                        <Badge className="border-amber-500/30 text-[10px] text-amber-700" variant="outline">
                          {account.protectedReason}
                        </Badge>
                      )}
                    </div>
                  </div>
                  <MoneyFact label="Deposited" value={account.totalDeposited} />
                  <MoneyFact label="Withdrawn" value={account.totalWithdrawn} />
                  <MoneyFact label="Wagered" value={account.totalWagered} />
                </div>
              ))}
            </div>

            {canMassBan && eligible.length > 0 && (
              <div className="space-y-3 rounded-lg border border-rose-500/25 bg-rose-500/5 p-3">
                <div>
                  <p className="text-sm font-semibold text-rose-700 dark:text-rose-300">
                    Ban reviewed selection ({selected.size})
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Only checked accounts are banned. Their shared identifiers
                    are intentionally not blocklisted, so unselected legitimate accounts are unaffected.
                  </p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label>Reason</Label>
                    <Select
                      value={reasonOption || undefined}
                      onValueChange={(value) => setReasonOption(value ?? "")}
                      disabled={banning}
                    >
                      <SelectTrigger><SelectValue placeholder="Select a reason" /></SelectTrigger>
                      <SelectContent>
                        {ANTIFRAUD_BAN_REASON_PRESETS.map((reason) => (
                          <SelectItem key={reason} value={reason}>{reason}</SelectItem>
                        ))}
                        <SelectItem value="custom">Custom reason</SelectItem>
                      </SelectContent>
                    </Select>
                    {reasonOption === "custom" && (
                      <Input
                        value={customReason}
                        onChange={(event) => setCustomReason(event.target.value)}
                        minLength={4}
                        maxLength={500}
                        placeholder="Write the exact reason"
                        disabled={banning}
                      />
                    )}
                  </div>
                  <StepUpField
                    value={credential}
                    onChange={setCredential}
                    disabled={banning}
                    label="Fresh TOTP or passkey"
                  />
                </div>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                  <div className="space-y-1.5 sm:w-64">
                    <Label>Type BAN SELECTED</Label>
                    <Input value={confirm} onChange={(event) => setConfirm(event.target.value)} disabled={banning} />
                  </div>
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={banSelected}
                    disabled={
                      banning || selected.size === 0 || effectiveReason.length < 4 ||
                      !credential || confirm !== "BAN SELECTED"
                    }
                  >
                    {banning ? <Loader2 className="animate-spin" /> : <UsersRound />}
                    Ban selected ({selected.size})
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function MoneyFact({ label, value }: { label: string; value: number }) {
  return (
    <div className="tabular-nums sm:text-right">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className="text-xs font-medium">{formatCurrency(value)}</p>
    </div>
  );
}
