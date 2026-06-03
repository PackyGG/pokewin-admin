"use client";

import { useState, useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Eraser,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  ArrowRight,
  Wallet,
  Archive,
  Package,
  Info,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { formatCurrency, formatDateTime } from "@/lib/utils/format";
import { WIPE_PRESERVED_SUMMARY } from "@/lib/account-wipes/protected";
import {
  previewBalanceWipe,
  previewVaultWipe,
  previewInventoryWipe,
  wipeBalance,
  wipeVault,
  wipeInventory,
  type InventorySourceBreakdown,
} from "./wipe-account-targets-actions";

// House-POV (CLAUDE.md): the user's spendable balance, their vault, and their
// inventory are all value the user HOLDS — i.e. value WE owe them. The user
// being "up" = our liability → ROSE. A wipe REMOVES that value (reduces what
// we owe → good for the house), so the amount-removed figures are rendered in
// rose to match how the adjustments wipe colors clawed-back credits.
const ROSE = "text-rose-500 dark:text-rose-400";

type WipeTarget = "balance" | "vault" | "inventory";

// Per-target preview payloads, normalized to what the dialog renders.
type LoadedPreview =
  | { kind: "balance"; amount: number; dealBalanceDisclosure: boolean }
  | { kind: "vault"; amount: number; unlockAt: string | null; dealBalanceDisclosure: boolean }
  | { kind: "inventory"; count: number; value: number; bySource: InventorySourceBreakdown[] };

type TargetConfig = {
  icon: LucideIcon;
  buttonLabel: string;
  title: string;
  /** One-line description shown in the select phase. */
  blurb: string;
  /** Loads the preview; returns a normalized LoadedPreview or an error. */
  load: (userId: string) => Promise<{ ok: true; preview: LoadedPreview } | { ok: false; error: string }>;
  /** Runs the wipe; returns a success toast message or an error. */
  run: (userId: string, totpCode: string) => Promise<{ ok: true; toast: string } | { ok: false; error: string }>;
  /** True when there's nothing to wipe (disables the Review button). */
  isEmpty: (p: LoadedPreview) => boolean;
};

const TARGETS: Record<WipeTarget, TargetConfig> = {
  balance: {
    icon: Wallet,
    buttonLabel: "Wipe Balance",
    title: "Wipe Spendable Balance",
    blurb:
      "Sets the user's spendable balance (available_balance) to $0. The current amount is snapshotted first, so this is fully recoverable. No ledger row is written (snapshot + reset, same as the adjustments wipe); the user's remaining ledger history keeps its original balance figures.",
    load: async (userId) => {
      const res = await previewBalanceWipe(userId);
      if (!res.success) return { ok: false, error: res.error };
      return {
        ok: true,
        preview: {
          kind: "balance",
          amount: res.preview.availableBalance,
          dealBalanceDisclosure: res.preview.dealBalanceDisclosure,
        },
      };
    },
    run: async (userId, totpCode) => {
      const res = await wipeBalance({ userId, totpCode });
      if (!res.success) return { ok: false, error: res.error };
      return { ok: true, toast: `Wiped ${formatCurrency(res.amountRemoved)} spendable balance` };
    },
    isEmpty: (p) => p.kind === "balance" && p.amount <= 0,
  },
  vault: {
    icon: Archive,
    buttonLabel: "Wipe Vault",
    title: "Wipe Vault (Locked Balance)",
    blurb:
      "Sets the user's vault (locked_balance) to $0 and clears its unlock window. The locked amount + unlock time are snapshotted first, so this is fully recoverable. No ledger row is written (snapshot + reset).",
    load: async (userId) => {
      const res = await previewVaultWipe(userId);
      if (!res.success) return { ok: false, error: res.error };
      return {
        ok: true,
        preview: {
          kind: "vault",
          amount: res.preview.lockedBalance,
          unlockAt: res.preview.unlockAt,
          dealBalanceDisclosure: res.preview.dealBalanceDisclosure,
        },
      };
    },
    run: async (userId, totpCode) => {
      const res = await wipeVault({ userId, totpCode });
      if (!res.success) return { ok: false, error: res.error };
      return { ok: true, toast: `Wiped ${formatCurrency(res.amountRemoved)} from vault` };
    },
    isEmpty: (p) => p.kind === "vault" && p.amount <= 0,
  },
  inventory: {
    icon: Package,
    buttonLabel: "Wipe Inventory",
    title: "Wipe Inventory",
    blurb:
      "Hard-deletes every item in the user's inventory (user_inventory rows). The full rows are snapshotted first, so the items can be restored. Note: this also removes those items' provably-fair results (historical, not re-created on restore), and the item values feed the GGR inventory payout metric — see the audit log.",
    load: async (userId) => {
      const res = await previewInventoryWipe(userId);
      if (!res.success) return { ok: false, error: res.error };
      return {
        ok: true,
        preview: {
          kind: "inventory",
          count: res.preview.itemCount,
          value: res.preview.totalValue,
          bySource: res.preview.bySource,
        },
      };
    },
    run: async (userId, totpCode) => {
      const res = await wipeInventory({ userId, totpCode });
      if (!res.success) return { ok: false, error: res.error };
      return {
        ok: true,
        toast: `Wiped ${res.deletedCount} item${res.deletedCount === 1 ? "" : "s"} (${formatCurrency(res.totalValue)})`,
      };
    },
    isEmpty: (p) => p.kind === "inventory" && p.count <= 0,
  },
};

// ───────────────────────────────────────────────────────────────────────────
// Entry buttons — one per target, rendered in the moderation toolbar next to
// "Wipe Adjustments" / "Wipe Account". Admin-gated upstream; the server
// actions re-check regardless.
// ───────────────────────────────────────────────────────────────────────────

function WipeTargetButton({ userId, target }: { userId: string; target: WipeTarget }) {
  const [open, setOpen] = useState(false);
  const cfg = TARGETS[target];
  const Icon = cfg.icon;
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5 border-rose-500/40 text-rose-500 hover:bg-rose-500/10 hover:text-rose-500 dark:text-rose-400"
        onClick={() => setOpen(true)}
      >
        <Icon className="size-3.5" />
        {cfg.buttonLabel}
      </Button>
      <WipeTargetDialog userId={userId} target={target} open={open} onOpenChange={setOpen} />
    </>
  );
}

