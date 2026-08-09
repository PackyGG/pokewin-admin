"use client";

import { useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Ban, Fingerprint, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
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
import { formatCurrency } from "@/lib/utils/format";
import type { FingerprintAltAccount } from "@/lib/queries/user-fingerprint-alts";
import {
  banFingerprintAltAccounts,
  fetchFingerprintAltAccounts,
} from "./actions";

const MAX_ALT_BAN = 250;

function initials(account: FingerprintAltAccount): string {
  return (account.username ?? account.email ?? "?").slice(0, 2).toUpperCase();
}

export function FingerprintAltDialog({
  sourceUserId,
  children,
  className,
  title = "View fingerprint-linked accounts",
}: {
  sourceUserId: string;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [accounts, setAccounts] = useState<FingerprintAltAccount[] | null>(null);
  const [canBulkBan, setCanBulkBan] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState("");
  const [loading, startLoading] = useTransition();
  const [banning, startBanning] = useTransition();
  const router = useRouter();

  const load = () => {
    startLoading(async () => {
      const result = await fetchFingerprintAltAccounts(sourceUserId);
      if (!result.success) {
        toast.error(result.error);
        setAccounts([]);
        return;
      }
      setAccounts(result.data.accounts);
      setCanBulkBan(result.data.canBulkBan);
      setSelected(new Set());
      setConfirm("");
    });
  };

  const eligibleIds = (accounts ?? [])
    .filter((account) => account.canBan)
    .map((account) => account.id);

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else if (next.size < MAX_ALT_BAN) next.add(id);
      return next;
    });
  };

  const ban = (ids: string[]) => {
    if (confirm !== "BAN" || ids.length === 0 || banning) return;
    startBanning(async () => {
      const result = await banFingerprintAltAccounts({
        sourceUserId,
        userIds: ids,
      });
      if (!result.success) {
        toast.error(result.error);
        load();
        return;
      }

      const failedIds = new Set(result.data.failed.map((failure) => failure.userId));
      const bannedIds = new Set(ids.filter((id) => !failedIds.has(id)));
      setAccounts((current) =>
        (current ?? []).map((account) =>
          bannedIds.has(account.id)
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
      setConfirm("");
      router.refresh();

      if (result.data.failed.length > 0) {
        toast.warning(
          `Banned ${result.data.bannedCount}; ${result.data.failed.length} failed. Refresh and review the remaining accounts.`,
        );
      } else {
        toast.success(
          `Banned ${result.data.bannedCount} fingerprint-linked account${result.data.bannedCount === 1 ? "" : "s"}.`,
        );
      }
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next && accounts === null && !loading) load();
      }}
    >
      <DialogTrigger
        className={className}
        title={title}
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </DialogTrigger>

      <DialogContent className="sm:max-w-3xl">
        <DialogTitle className="flex items-center gap-2">
          <Fingerprint className="size-4 text-rose-500" />
          Fingerprint-linked accounts
        </DialogTitle>
        <DialogDescription>
          Accounts below share at least one verified Fingerprint visitor ID
          with this user. Deposit totals use the canonical net-credit figure.
        </DialogDescription>

        {loading || accounts === null ? (
          <div className="flex min-h-36 items-center justify-center text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />
            Loading linked accounts…
          </div>
        ) : accounts.length === 0 ? (
          <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            No other account currently shares this user&apos;s captured device IDs.
          </div>
        ) : (
          <>
            <div className="max-h-[52vh] space-y-2 overflow-y-auto pr-1">
              {accounts.map((account) => (
                <div
                  key={account.id}
                  className="grid grid-cols-[auto_minmax(0,1fr)] gap-3 rounded-lg border p-3 sm:grid-cols-[auto_minmax(0,1fr)_auto_auto] sm:items-center"
                >
                  {canBulkBan ? (
                    <Checkbox
                      checked={selected.has(account.id)}
                      disabled={!account.canBan || banning}
                      onCheckedChange={() => toggle(account.id)}
                      aria-label={`Select ${account.username ?? account.email ?? account.id}`}
                    />
                  ) : (
                    <span className="size-4" aria-hidden="true" />
                  )}
                  <Link
                    href={`/users/${account.id}`}
                    target="_blank"
                    className="flex min-w-0 items-center gap-3 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Avatar className="size-10 shrink-0">
                      {account.image && <AvatarImage src={account.image} alt="" />}
                      <AvatarFallback>{initials(account)}</AvatarFallback>
                    </Avatar>
                    <div className="min-w-0">
                      <div className="truncate font-medium hover:underline">
                        {account.username ?? "No username"}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {account.email ?? "No email"}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        <Badge variant="outline" className="text-[10px]">
                          {account.sharedDeviceCount} shared device
                          {account.sharedDeviceCount === 1 ? "" : "s"}
                        </Badge>
                        {account.protectedReason && (
                          <Badge
                            variant="outline"
                            className="border-amber-500/30 text-[10px] text-amber-600 dark:text-amber-400"
                          >
                            {account.protectedReason}
                          </Badge>
                        )}
                      </div>
                    </div>
                  </Link>
                  <div className="tabular-nums sm:text-right">
                    <div className="text-xs text-muted-foreground">Deposits</div>
                    <div className="font-medium">
                      {formatCurrency(account.totalDeposited)}
                    </div>
                  </div>
                  <div className="tabular-nums sm:min-w-24 sm:text-right">
                    <div className="text-xs text-muted-foreground">Wagered</div>
                    <div className="font-medium">
                      {formatCurrency(account.totalWagered)}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {canBulkBan && eligibleIds.length > 0 && (
              <div className="space-y-3 rounded-lg border border-rose-500/25 bg-rose-500/5 p-3">
                <div>
                  <div className="font-medium text-rose-600 dark:text-rose-400">
                    Ban linked accounts
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Type BAN to enable the actions. Protected and already-banned
                    accounts are never included.
                  </p>
                </div>
                <Input
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                  placeholder="Type BAN"
                  disabled={banning}
                />
                <div className="flex flex-wrap justify-end gap-2">
                  <Button
                    variant="destructive"
                    disabled={confirm !== "BAN" || selected.size === 0 || banning}
                    onClick={() => ban([...selected])}
                  >
                    {banning ? <Loader2 className="animate-spin" /> : <Ban />}
                    Ban selected ({selected.size})
                  </Button>
                  <Button
                    variant="destructive"
                    disabled={
                      confirm !== "BAN" ||
                      banning ||
                      eligibleIds.length > MAX_ALT_BAN
                    }
                    onClick={() => ban(eligibleIds)}
                    title={
                      eligibleIds.length > MAX_ALT_BAN
                        ? `Ban all is limited to ${MAX_ALT_BAN} accounts; select a reviewed subset`
                        : undefined
                    }
                  >
                    {banning ? <Loader2 className="animate-spin" /> : <Ban />}
                    Ban all ({eligibleIds.length})
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
