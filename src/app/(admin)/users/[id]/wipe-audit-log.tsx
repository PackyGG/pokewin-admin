"use client";

import { useState, useEffect, useCallback, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  History,
  RotateCcw,
  Loader2,
  Wallet,
  Archive,
  Package,
  SlidersHorizontal,
  ArrowDownToLine,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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
import { formatCurrency, formatDateTime, formatRelative } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import {
  listBalanceAdjustmentWipes,
  restoreBalanceAdjustmentWipe,
} from "./wipe-adjustments-actions";
import {
  listAccountWipes,
  restoreAccountWipe,
  type AccountWipeRecord,
} from "./wipe-account-targets-actions";

// House-POV: every wiped row removed value the user HELD (money / items we
// owed) → the user was "up" → ROSE for the removed magnitude.
const ROSE = "text-rose-500 dark:text-rose-400";

// One unified entry across BOTH snapshot stores (legacy adjustments wipes +
// the generalized balance/vault/inventory/deposits wipes). `source` tells the
// Restore button which server action to call.
type WipeKind = "adjustments" | "balance" | "vault" | "inventory" | "deposits";

type UnifiedWipe = {
  id: string;
  source: "adjustments" | "account";
  kind: WipeKind;
  wipedAt: string;
  wipedByLabel: string;
  /** Money removed; 0 for inventory. */
  amount: number;
  /** Rows removed; 0 for money wipes. */
  itemCount: number;
  restoredAt: string | null;
  restoredByLabel: string | null;
};

const KIND_META: Record<WipeKind, { icon: LucideIcon; label: string }> = {
  adjustments: { icon: SlidersHorizontal, label: "Balance adjustments" },
  balance: { icon: Wallet, label: "Spendable balance" },
  vault: { icon: Archive, label: "Vault (locked)" },
  inventory: { icon: Package, label: "Inventory" },
  deposits: { icon: ArrowDownToLine, label: "Deposits" },
};

// ───────────────────────────────────────────────────────────────────────────
// Unified wipe audit log — replaces the old RecoverableWipesStrip. Reads BOTH
// the legacy adjustments-wipe store AND the generalized account-wipe store,
// merges them newest-first, and offers a 2FA-gated Restore on every
// non-restored entry. Self-fetching + lazy (the Moderation tab only mounts
// when the Account tab is opened, so this never loads on the initial page
// render). Renders nothing while loading or when the user has no wipe history.
// ───────────────────────────────────────────────────────────────────────────

export function WipeAuditLog({ userId }: { userId: string }) {
  const [wipes, setWipes] = useState<UnifiedWipe[] | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    Promise.all([
      listBalanceAdjustmentWipes(userId).catch(() => []),
      listAccountWipes(userId).catch(() => [] as AccountWipeRecord[]),
    ])
      .then(([adjWipes, acctWipes]) => {
        if (cancelled) return;
        const merged: UnifiedWipe[] = [
          ...adjWipes.map((w) => ({
            id: w.id,
            source: "adjustments" as const,
            kind: "adjustments" as const,
            wipedAt: w.wipedAt,
            wipedByLabel: w.wipedByLabel,
            amount: w.totalAmount,
            itemCount: w.adjustmentCount,
            restoredAt: w.restoredAt,
            restoredByLabel: w.restoredByLabel,
          })),
          ...acctWipes.map((w) => ({
            id: w.id,
            source: "account" as const,
            kind: w.wipeType,
            wipedAt: w.wipedAt,
            wipedByLabel: w.wipedByLabel,
            amount: w.amount,
            itemCount: w.itemCount,
            restoredAt: w.restoredAt,
            restoredByLabel: w.restoredByLabel,
          })),
        ].sort((a, b) => b.wipedAt.localeCompare(a.wipedAt));
        setWipes(merged);
      })
      .catch(() => {
        if (!cancelled) setWipes([]);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  useEffect(() => load(), [load]);

  // Nothing until loaded; stay invisible when there's no wipe history (the
  // common case) so the Moderation tab isn't cluttered.
  if (!wipes || wipes.length === 0) return null;

  return (
    <div className="rounded-md border border-amber-500/30 bg-amber-500/[0.04] p-3 space-y-2">
      <div className="flex items-center gap-2 text-xs font-medium text-amber-500 dark:text-amber-400">
        <History className="size-3.5" />
        Wipe history ({wipes.length})
      </div>
      <div className="space-y-1.5">
        {wipes.map((w) => (
          <WipeRow key={`${w.source}:${w.id}`} wipe={w} onRestored={load} />
        ))}
      </div>
    </div>
  );
}

function WipeRow({ wipe, onRestored }: { wipe: UnifiedWipe; onRestored: () => void }) {
  const meta = KIND_META[wipe.kind];
  const Icon = meta.icon;
  // What was removed: items for inventory, money for everything else.
  const removed =
    wipe.kind === "inventory"
      ? `${wipe.itemCount} item${wipe.itemCount === 1 ? "" : "s"}`
      : formatCurrency(wipe.amount);

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-background/60 px-3 py-2 text-xs">
      <div className="min-w-0 space-y-0.5">
        <div className="flex items-center gap-1.5 text-foreground">
          <Icon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">{meta.label}</span>
          <span className="text-muted-foreground">·</span>
          <span className={cn("font-semibold tabular-nums", ROSE)}>{removed}</span>
          {(wipe.kind === "adjustments" || wipe.kind === "deposits") && (
            <span className="text-muted-foreground">
              ({wipe.itemCount} row{wipe.itemCount === 1 ? "" : "s"})
            </span>
          )}
        </div>
        <div className="text-[11px] text-muted-foreground">
          {formatRelative(wipe.wipedAt)} by {wipe.wipedByLabel}
          <span className="text-foreground/40"> · {formatDateTime(wipe.wipedAt)}</span>
        </div>
      </div>
      {wipe.restoredAt ? (
        <Badge
          variant="outline"
          className="border-emerald-500/30 text-emerald-600 dark:text-emerald-400"
        >
          Restored {formatRelative(wipe.restoredAt)}
          {wipe.restoredByLabel ? ` · ${wipe.restoredByLabel}` : ""}
        </Badge>
      ) : (
        <RestoreButton wipe={wipe} onRestored={onRestored} />
      )}
    </div>
  );
}

function RestoreButton({ wipe, onRestored }: { wipe: UnifiedWipe; onRestored: () => void }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [totpCode, setTotpCode] = useState("");
  const [isPending, startTransition] = useTransition();

  const meta = KIND_META[wipe.kind];
  const removedLabel =
    wipe.kind === "inventory"
      ? `${wipe.itemCount} item${wipe.itemCount === 1 ? "" : "s"}`
      : formatCurrency(wipe.amount);

  // Per-kind restore copy so the admin knows exactly what comes back.
  const restoreEffect =
    wipe.kind === "adjustments"
      ? `re-inserts ${wipe.itemCount} deleted ledger row${wipe.itemCount === 1 ? "" : "s"} and adds ${formatCurrency(wipe.amount)} back to the balance`
      : wipe.kind === "balance"
        ? `adds ${formatCurrency(wipe.amount)} back to the user's spendable balance`
        : wipe.kind === "vault"
          ? `adds ${formatCurrency(wipe.amount)} back to the user's vault and restores its unlock window`
          : wipe.kind === "deposits"
            ? `re-inserts ${wipe.itemCount} deleted deposit ledger row${wipe.itemCount === 1 ? "" : "s"} (${formatCurrency(wipe.amount)}) and re-adds the lifetime deposited counter`
            : `re-inserts the ${wipe.itemCount} deleted inventory item${wipe.itemCount === 1 ? "" : "s"}`;

  function handleRestore() {
    if (!totpCode.trim()) {
      toast.error("Enter your 2FA code");
      return;
    }
    startTransition(async () => {
      try {
        const res =
          wipe.source === "adjustments"
            ? await restoreBalanceAdjustmentWipe(wipe.id, totpCode.trim())
            : await restoreAccountWipe(wipe.id, totpCode.trim());
        if (!res.success) {
          toast.error(res.error);
          return;
        }
        toast.success("Restored");
        setOpen(false);
        setTotpCode("");
        onRestored();
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to restore");
      }
    });
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setTotpCode("");
      }}
    >
      <AlertDialogTrigger
        render={<Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs" />}
      >
        <RotateCcw className="size-3" />
        Restore
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <RotateCcw className="size-4 text-amber-500" />
            Restore {meta.label.toLowerCase()} wipe?
          </AlertDialogTitle>
          <AlertDialogDescription>
            This {restoreEffect}. ({removedLabel} was removed.) Enter your 2FA code to confirm.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">2FA Code</Label>
          <Input
            type="text"
            inputMode="numeric"
            placeholder="Enter your 6-digit code"
            value={totpCode}
            onChange={(e) => setTotpCode(e.target.value)}
            maxLength={6}
            autoComplete="one-time-code"
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button
            onClick={handleRestore}
            disabled={isPending || !totpCode.trim()}
            className="w-full sm:w-auto"
          >
            {isPending ? (
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
            ) : (
              <RotateCcw className="mr-1.5 size-3.5" />
            )}
            {isPending ? "Restoring…" : "Restore"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
