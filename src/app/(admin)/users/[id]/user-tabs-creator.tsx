"use client";

import React, { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Loader2,
  Pencil,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { formatCurrency, formatDateTime } from "@/lib/utils/format";
import {
  assignAffiliateCode,
  createAffiliateCode,
  fetchCreatorClicks,
  fetchCreatorCodeUsages,
  transferAffiliateCode,
  updateWithdrawalLimits,
} from "./actions";
import type {
  CreatorData,
  UserDetail,
  WithdrawalLimits,
} from "./user-tabs-types";
import { InfoRow } from "./user-tabs-shared";

/* ── Creator Section ── */

export const CreatorSection = React.memo(function CreatorSection({
  user,
  creatorData,
  affiliate,
}: {
  user: UserDetail["user"];
  creatorData: CreatorData;
  affiliate: UserDetail["affiliate"];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [codeInput, setCodeInput] = useState("");
  const [setCodeOpen, setSetCodeOpen] = useState(false);

  // affiliate_code on user table may be null even when affiliate_accounts exists
  const effectiveCode = user.affiliateCode ?? affiliate?.code ?? null;

  const handleAssign = () => {
    startTransition(async () => {
      try {
        await assignAffiliateCode(user.id, codeInput.trim());
        toast.success("Affiliate code assigned");
        setCodeInput("");
        router.refresh();
      } catch (e) {
        toast.error(
          e instanceof Error ? e.message : "Failed to assign affiliate code",
        );
      }
    });
  };

  const handleClear = () => {
    startTransition(async () => {
      try {
        await assignAffiliateCode(user.id, null);
        toast.success("Affiliate code cleared");
        setCodeInput("");
        router.refresh();
      } catch (e) {
        toast.error(
          e instanceof Error ? e.message : "Failed to clear affiliate code",
        );
      }
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">
          Affiliate & Referral
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Zone 1 — Info grid */}
        <div
          className={`grid gap-6 ${effectiveCode && affiliate ? "lg:grid-cols-3 md:grid-cols-2" : effectiveCode || affiliate ? "md:grid-cols-2" : ""}`}
        >
          {/* Column 1: Referral */}
          <div className="space-y-2.5">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
              Referral
            </p>
            {user.referredBy ? (
              <InfoRow
                label="Referred By"
                value={
                  <Link
                    href={`/users/${user.referredBy}`}
                    className="text-blue-400 hover:underline"
                  >
                    {user.referredByUsername}
                  </Link>
                }
              />
            ) : (
              <p className="text-sm text-muted-foreground">Not referred</p>
            )}
            <div className="pt-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                Assign Affiliate Code
              </p>
              <div className="flex items-center gap-2">
                <Input
                  placeholder="Enter code"
                  value={codeInput}
                  onChange={(e) => setCodeInput(e.target.value)}
                  className="h-8 w-40 text-sm"
                  disabled={isPending}
                />
                <Button
                  size="sm"
                  disabled={isPending || !codeInput.trim()}
                  onClick={handleAssign}
                >
                  {isPending ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    "Save"
                  )}
                </Button>
                {user.referredBy && (
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={isPending}
                    onClick={handleClear}
                  >
                    Clear
                  </Button>
                )}
              </div>
            </div>
          </div>

          {/* Column 2: Affiliate Code */}
          {effectiveCode ? (
            <div className="space-y-2.5">
              <div className="flex items-center justify-between gap-2 mb-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Affiliate Code
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 gap-1.5 text-xs"
                  onClick={() => setSetCodeOpen(true)}
                >
                  <Pencil className="size-3" />
                  Change
                </Button>
              </div>
              <InfoRow label="Code" value={effectiveCode} mono />
              <InfoRow
                label="Status"
                value={
                  <Badge
                    variant="outline"
                    className={
                      user.affiliateCodeActive
                        ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                        : "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400"
                    }
                  >
                    {user.affiliateCodeActive ? "Active" : "Inactive"}
                  </Badge>
                }
              />
              {user.affiliateCodeExpiresAt && (
                <InfoRow
                  label="Expires"
                  value={formatDateTime(user.affiliateCodeExpiresAt)}
                />
              )}
              <InfoRow
                label="Bonus Opted In"
                value={user.affiliateBonusOptedIn ? "Yes" : "No"}
              />
            </div>
          ) : (
            <div className="space-y-2.5">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                Affiliate Code
              </p>
              <p className="text-sm text-muted-foreground">
                No affiliate code yet
              </p>
              <Button
                size="sm"
                onClick={() => setSetCodeOpen(true)}
                disabled={isPending}
              >
                Set Affiliate Code
              </Button>
            </div>
          )}

          {/* Column 3: Affiliate Stats (only if affiliate data exists) */}
          {affiliate && (
            <div className="space-y-2.5">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                Affiliate Stats
              </p>
              <InfoRow
                label="Total Referred"
                value={String(affiliate.totalReferred)}
              />
              <InfoRow
                label="Wager Volume"
                value={formatCurrency(affiliate.totalWagerVolumeUsd)}
              />
              <InfoRow
                label="Total Earned"
                value={formatCurrency(affiliate.totalEarnedUsd)}
              />
              <InfoRow
                label="Available"
                value={formatCurrency(affiliate.availableUsd)}
              />
              <InfoRow
                label="Paid Out"
                value={formatCurrency(affiliate.totalPaidOutUsd)}
              />
              <InfoRow
                label="Bonus Distributed"
                value={formatCurrency(affiliate.totalBonusDistributedUsd)}
              />
              {affiliate.lastPayoutAt && (
                <InfoRow
                  label="Last Payout"
                  value={formatDateTime(affiliate.lastPayoutAt)}
                />
              )}
            </div>
          )}
        </div>

        {/* Zone 2 — Tables (only when user has an affiliate code) */}
        {effectiveCode && (
          <>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                Referral Clicks ({creatorData.clicks.total})
              </p>
              <ReferralClicksTable
                affiliateCode={effectiveCode}
                initialData={creatorData.clicks}
              />
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                Code Usages ({creatorData.usages.total})
              </p>
              <CodeUsagesTable
                userId={user.id}
                initialData={creatorData.usages}
              />
            </div>
          </>
        )}

        {/* Zone 3 — Withdrawal Limits (only for creators) */}
        {user.role === "creator" && (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
              Withdrawal Limits
            </p>
            <WithdrawalLimitsCard
              userId={user.id}
              limits={creatorData.withdrawalLimits}
            />
          </div>
        )}
      </CardContent>
      <SetAffiliateCodeDialog
        open={setCodeOpen}
        onOpenChange={setSetCodeOpen}
        userId={user.id}
        currentUsername={user.username ?? user.email ?? null}
      />
    </Card>
  );
});

// ─────────────────────────────────────────────────────────────────────
//  Set Affiliate Code Dialog — handles the create flow with conflict
//  detection. If the entered code is already owned by another user,
//  the dialog flips into "transfer mode": shows the current owner and
//  lets the admin transfer the code (the previous owner gets a random
//  replacement code so they're never codeless).
// ─────────────────────────────────────────────────────────────────────

export function SetAffiliateCodeDialog({
  open,
  onOpenChange,
  userId,
  currentUsername,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  userId: string;
  currentUsername: string | null;
}) {
  const router = useRouter();
  const [codeValue, setCodeValue] = useState("");
  const [conflict, setConflict] = useState<{
    code: string;
    currentOwnerId: string;
    currentOwnerUsername: string | null;
    currentOwnerEmail: string | null;
  } | null>(null);
  const [isPending, startTransition] = useTransition();

  // Reset on (re-)open so a stale conflict from a previous attempt
  // doesn't persist into the next dialog session.
  useEffect(() => {
    if (open) {
      setCodeValue("");
      setConflict(null);
    }
  }, [open]);

  function close() {
    onOpenChange(false);
  }

  function handleSubmit() {
    const trimmed = codeValue.trim();
    if (!trimmed) {
      toast.error("Enter a code");
      return;
    }
    startTransition(async () => {
      try {
        const result = await createAffiliateCode(userId, trimmed);
        if ("conflict" in result && result.conflict) {
          setConflict(result.conflict);
          return;
        }
        if (!result.success) {
          const msg =
            "error" in result ? result.error : "Failed to set affiliate code";
          toast.error(msg);
          return;
        }
        toast.success(`Affiliate code "${trimmed}" set`);
        close();
        router.refresh();
      } catch (e) {
        toast.error(
          e instanceof Error ? e.message : "Failed to set affiliate code",
        );
      }
    });
  }

  function handleTransfer() {
    if (!conflict) return;
    startTransition(async () => {
      const result = await transferAffiliateCode({
        toUserId: userId,
        code: conflict.code,
      });
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      const fromLabel =
        conflict.currentOwnerUsername ??
        conflict.currentOwnerEmail ??
        conflict.currentOwnerId.slice(0, 8);
      toast.success(
        `Transferred "${conflict.code}" from @${fromLabel} → @${
          currentUsername ?? userId.slice(0, 8)
        }. Their replacement code: ${result.replacementCode}`,
        { duration: 8000 },
      );
      close();
      router.refresh();
    });
  }

  const ownerLabel = conflict
    ? conflict.currentOwnerUsername ??
      conflict.currentOwnerEmail ??
      conflict.currentOwnerId.slice(0, 8)
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {conflict ? "Code is already taken" : "Set affiliate code"}
          </DialogTitle>
        </DialogHeader>
        {!conflict ? (
          <div className="space-y-3 py-2">
            <p className="text-xs text-muted-foreground">
              Sets this user&apos;s personal affiliate / referral code.
              If the code is already owned by another user we&apos;ll
              show you who has it and offer a transfer.
            </p>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Code</Label>
              <Input
                placeholder="e.g. POKEMASTER"
                value={codeValue}
                onChange={(e) => setCodeValue(e.target.value)}
                className="font-mono"
                autoFocus
                disabled={isPending}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && codeValue.trim() && !isPending) {
                    handleSubmit();
                  }
                }}
              />
            </div>
          </div>
        ) : (
          <div className="space-y-3 py-2">
            <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
              <div className="space-y-1 text-sm">
                <p>
                  <span className="font-mono font-medium">
                    {conflict.code}
                  </span>{" "}
                  is currently owned by{" "}
                  <Link
                    href={`/users/${conflict.currentOwnerId}`}
                    className="font-medium text-blue-500 hover:underline"
                  >
                    @{ownerLabel}
                  </Link>
                  .
                </p>
                <p className="text-xs text-muted-foreground">
                  Transferring moves the CODE STRING only. Their
                  historical referrals + earnings stay attributed to
                  them. They&apos;ll get a random replacement code so
                  they&apos;re never codeless.
                </p>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Transfer{" "}
              <span className="font-mono font-medium text-foreground">
                {conflict.code}
              </span>{" "}
              to{" "}
              <span className="font-medium text-foreground">
                @{currentUsername ?? userId.slice(0, 8)}
              </span>
              ?
            </p>
          </div>
        )}
        <DialogFooter>
          {!conflict ? (
            <>
              <Button
                variant="ghost"
                onClick={close}
                disabled={isPending}
              >
                Cancel
              </Button>
              <Button
                onClick={handleSubmit}
                disabled={isPending || !codeValue.trim()}
              >
                {isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  "Set code"
                )}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                onClick={() => setConflict(null)}
                disabled={isPending}
              >
                Back
              </Button>
              <Button
                onClick={handleTransfer}
                disabled={isPending}
                className="bg-amber-600 hover:bg-amber-600/90 text-white"
              >
                {isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  "Transfer to this user"
                )}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReferralClicksTable({
  affiliateCode,
  initialData,
}: {
  affiliateCode: string | null;
  initialData: CreatorData["clicks"];
}) {
  const [data, setData] = useState(initialData);
  const [page, setPage] = useState(initialData.page);
  const [isPending, startTransition] = useTransition();

  if (!affiliateCode) {
    return (
      <p className="text-sm text-muted-foreground">
        No affiliate code configured
      </p>
    );
  }

  function goToPage(p: number) {
    setPage(p);
    startTransition(async () => {
      const result = await fetchCreatorClicks(affiliateCode!, p, 20);
      setData(result);
    });
  }

  return (
    <div className="space-y-2">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>IP</TableHead>
            <TableHead>Country</TableHead>
            <TableHead>Region</TableHead>
            <TableHead>City</TableHead>
            <TableHead>User Agent</TableHead>
            <TableHead>Date</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.data.map((click) => (
            <TableRow key={click.id}>
              <TableCell className="font-mono text-xs">{click.ip}</TableCell>
              <TableCell>{click.country}</TableCell>
              <TableCell>{click.region}</TableCell>
              <TableCell>{click.city}</TableCell>
              <TableCell
                className="max-w-[200px] truncate text-xs"
                title={click.userAgent ?? ""}
              >
                {click.userAgent ?? "-"}
              </TableCell>
              <TableCell>
                {click.createdAt ? formatDateTime(click.createdAt) : "-"}
              </TableCell>
            </TableRow>
          ))}
          {data.data.length === 0 && (
            <TableRow>
              <TableCell
                colSpan={6}
                className="h-24 text-center text-muted-foreground"
              >
                No clicks yet.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      {data.totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{data.total} total clicks</span>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={page <= 1 || isPending}
              onClick={() => goToPage(1)}
            >
              <ChevronsLeft className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={page <= 1 || isPending}
              onClick={() => goToPage(page - 1)}
            >
              <ChevronLeft className="size-3.5" />
            </Button>
            <span className="px-2">
              Page {page} of {data.totalPages}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={page >= data.totalPages || isPending}
              onClick={() => goToPage(page + 1)}
            >
              <ChevronRight className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={page >= data.totalPages || isPending}
              onClick={() => goToPage(data.totalPages)}
            >
              <ChevronsRight className="size-3.5" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function CodeUsagesTable({
  userId,
  initialData,
}: {
  userId: string;
  initialData: CreatorData["usages"];
}) {
  const [data, setData] = useState(initialData);
  const [page, setPage] = useState(initialData.page);
  const [isPending, startTransition] = useTransition();

  function goToPage(p: number) {
    setPage(p);
    startTransition(async () => {
      const result = await fetchCreatorCodeUsages(userId, p, 20);
      setData(result);
    });
  }

  return (
    <div className="space-y-2">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>User</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Deposit</TableHead>
            <TableHead>Wager</TableHead>
            <TableHead>Referrer Cut</TableHead>
            <TableHead>User Bonus</TableHead>
            <TableHead>Date</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.data.map((u) => (
            <TableRow key={u.id}>
              <TableCell>
                <Link
                  href={`/users/${u.referredUserId}`}
                  className="hover:underline"
                >
                  {u.referredUsername ?? u.referredUserId.slice(0, 8)}
                </Link>
              </TableCell>
              <TableCell>
                <Badge variant="outline">{u.usageType}</Badge>
              </TableCell>
              <TableCell>{formatCurrency(u.depositAmountUsd)}</TableCell>
              <TableCell>{formatCurrency(u.wagerAmountUsd)}</TableCell>
              {/* Referrer cut is commission PAID OUT by the house →
                  house loss → rose per CLAUDE.md (not green). */}
              <TableCell className="text-rose-600 dark:text-rose-400">
                {formatCurrency(u.referrerCutUsd)}
              </TableCell>
              <TableCell>{formatCurrency(u.userBonusUsd)}</TableCell>
              <TableCell>{formatDateTime(u.createdAt)}</TableCell>
            </TableRow>
          ))}
          {data.data.length === 0 && (
            <TableRow>
              <TableCell
                colSpan={7}
                className="h-24 text-center text-muted-foreground"
              >
                No code usages yet.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      {data.totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{data.total} total usages</span>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={page <= 1 || isPending}
              onClick={() => goToPage(1)}
            >
              <ChevronsLeft className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={page <= 1 || isPending}
              onClick={() => goToPage(page - 1)}
            >
              <ChevronLeft className="size-3.5" />
            </Button>
            <span className="px-2">
              Page {page} of {data.totalPages}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={page >= data.totalPages || isPending}
              onClick={() => goToPage(page + 1)}
            >
              <ChevronRight className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={page >= data.totalPages || isPending}
              onClick={() => goToPage(data.totalPages)}
            >
              <ChevronsRight className="size-3.5" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function WithdrawalLimitsCard({
  userId,
  limits,
}: {
  userId: string;
  limits: WithdrawalLimits;
}) {
  const [editOpen, setEditOpen] = useState(false);

  return (
    <div className="space-y-3">
      {limits ? (
        <>
          <InfoRow
            label="Currency Limit Amount"
            value={
              limits.currencyLimitAmount != null
                ? formatCurrency(limits.currencyLimitAmount)
                : "-"
            }
          />
          <InfoRow
            label="Limit Start Date"
            value={
              limits.currencyLimitStartDate
                ? formatDateTime(limits.currencyLimitStartDate)
                : "-"
            }
          />
          <InfoRow
            label="Reset Days"
            value={
              limits.currencyLimitResetDays != null
                ? String(limits.currencyLimitResetDays)
                : "-"
            }
          />
          <InfoRow
            label="Percentage Limit"
            value={
              limits.percentageLimit != null
                ? `${(limits.percentageLimit * 100).toFixed(2)}%`
                : "-"
            }
          />
        </>
      ) : (
        <p className="text-sm text-muted-foreground">No limits configured</p>
      )}
      <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
        {limits ? "Edit Limits" : "Set Limits"}
      </Button>
      <WithdrawalLimitsDialog
        userId={userId}
        limits={limits}
        open={editOpen}
        onOpenChange={setEditOpen}
      />
    </div>
  );
}

function WithdrawalLimitsDialog({
  userId,
  limits,
  open,
  onOpenChange,
}: {
  userId: string;
  limits: WithdrawalLimits;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [amount, setAmount] = useState(
    limits?.currencyLimitAmount != null
      ? String(limits.currencyLimitAmount)
      : "",
  );
  const [startDate, setStartDate] = useState(
    limits?.currencyLimitStartDate
      ? limits.currencyLimitStartDate.slice(0, 16)
      : "",
  );
  const [resetDays, setResetDays] = useState(
    limits?.currencyLimitResetDays != null
      ? String(limits.currencyLimitResetDays)
      : "",
  );
  const [percentage, setPercentage] = useState(
    limits?.percentageLimit != null ? String(limits.percentageLimit * 100) : "",
  );
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  useEffect(() => {
    if (open) {
      setAmount(
        limits?.currencyLimitAmount != null
          ? String(limits.currencyLimitAmount)
          : "",
      );
      setStartDate(
        limits?.currencyLimitStartDate
          ? limits.currencyLimitStartDate.slice(0, 16)
          : "",
      );
      setResetDays(
        limits?.currencyLimitResetDays != null
          ? String(limits.currencyLimitResetDays)
          : "",
      );
      setPercentage(
        limits?.percentageLimit != null
          ? String(limits.percentageLimit * 100)
          : "",
      );
    }
  }, [open, limits]);

  function handleSave() {
    startTransition(async () => {
      try {
        await updateWithdrawalLimits({
          userId,
          currencyLimitAmount: amount ? parseFloat(amount) : null,
          currencyLimitStartDate: startDate || null,
          currencyLimitResetDays: resetDays ? parseInt(resetDays, 10) : null,
          percentageLimit: percentage ? parseFloat(percentage) / 100 : null,
        });
        toast.success("Withdrawal limits updated");
        onOpenChange(false);
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to update limits");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Withdrawal Limits</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              Currency Limit Amount
            </Label>
            <Input
              type="number"
              placeholder="e.g. 1000"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Start Date</Label>
            <Input
              type="datetime-local"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Reset Days</Label>
            <Input
              type="number"
              placeholder="e.g. 30"
              value={resetDays}
              onChange={(e) => setResetDays(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              Percentage Limit (%)
            </Label>
            <Input
              type="number"
              step="0.01"
              placeholder="e.g. 5.00"
              value={percentage}
              onChange={(e) => setPercentage(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={isPending}
            className="w-full"
          >
            {isPending ? "Saving..." : "Save Limits"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