export function WipeBalanceButton({ userId }: { userId: string }) {
  return <WipeTargetButton userId={userId} target="balance" />;
}
export function WipeVaultButton({ userId }: { userId: string }) {
  return <WipeTargetButton userId={userId} target="vault" />;
}
export function WipeInventoryButton({ userId }: { userId: string }) {
  return <WipeTargetButton userId={userId} target="inventory" />;
}

type Phase = "review" | "confirm";

function WipeTargetDialog({
  userId,
  target,
  open,
  onOpenChange,
}: {
  userId: string;
  target: WipeTarget;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const cfg = TARGETS[target];
  const Icon = cfg.icon;
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [preview, setPreview] = useState<LoadedPreview | null>(null);
  const [phase, setPhase] = useState<Phase>("review");
  const [totpCode, setTotpCode] = useState("");
  const [isPending, startTransition] = useTransition();

  // Lazy-load the preview when the dialog opens (hidden-component rule — never
  // preload on page render). Reset everything on close.
  useEffect(() => {
    if (!open) {
      setPreview(null);
      setPhase("review");
      setTotpCode("");
      setLoadError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    cfg
      .load(userId)
      .then((res) => {
        if (cancelled) return;
        if (!res.ok) {
          setLoadError(res.error);
          setPreview(null);
          return;
        }
        setPreview(res.preview);
      })
      .catch((e) => {
        if (cancelled) return;
        setLoadError(e instanceof Error ? e.message : "Failed to load");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, userId, cfg]);

  const empty = preview ? cfg.isEmpty(preview) : true;

  function handleWipe() {
    if (!totpCode.trim()) {
      toast.error("Enter your 2FA code");
      return;
    }
    startTransition(async () => {
      try {
        const res = await cfg.run(userId, totpCode.trim());
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        toast.success(res.toast);
        onOpenChange(false);
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to wipe");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon className="size-4 text-rose-500" />
            {phase === "review" ? cfg.title : "Confirm Wipe"}
          </DialogTitle>
          <DialogDescription>
            {phase === "review" ? cfg.blurb : "Review the figures below, then enter your 2FA code to confirm."}
          </DialogDescription>
        </DialogHeader>

        {/* Figures */}
        <div className="rounded-md border bg-muted/30 p-3 text-sm">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-4 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading…
            </div>
          ) : loadError ? (
            <div className="py-2 text-center text-rose-500">{loadError}</div>
          ) : preview ? (
            <PreviewBody preview={preview} />
          ) : null}
        </div>

        {phase === "confirm" && preview && (
          <div className="space-y-3">
            {/* WILL DELETE — itemized, unmissable, before the 2FA field. */}
            <WillDeletePanel preview={preview} />

            {/* WILL NOT TOUCH — explicit preserved reassurance. */}
            <PreservedPanel />

            <div className="rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-sm">
              <p className="flex items-center gap-2 font-medium text-rose-400">
                <ShieldAlert className="size-4" />
                This is destructive but recoverable — the snapshot is written first.
              </p>
            </div>
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
                autoFocus
              />
            </div>
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          {phase === "review" ? (
            <Button
              size="sm"
              variant="destructive"
              className="w-full sm:w-auto"
              disabled={loading || !!loadError || empty}
              onClick={() => setPhase("confirm")}
            >
              Review
              <ArrowRight className="ml-1.5 size-3.5" />
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                variant="outline"
                className="w-full sm:w-auto"
                onClick={() => setPhase("review")}
                disabled={isPending}
              >
                Back
              </Button>
              <Button
                size="sm"
                variant="destructive"
                className="w-full sm:w-auto"
                onClick={handleWipe}
                disabled={isPending || !totpCode.trim()}
              >
                {isPending ? (
                  <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                ) : (
                  <Eraser className="mr-1.5 size-3.5" />
                )}
                {isPending ? "Wiping…" : cfg.buttonLabel}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PreviewBody({ preview }: { preview: LoadedPreview }) {
  if (preview.kind === "balance") {
    return (
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground">Spendable balance to remove</span>
        <span className={`font-semibold tabular-nums ${ROSE}`}>{formatCurrency(preview.amount)}</span>
      </div>
    );
  }
  if (preview.kind === "vault") {
    return (
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Vault (locked) to remove</span>
          <span className={`font-semibold tabular-nums ${ROSE}`}>{formatCurrency(preview.amount)}</span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Unlock window</span>
          <span className="text-foreground/80">
            {preview.unlockAt ? formatDateTime(preview.unlockAt) : "None (unlock-anytime)"}
          </span>
        </div>
      </div>
    );
  }
  // inventory
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground">Items to delete</span>
        <span className="font-semibold tabular-nums text-foreground">{preview.count.toLocaleString()}</span>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground">Total value being removed</span>
        <span className={`font-semibold tabular-nums ${ROSE}`}>{formatCurrency(preview.value)}</span>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Pre-approval panels (Task 2): an unmissable, itemized "WILL DELETE" list and
// an explicit "WILL NOT TOUCH" reassurance, both shown in the confirm phase
// BEFORE the 2FA field. House-POV colors (rose = value the user holds that we
// remove; emerald = preserved/safe).
// ───────────────────────────────────────────────────────────────────────────

/** Human label for a user_inventory.source_type value. */
function sourceLabel(source: string): string {
  switch (source) {
    case "pack":
      return "Pack openings";
    case "battle":
      return "Battle wins";
    case "reward":
      return "Reward cards";
    case "exchange":
      return "Exchanges";
    case "raffle":
      return "Raffle wins";
    case "upgrader":
      return "Upgrader wins";
    default:
      return source;
  }
}

function WillDeletePanel({ preview }: { preview: LoadedPreview }) {
  return (
    <div className="rounded-md border border-rose-500/30 bg-rose-500/[0.06] p-3 space-y-2 text-sm">
      <p className="flex items-center gap-2 font-semibold text-rose-500 dark:text-rose-400">
        <Eraser className="size-4" />
        Will be removed
      </p>

      {preview.kind === "balance" && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Spendable balance</span>
            <span className={`font-semibold tabular-nums ${ROSE}`}>
              {formatCurrency(preview.amount)} → {formatCurrency(0)}
            </span>
          </div>
          {preview.dealBalanceDisclosure && <FungibleDisclosure pool="spendable balance" />}
        </div>
      )}

      {preview.kind === "vault" && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Vault (locked balance)</span>
            <span className={`font-semibold tabular-nums ${ROSE}`}>
              {formatCurrency(preview.amount)} → {formatCurrency(0)}
            </span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Unlock window</span>
            <span className="text-foreground/80">
              {preview.unlockAt ? `${formatDateTime(preview.unlockAt)} → cleared` : "None (unlock-anytime)"}
            </span>
          </div>
          {preview.dealBalanceDisclosure && <FungibleDisclosure pool="vault" />}
        </div>
      )}

      {preview.kind === "inventory" && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">
              {preview.count.toLocaleString()} item{preview.count === 1 ? "" : "s"} · total value
            </span>
            <span className={`font-semibold tabular-nums ${ROSE}`}>{formatCurrency(preview.value)}</span>
          </div>
          {/* Per-source itemization — proves every row is a won/granted card
              (no creator-deal source exists in inventory). */}
          <div className="rounded border bg-background/50 divide-y">
            {preview.bySource.map((s) => (
              <div key={s.source} className="flex items-center justify-between px-2.5 py-1.5 text-xs">
                <span className="text-muted-foreground">{sourceLabel(s.source)}</span>
                <span className="tabular-nums text-foreground/80">
                  {s.count.toLocaleString()} · {formatCurrency(s.value)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Disclosure for the fungible balance/vault pools (Task 2 / protected.ts). */
function FungibleDisclosure({ pool }: { pool: string }) {
  return (
    <p className="flex items-start gap-1.5 rounded border border-amber-500/30 bg-amber-500/[0.06] px-2.5 py-1.5 text-xs text-amber-600 dark:text-amber-400">
      <Info className="mt-0.5 size-3.5 shrink-0" />
      <span>
        This is a single fungible {pool}. If any creator-deal payout was redeemed/converted into it,
        that portion is included here — fungible balance can&apos;t be separated by source.
      </span>
    </p>
  );
}

/** Explicit "what is preserved" reassurance — same promise the server guards enforce. */
function PreservedPanel() {
  return (
    <div className="rounded-md border border-emerald-500/30 bg-emerald-500/[0.05] p-3 text-sm">
      <p className="flex items-start gap-2 text-emerald-600 dark:text-emerald-400">
        <ShieldCheck className="mt-0.5 size-4 shrink-0" />
        <span>
          <span className="font-semibold">Will NOT be touched.</span> {WIPE_PRESERVED_SUMMARY}
        </span>
      </p>
    </div>
  );
}
