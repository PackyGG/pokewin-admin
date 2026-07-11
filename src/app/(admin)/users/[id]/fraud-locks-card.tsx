"use client";

/**
 * Fraud-signal deposit + withdrawal locks — applied by the game backend when
 * a card deposit is refunded or disputed (see fraud-locks-actions.ts). This
 * is distinct from the manual FeatureLocksCard toggle switches above it,
 * which cover inventory sales / exchanges / openings / vault and are written
 * directly to the admin's own DB.
 *
 * `data === null` means the backend read failed (endpoint isn't deployed
 * yet, or the request errored) — render a muted "awaiting backend deploy"
 * state rather than crashing the Account tab, same convention as the
 * wager-requirement card.
 */

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { AlertTriangle, ShieldAlert } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { clearUserFraudLocksAction } from "./fraud-locks-actions";
import type { UserFeatureLocks } from "@/lib/backend-api/feature-locks";

function listOrNone(items: string[]): string {
  return items.length > 0 ? items.join(", ") : "none";
}

function isLocked(data: UserFeatureLocks): boolean {
  return (
    data.locked_deposits_crypto.length > 0 ||
    data.locked_deposits_fiat.length > 0 ||
    data.locked_withdrawals_crypto.length > 0 ||
    data.locked_withdrawals_items
  );
}

export function FraudLocksCard({
  userId,
  data,
  canManage,
}: {
  userId: string;
  data: UserFeatureLocks | null;
  canManage: boolean;
}) {
  const [isPending, startTransition] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [localData, setLocalData] = useState<UserFeatureLocks | null>(data);

  useEffect(() => {
    if (isPending) return;
    setLocalData(data);
  }, [data, isPending]);

  if (!localData) {
    return (
      <Card className="border-dashed">
        <CardContent>
          <div className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="size-4 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-medium">Backend not updated yet</p>
              <p className="text-amber-600/80 dark:text-amber-400/80">
                The fraud-locks endpoints aren&apos;t reachable on the
                current backend deploy.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  const locked = isLocked(localData);

  const handleClear = () => {
    startTransition(async () => {
      const result = await clearUserFraudLocksAction(userId);
      if (result.success) {
        setLocalData(result.data);
        toast.success("Fraud locks cleared — deposits & withdrawals re-enabled");
      } else {
        toast.error(result.error);
      }
      setConfirmOpen(false);
    });
  };

  return (
    <Card>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">Status</span>
          <Badge
            variant="outline"
            className={
              locked
                ? "bg-rose-500/15 text-rose-600 dark:text-rose-400"
                : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
            }
          >
            {locked ? "Locked" : "Open"}
          </Badge>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 text-xs">
          <div className="rounded-md border bg-muted/30 px-2.5 py-1.5 space-y-0.5">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Deposits locked
            </div>
            <div className="font-medium">
              crypto: {listOrNone(localData.locked_deposits_crypto)}
            </div>
            <div className="font-medium">
              fiat: {listOrNone(localData.locked_deposits_fiat)}
            </div>
            {localData.locked_deposits_reason && (
              <div className="text-muted-foreground">
                reason: {localData.locked_deposits_reason}
              </div>
            )}
            {localData.locked_deposits_at && (
              <div className="text-muted-foreground">
                since: {new Date(localData.locked_deposits_at).toLocaleString()}
              </div>
            )}
          </div>

          <div className="rounded-md border bg-muted/30 px-2.5 py-1.5 space-y-0.5">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Withdrawals locked
            </div>
            <div className="font-medium">
              crypto: {listOrNone(localData.locked_withdrawals_crypto)}
            </div>
            <div className="font-medium">
              items: {localData.locked_withdrawals_items ? "yes" : "no"}
            </div>
            {localData.locked_withdrawals_reason && (
              <div className="text-muted-foreground">
                reason: {localData.locked_withdrawals_reason}
              </div>
            )}
            {localData.locked_withdrawals_at && (
              <div className="text-muted-foreground">
                since:{" "}
                {new Date(localData.locked_withdrawals_at).toLocaleString()}
              </div>
            )}
          </div>
        </div>

        {canManage && locked && (
          <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
            <AlertDialogTrigger
              render={
                <Button size="sm" variant="outline" disabled={isPending} />
              }
            >
              <ShieldAlert className="mr-1 h-3 w-3" />
              {isPending ? "Working…" : "Clear fraud locks"}
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Clear fraud locks?</AlertDialogTitle>
                <AlertDialogDescription>
                  Re-enables deposits and withdrawals for this user. Use this
                  once you&apos;ve manually resolved the underlying
                  refund/chargeback — it does not reverse any ban or balance
                  change made separately.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={isPending}>
                  Cancel
                </AlertDialogCancel>
                <Button disabled={isPending} onClick={handleClear}>
                  {isPending ? "Clearing…" : "Clear locks"}
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </CardContent>
    </Card>
  );
}
