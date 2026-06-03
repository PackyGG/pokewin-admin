"use client";

import {
  useState,
  useEffect,
  useMemo,
  useTransition,
  useCallback,
} from "react";
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
  SlidersHorizontal,
  Info,
  Search,
  CheckCircle2,
  XCircle,
  Trash2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { formatCurrency, formatDateTime, formatRelative } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { WIPE_PRESERVED_SUMMARY } from "@/lib/account-wipes/protected";
import {
  previewBalanceWipe,
  previewVaultWipe,
  previewInventoryWipe,
  wipeBalance,
  wipeVault,
  wipeInventory,
  type InventorySourceBreakdown,
  type InventoryTopItem,
  type InventoryValueTier,
} from "./wipe-account-targets-actions";
import {
  listWipeableAdjustments,
  wipeBalanceAdjustments,
  type WipeableAdjustment,
} from "./wipe-adjustments-actions";

// House-POV (CLAUDE.md): the user's spendable balance, vault, inventory and any
// house-granted balance adjustment are all value the user HOLDS — i.e. value WE
// owe them. The user being "up" = our liability → ROSE. A wipe REMOVES that
// value (reduces what we owe → good for the house), so every removed magnitude
// is rendered in rose, matching the per-mode dialogs this consolidates.
const ROSE = "text-rose-500 dark:text-rose-400";

// The four recoverable, targeted wipe categories the admin can mix-and-match.
// Order is intentional: the row-selectable adjustments first, then the money
// pools, then inventory. Each maps 1:1 onto an EXISTING snapshot-first +
// recoverable server action — this panel only orchestrates the UI + execution
// order, it never re-implements the destructive logic.
type WipeCategory = "adjustments" | "balance" | "vault" | "inventory";

const CATEGORY_ORDER: readonly WipeCategory[] = [
  "adjustments",
  "balance",
  "vault",
  "inventory",
] as const;

const CATEGORY_META: Record<
  WipeCategory,
  { icon: LucideIcon; label: string; blurb: string }
> = {
  adjustments: {
    icon: SlidersHorizontal,
    label: "Content balance adjustments",
    blurb:
      "Admin-granted balance credits you select below. Snapshotted + recoverable.",
  },
  balance: {
    icon: Wallet,
    label: "Balance",
    blurb: "Sets spendable balance to $0. Snapshotted + recoverable.",
  },
  vault: {
    icon: Archive,
    label: "Vault",
    blurb: "Sets the vault (locked balance) to $0 and clears its unlock window.",
  },
  inventory: {
    icon: Package,
    label: "Inventory",
    blurb: "Hard-deletes every inventory item. Snapshotted + recoverable.",
  },
};

// ── Per-category loaded preview payloads (normalized to what this dialog
// renders), mirroring the per-mode dialogs' shapes. ─────────────────────────
type BalancePreview = { amount: number; dealBalanceDisclosure: boolean };
type VaultPreview = {
  amount: number;
  unlockAt: string | null;
  dealBalanceDisclosure: boolean;
};
type InventoryPreview = {
  count: number;
  value: number;
  bySource: InventorySourceBreakdown[];
  topItems: InventoryTopItem[];
  valueTiers: InventoryValueTier[];
};

type LoadState<T> =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; data: T };

// ───────────────────────────────────────────────────────────────────────────
// Entry button — the SINGLE "Wipe data" button that replaces the four separate
// per-category buttons in the moderation toolbar. The OLD full-account
// `WipeAccountButton` (nuclear, non-recoverable) stays a separate button — this
// is the recoverable, targeted, customizable one. Admin-gated upstream; every
// underlying server action re-checks (requireAdmin + __can_wipe_accounts + 2FA)
// regardless.
// ───────────────────────────────────────────────────────────────────────────

export function WipeDataButton({ userId }: { userId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5 border-rose-500/40 text-rose-500 hover:bg-rose-500/10 hover:text-rose-500 dark:text-rose-400"
        onClick={() => setOpen(true)}
      >
        <Eraser className="size-3.5" />
        Wipe data
      </Button>
      <WipeDataDialog userId={userId} open={open} onOpenChange={setOpen} />
    </>
  );
}

type Phase = "select" | "confirm" | "running";

// Per-category execution outcome surfaced in the running/results phase so a
// partial run is fully legible (which succeeded, which failed, which were
// skipped because an earlier one aborted the sequence).
type RunStatus = "pending" | "running" | "success" | "failed" | "skipped";
type RunResult = {
  category: WipeCategory;
  status: RunStatus;
  message: string;
};

function WipeDataDialog({
  userId,
  open,
  onOpenChange,
}: {
  userId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("select");
  const [totpCode, setTotpCode] = useState("");
  const [isPending, startTransition] = useTransition();

  // Which categories are ticked.
  const [checked, setChecked] = useState<Record<WipeCategory, boolean>>({
    adjustments: false,
    balance: false,
    vault: false,
    inventory: false,
  });

  // Lazily-loaded previews — one per category, only fetched when that category
  // is first ticked (hidden-component rule: never preload on page render, and
  // never load a category the admin hasn't selected).
  const [balance, setBalance] = useState<LoadState<BalancePreview> | null>(null);
  const [vault, setVault] = useState<LoadState<VaultPreview> | null>(null);
  const [inventory, setInventory] =
    useState<LoadState<InventoryPreview> | null>(null);

  // Adjustments are row-selectable (not all-or-nothing): load the wipeable
  // credit rows, let the admin pick a subset.
  const [adjState, setAdjState] =
    useState<LoadState<WipeableAdjustment[]> | null>(null);
  const [adjSelected, setAdjSelected] = useState<Set<string>>(new Set());
  const [adjSearch, setAdjSearch] = useState("");

  // Per-category run results in the execute phase.
  const [results, setResults] = useState<RunResult[]>([]);

  // Reset everything on close.
  useEffect(() => {
    if (open) return;
    setPhase("select");
    setTotpCode("");
    setChecked({
      adjustments: false,
      balance: false,
      vault: false,
      inventory: false,
    });
    setBalance(null);
    setVault(null);
    setInventory(null);
    setAdjState(null);
    setAdjSelected(new Set());
    setAdjSearch("");
    setResults([]);
  }, [open]);

  // ── Lazy loaders, fired the first time a category is ticked. ──────────────
  const loadBalance = useCallback(() => {
    setBalance({ status: "loading" });
    previewBalanceWipe(userId)
      .then((res) =>
        setBalance(
          res.success
            ? {
                status: "ready",
                data: {
                  amount: res.preview.availableBalance,
                  dealBalanceDisclosure: res.preview.dealBalanceDisclosure,
                },
              }
            : { status: "error", error: res.error },
        ),
      )
      .catch((e) =>
        setBalance({
          status: "error",
          error: e instanceof Error ? e.message : "Failed to load",
        }),
      );
  }, [userId]);

  const loadVault = useCallback(() => {
    setVault({ status: "loading" });
    previewVaultWipe(userId)
      .then((res) =>
        setVault(
          res.success
            ? {
                status: "ready",
                data: {
                  amount: res.preview.lockedBalance,
                  unlockAt: res.preview.unlockAt,
                  dealBalanceDisclosure: res.preview.dealBalanceDisclosure,
                },
              }
            : { status: "error", error: res.error },
        ),
      )
      .catch((e) =>
        setVault({
          status: "error",
          error: e instanceof Error ? e.message : "Failed to load",
        }),
      );
  }, [userId]);

  const loadInventory = useCallback(() => {
    setInventory({ status: "loading" });
    previewInventoryWipe(userId)
      .then((res) =>
        setInventory(
          res.success
            ? {
                status: "ready",
                data: {
                  count: res.preview.itemCount,
                  value: res.preview.totalValue,
                  bySource: res.preview.bySource,
                  topItems: res.preview.topItems,
                  valueTiers: res.preview.valueTiers,
                },
              }
            : { status: "error", error: res.error },
        ),
      )
      .catch((e) =>
        setInventory({
          status: "error",
          error: e instanceof Error ? e.message : "Failed to load",
        }),
      );
  }, [userId]);

  const loadAdjustments = useCallback(() => {
    setAdjState({ status: "loading" });
    listWipeableAdjustments(userId)
      .then((res) =>
        setAdjState(
          res.success
            ? { status: "ready", data: res.rows }
            : { status: "error", error: res.error },
        ),
      )
      .catch((e) =>
        setAdjState({
          status: "error",
          error: e instanceof Error ? e.message : "Failed to load adjustments",
        }),
      );
  }, [userId]);

  function toggleCategory(cat: WipeCategory, v: boolean) {
    setChecked((prev) => ({ ...prev, [cat]: v }));
    if (!v) return;
    // Kick off the lazy load the first time the category is ticked.
    if (cat === "balance" && balance === null) loadBalance();
    if (cat === "vault" && vault === null) loadVault();
    if (cat === "inventory" && inventory === null) loadInventory();
    if (cat === "adjustments" && adjState === null) loadAdjustments();
  }

  // ── Derived selection / totals ───────────────────────────────────────────
  const adjRows = useMemo(
    () =>
      adjState?.status === "ready" ? adjState.data : ([] as WipeableAdjustment[]),
    [adjState],
  );
  const adjFiltered = useMemo(() => {
    const q = adjSearch.trim().toLowerCase();
    if (!q) return adjRows;
    return adjRows.filter((r) => r.reason.toLowerCase().includes(q));
  }, [adjRows, adjSearch]);
  const adjSelectedRows = useMemo(
    () => adjRows.filter((r) => adjSelected.has(r.id)),
    [adjRows, adjSelected],
  );
  const adjTotal = useMemo(
    () => adjSelectedRows.reduce((acc, r) => acc + r.amount, 0),
    [adjSelectedRows],
  );
  const adjFilteredAllSelected =
    adjFiltered.length > 0 && adjFiltered.every((r) => adjSelected.has(r.id));
  const adjFilteredSomeSelected =
    adjFiltered.some((r) => adjSelected.has(r.id)) && !adjFilteredAllSelected;

  const toggleAdjOne = useCallback((id: string, v: boolean) => {
    setAdjSelected((prev) => {
      const next = new Set(prev);
      if (v) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const toggleAdjAllFiltered = useCallback(
    (v: boolean) => {
      setAdjSelected((prev) => {
        const next = new Set(prev);
        for (const r of adjFiltered) {
          if (v) next.add(r.id);
          else next.delete(r.id);
        }
        return next;
      });
    },
    [adjFiltered],
  );

  // Per-category money/inventory contributions, gated on the category being
  // ticked AND its preview ready. Used for the confirm summary + grand total.
  const balanceAmt =
    checked.balance && balance?.status === "ready" ? balance.data.amount : 0;
  const vaultAmt =
    checked.vault && vault?.status === "ready" ? vault.data.amount : 0;
  const adjAmt = checked.adjustments ? adjTotal : 0;
  // The money grand-total across the selected MONEY categories (balance, vault,
  // selected adjustments). Inventory value is a card-value estimate (different
  // unit) and is surfaced alongside, not folded into this cash figure.
  const moneyTotal = balanceAmt + vaultAmt + adjAmt;
  const invValue =
    checked.inventory && inventory?.status === "ready"
      ? inventory.data.value
      : 0;
  const invCount =
    checked.inventory && inventory?.status === "ready"
      ? inventory.data.count
      : 0;

  // Whether a ticked category actually contributes something to delete. A
  // ticked-but-empty category (e.g. $0 balance) is treated as a no-op rather
  // than producing a guaranteed-failing wipe call.
  const categoryHasContent = useCallback(
    (cat: WipeCategory): boolean => {
      switch (cat) {
        case "balance":
          return balance?.status === "ready" && balance.data.amount > 0;
        case "vault":
          return vault?.status === "ready" && vault.data.amount > 0;
        case "inventory":
          return inventory?.status === "ready" && inventory.data.count > 0;
        case "adjustments":
          return adjSelected.size > 0;
      }
    },
    [balance, vault, inventory, adjSelected],
  );

  // The categories that will actually run: ticked AND non-empty. Drives the
  // Review button's enabled state + the execution loop.
  const runnableCategories = useMemo(
    () => CATEGORY_ORDER.filter((c) => checked[c] && categoryHasContent(c)),
    [checked, categoryHasContent],
  );

  // A ticked category whose preview is still loading blocks Review (we don't
  // know yet whether it has content / what the total is).
  const anyTickedStillLoading = CATEGORY_ORDER.some((c) => {
    if (!checked[c]) return false;
    if (c === "balance") return !balance || balance.status === "loading";
    if (c === "vault") return !vault || vault.status === "loading";
    if (c === "inventory") return !inventory || inventory.status === "loading";
    if (c === "adjustments") return !adjState || adjState.status === "loading";
    return false;
  });

  // A ticked category whose preview errored — block Review and surface it.
  const tickedLoadError = CATEGORY_ORDER.find((c) => {
    if (!checked[c]) return false;
    if (c === "balance") return balance?.status === "error";
    if (c === "vault") return vault?.status === "error";
    if (c === "inventory") return inventory?.status === "error";
    if (c === "adjustments") return adjState?.status === "error";
    return false;
  });

  const canReview =
    runnableCategories.length > 0 && !anyTickedStillLoading && !tickedLoadError;

  // ── Sequential multi-execute. One 2FA code, applied to each selected
  // category's EXISTING action in turn. Each action is independently
  // snapshot-first + recoverable, so a partial run is safe + individually
  // restorable from the wipe audit log. If one fails we ABORT the rest and
  // mark them skipped, then report exactly which succeeded/failed/skipped. ──
  function handleRun() {
    if (!totpCode.trim()) {
      toast.error("Enter your 2FA code");
      return;
    }
    if (runnableCategories.length === 0) {
      toast.error("Nothing selected to wipe");
      return;
    }
    const code = totpCode.trim();
    const seq = runnableCategories;
    const adjIds = Array.from(adjSelected);

    setPhase("running");
    // Seed the results list as all-pending so the UI shows the full plan.
    setResults(
      seq.map((category) => ({
        category,
        status: "pending" as RunStatus,
        message: "",
      })),
    );

    startTransition(async () => {
      const finalResults: RunResult[] = seq.map((category) => ({
        category,
        status: "pending",
        message: "",
      }));

      const commit = () => setResults([...finalResults]);

      let aborted = false;
      for (let i = 0; i < seq.length; i++) {
        const category = seq[i];
        if (aborted) {
          finalResults[i] = {
            category,
            status: "skipped",
            message: "Skipped — an earlier wipe failed",
          };
          commit();
          continue;
        }
        finalResults[i] = { category, status: "running", message: "" };
        commit();

        try {
          const outcome = await runCategory(category, userId, code, adjIds);
          finalResults[i] = outcome.success
            ? { category, status: "success", message: outcome.message }
            : { category, status: "failed", message: outcome.error };
          if (!outcome.success) aborted = true;
        } catch (e) {
          finalResults[i] = {
            category,
            status: "failed",
            message: e instanceof Error ? e.message : "Unexpected error",
          };
          aborted = true;
        }
        commit();
      }

      const succeeded = finalResults.filter((r) => r.status === "success").length;
      const failed = finalResults.filter((r) => r.status === "failed").length;

      if (failed === 0) {
        toast.success(
          succeeded === 1 ? "Wipe complete" : `Wiped ${succeeded} categories`,
        );
      } else if (succeeded > 0) {
        toast.error(
          `${succeeded} wiped, ${failed} failed — see the breakdown. Succeeded wipes are individually restorable.`,
        );
      } else {
        toast.error("Wipe failed — nothing was changed");
      }

      // Always refresh so any committed wipe is reflected. Each successful
      // action already revalidated the page + busted metric caches server-side.
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Eraser className="size-4 text-rose-500" />
            {phase === "select"
              ? "Wipe data"
              : phase === "confirm"
                ? "Confirm wipe"
                : "Wiping…"}
          </DialogTitle>
          <DialogDescription>
            {phase === "select" ? (
              <>
                Select exactly what to remove. Each category is snapshotted first
                and is independently{" "}
                <span className="font-medium text-foreground">recoverable</span>{" "}
                from the wipe history below. Real finance, affiliate and creator
                data can never be wiped (see the protected list).
              </>
            ) : phase === "confirm" ? (
              <>
                Review the combined summary, then enter your 2FA code once to run
                the selected wipes.
              </>
            ) : (
              <>
                Running the selected wipes in order. Each is its own recoverable
                snapshot.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {phase === "select" && (
          <SelectPhase
            checked={checked}
            onToggle={toggleCategory}
            balance={balance}
            vault={vault}
            inventory={inventory}
            adjState={adjState}
            adjFiltered={adjFiltered}
            adjSelected={adjSelected}
            adjSearch={adjSearch}
            setAdjSearch={setAdjSearch}
            adjFilteredAllSelected={adjFilteredAllSelected}
            adjFilteredSomeSelected={adjFilteredSomeSelected}
            toggleAdjOne={toggleAdjOne}
            toggleAdjAllFiltered={toggleAdjAllFiltered}
            adjSelectedCount={adjSelected.size}
            adjTotal={adjTotal}
            tickedLoadError={tickedLoadError}
          />
        )}

        {phase === "confirm" && (
          <ConfirmPhase
            runnableCategories={runnableCategories}
            balanceAmt={balanceAmt}
            vaultAmt={vaultAmt}
            adjAmt={adjAmt}
            adjSelectedRows={adjSelectedRows}
            moneyTotal={moneyTotal}
            invCount={invCount}
            invValue={invValue}
            totpCode={totpCode}
            setTotpCode={setTotpCode}
          />
        )}

        {phase === "running" && <RunningPhase results={results} />}

        <DialogFooter className="gap-2 sm:gap-2">
          {phase === "select" && (
            <Button
              size="sm"
              variant="destructive"
              className="w-full sm:w-auto"
              disabled={!canReview}
              onClick={() => setPhase("confirm")}
            >
              Review
              {runnableCategories.length > 0
                ? ` (${runnableCategories.length})`
                : ""}
              <ArrowRight className="ml-1.5 size-3.5" />
            </Button>
          )}
          {phase === "confirm" && (
            <>
              <Button
                size="sm"
                variant="outline"
                className="w-full sm:w-auto"
                onClick={() => setPhase("select")}
                disabled={isPending}
              >
                Back
              </Button>
              <Button
                size="sm"
                variant="destructive"
                className="w-full sm:w-auto"
                onClick={handleRun}
                disabled={isPending || !totpCode.trim()}
              >
                {isPending ? (
                  <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                ) : (
                  <Trash2 className="mr-1.5 size-3.5" />
                )}
                {isPending
                  ? "Wiping…"
                  : `Wipe selected (${runnableCategories.length})`}
              </Button>
            </>
          )}
          {phase === "running" && (
            <Button
              size="sm"
              variant="outline"
              className="w-full sm:w-auto"
              onClick={() => onOpenChange(false)}
              disabled={isPending}
            >
              {isPending ? (
                <>
                  <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                  Working…
                </>
              ) : (
                "Close"
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Execution dispatcher — maps a category onto its EXISTING server action. The
// destructive logic, guards, snapshot-first ordering and audit all live in
// those actions unchanged; this only routes + normalizes the result message.
// ───────────────────────────────────────────────────────────────────────────
async function runCategory(
  category: WipeCategory,
  userId: string,
  totpCode: string,
  adjIds: string[],
): Promise<{ success: true; message: string } | { success: false; error: string }> {
  if (category === "adjustments") {
    const res = await wipeBalanceAdjustments({
      userId,
      ledgerIds: adjIds,
      totpCode,
    });
    if (!res.success) return { success: false, error: res.error };
    return {
      success: true,
      message: `Removed ${res.deletedCount} adjustment${res.deletedCount === 1 ? "" : "s"} · ${formatCurrency(res.totalRemoved)}`,
    };
  }
  if (category === "balance") {
    const res = await wipeBalance({ userId, totpCode });
    if (!res.success) return { success: false, error: res.error };
    return {
      success: true,
      message: `Removed ${formatCurrency(res.amountRemoved)} spendable balance`,
    };
  }
  if (category === "vault") {
    const res = await wipeVault({ userId, totpCode });
    if (!res.success) return { success: false, error: res.error };
    return {
      success: true,
      message: `Removed ${formatCurrency(res.amountRemoved)} from vault`,
    };
  }
  // inventory
  const res = await wipeInventory({ userId, totpCode });
  if (!res.success) return { success: false, error: res.error };
  return {
    success: true,
    message: `Deleted ${res.deletedCount} item${res.deletedCount === 1 ? "" : "s"} (${formatCurrency(res.totalValue)})`,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// SELECT PHASE — the checklist. Each category is a row with a checkbox; ticking
// expands its inline preview (balance/vault current→$0, inventory enriched
// breakdown, adjustments row-selection sub-list). Below the checklist sits the
// non-selectable "WILL NOT TOUCH" section (structurally un-wipeable data).
// ───────────────────────────────────────────────────────────────────────────
function SelectPhase({
  checked,
  onToggle,
  balance,
  vault,
  inventory,
  adjState,
  adjFiltered,
  adjSelected,
  adjSearch,
  setAdjSearch,
  adjFilteredAllSelected,
  adjFilteredSomeSelected,
  toggleAdjOne,
  toggleAdjAllFiltered,
  adjSelectedCount,
  adjTotal,
  tickedLoadError,
}: {
  checked: Record<WipeCategory, boolean>;
  onToggle: (cat: WipeCategory, v: boolean) => void;
  balance: LoadState<BalancePreview> | null;
  vault: LoadState<VaultPreview> | null;
  inventory: LoadState<InventoryPreview> | null;
  adjState: LoadState<WipeableAdjustment[]> | null;
  adjFiltered: WipeableAdjustment[];
  adjSelected: Set<string>;
  adjSearch: string;
  setAdjSearch: (v: string) => void;
  adjFilteredAllSelected: boolean;
  adjFilteredSomeSelected: boolean;
  toggleAdjOne: (id: string, v: boolean) => void;
  toggleAdjAllFiltered: (v: boolean) => void;
  adjSelectedCount: number;
  adjTotal: number;
  tickedLoadError: WipeCategory | undefined;
}) {
  return (
    <div className="space-y-3">
      <div className="space-y-2">
        {CATEGORY_ORDER.map((cat) => (
          <CategoryRow
            key={cat}
            category={cat}
            checked={checked[cat]}
            onToggle={(v) => onToggle(cat, v)}
          >
            {cat === "balance" && checked.balance && (
              <BalanceInline state={balance} />
            )}
            {cat === "vault" && checked.vault && <VaultInline state={vault} />}
            {cat === "inventory" && checked.inventory && (
              <InventoryInline state={inventory} />
            )}
            {cat === "adjustments" && checked.adjustments && (
              <AdjustmentsInline
                state={adjState}
                filtered={adjFiltered}
                selected={adjSelected}
                search={adjSearch}
                setSearch={setAdjSearch}
                allSelected={adjFilteredAllSelected}
                someSelected={adjFilteredSomeSelected}
                toggleOne={toggleAdjOne}
                toggleAllFiltered={toggleAdjAllFiltered}
                selectedCount={adjSelectedCount}
                total={adjTotal}
              />
            )}
          </CategoryRow>
        ))}
      </div>

      {tickedLoadError && (
        <div className="rounded-md border border-rose-500/30 bg-rose-500/5 p-2.5 text-xs text-rose-500">
          Could not load the{" "}
          {CATEGORY_META[tickedLoadError].label.toLowerCase()} preview — untick
          it or retry.
        </div>
      )}

      {/* WILL NOT TOUCH — non-selectable, structurally un-wipeable data. */}
      <PreservedPanel />
    </div>
  );
}

function CategoryRow({
  category,
  checked,
  onToggle,
  children,
}: {
  category: WipeCategory;
  checked: boolean;
  onToggle: (v: boolean) => void;
  children?: React.ReactNode;
}) {
  const meta = CATEGORY_META[category];
  const Icon = meta.icon;
  return (
    <div
      className={cn(
        "rounded-md border transition-colors",
        checked ? "border-rose-500/40 bg-rose-500/[0.04]" : "border-border",
      )}
    >
      <label className="flex cursor-pointer items-start gap-3 p-3">
        <Checkbox
          checked={checked}
          onCheckedChange={(v) => onToggle(Boolean(v))}
          aria-label={`Select ${meta.label}`}
          className="mt-0.5"
        />
        <span className="flex min-w-0 flex-1 items-start gap-2">
          <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-foreground">
              {meta.label}
            </span>
            <span className="block text-xs text-muted-foreground">
              {meta.blurb}
            </span>
          </span>
        </span>
      </label>
      {checked && children && (
        <div className="border-t border-rose-500/20 px-3 pb-3 pt-2.5">
          {children}
        </div>
      )}
    </div>
  );
}

function InlineWrapper({
  state,
  children,
}: {
  state: LoadState<unknown> | null;
  children: React.ReactNode;
}) {
  if (!state || state.status === "loading") {
    return (
      <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        Loading…
      </div>
    );
  }
  if (state.status === "error") {
    return <div className="py-2 text-xs text-rose-500">{state.error}</div>;
  }
  return <>{children}</>;
}

function BalanceInline({ state }: { state: LoadState<BalancePreview> | null }) {
  return (
    <InlineWrapper state={state}>
      {state?.status === "ready" && (
        <div className="space-y-2 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Spendable balance</span>
            <span className={cn("font-semibold tabular-nums", ROSE)}>
              {formatCurrency(state.data.amount)} → {formatCurrency(0)}
            </span>
          </div>
          {state.data.amount <= 0 && <EmptyNote what="spendable balance" />}
          {state.data.dealBalanceDisclosure && (
            <FungibleDisclosure pool="spendable balance" />
          )}
        </div>
      )}
    </InlineWrapper>
  );
}

function VaultInline({ state }: { state: LoadState<VaultPreview> | null }) {
  return (
    <InlineWrapper state={state}>
      {state?.status === "ready" && (
        <div className="space-y-2 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Vault (locked balance)</span>
            <span className={cn("font-semibold tabular-nums", ROSE)}>
              {formatCurrency(state.data.amount)} → {formatCurrency(0)}
            </span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Unlock window</span>
            <span className="text-foreground/80">
              {state.data.unlockAt
                ? `${formatDateTime(state.data.unlockAt)} → cleared`
                : "None (unlock-anytime)"}
            </span>
          </div>
          {state.data.amount <= 0 && <EmptyNote what="vault" />}
          {state.data.dealBalanceDisclosure && (
            <FungibleDisclosure pool="vault" />
          )}
        </div>
      )}
    </InlineWrapper>
  );
}

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

function InventoryInline({
  state,
}: {
  state: LoadState<InventoryPreview> | null;
}) {
  return (
    <InlineWrapper state={state}>
      {state?.status === "ready" && (
        <div className="space-y-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">
              {state.data.count.toLocaleString()} item
              {state.data.count === 1 ? "" : "s"} · total value
            </span>
            <span className={cn("font-semibold tabular-nums", ROSE)}>
              {formatCurrency(state.data.value)}
            </span>
          </div>
          {state.data.count <= 0 ? (
            <EmptyNote what="inventory" />
          ) : (
            <>
              {/* Per-source itemization. */}
              <div className="space-y-1">
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  By source
                </p>
                <div className="divide-y rounded border bg-background/50">
                  {state.data.bySource.map((s) => (
                    <div
                      key={s.source}
                      className="flex items-center justify-between px-2.5 py-1.5 text-xs"
                    >
                      <span className="text-muted-foreground">
                        {sourceLabel(s.source)}
                      </span>
                      <span className="tabular-nums text-foreground/80">
                        {s.count.toLocaleString()} · {formatCurrency(s.value)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Top items by value. */}
              {state.data.topItems.length > 0 && (
                <div className="space-y-1">
                  <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    Top items by value
                  </p>
                  <div className="max-h-40 divide-y overflow-y-auto rounded border bg-background/50">
                    {state.data.topItems.map((it, i) => (
                      <div
                        key={it.id}
                        className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-xs"
                      >
                        <span className="min-w-0 flex-1 truncate text-muted-foreground">
                          <span className="tabular-nums text-foreground/50">
                            {i + 1}.
                          </span>{" "}
                          {it.name}
                        </span>
                        <span
                          className={cn(
                            "shrink-0 font-medium tabular-nums",
                            ROSE,
                          )}
                        >
                          {formatCurrency(it.value)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Value-tier distribution. */}
              {state.data.valueTiers.length > 0 && (
                <div className="space-y-1">
                  <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    Value distribution
                  </p>
                  <div className="divide-y rounded border bg-background/50">
                    {state.data.valueTiers.map((t) => (
                      <div
                        key={t.label}
                        className="flex items-center justify-between px-2.5 py-1.5 text-xs"
                      >
                        <span className="text-muted-foreground">{t.label}</span>
                        <span className="tabular-nums text-foreground/80">
                          {t.count.toLocaleString()} item
                          {t.count === 1 ? "" : "s"} · {formatCurrency(t.value)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </InlineWrapper>
  );
}

function AdjustmentsInline({
  state,
  filtered,
  selected,
  search,
  setSearch,
  allSelected,
  someSelected,
  toggleOne,
  toggleAllFiltered,
  selectedCount,
  total,
}: {
  state: LoadState<WipeableAdjustment[]> | null;
  filtered: WipeableAdjustment[];
  selected: Set<string>;
  search: string;
  setSearch: (v: string) => void;
  allSelected: boolean;
  someSelected: boolean;
  toggleOne: (id: string, v: boolean) => void;
  toggleAllFiltered: (v: boolean) => void;
  selectedCount: number;
  total: number;
}) {
  return (
    <InlineWrapper state={state}>
      {state?.status === "ready" && (
        <div className="space-y-2">
          {state.data.length === 0 ? (
            <div className="py-2 text-xs text-muted-foreground">
              This user has no admin balance-adjustment credits to wipe.
            </div>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                Pick the admin-granted credits to remove. Debits/clawbacks,
                deposits, withdrawals, gaming, affiliate and creator-deal rows
                are never listed.
              </p>
              {/* Search / filter by reason */}
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Filter by reason (e.g. Streamer, Giveaway)…"
                  className="h-8 pl-8 text-xs"
                />
              </div>
              {/* Select-all (filtered) */}
              <label className="flex cursor-pointer items-center gap-2 px-1 text-xs text-muted-foreground">
                <Checkbox
                  checked={allSelected}
                  indeterminate={someSelected}
                  onCheckedChange={(v) => toggleAllFiltered(Boolean(v))}
                  aria-label="Select all filtered adjustments"
                />
                <span>
                  Select all{search.trim() ? " matching" : ""} ({filtered.length}
                  )
                </span>
              </label>
              {/* Rows */}
              <div className="max-h-56 divide-y overflow-y-auto rounded-md border">
                {filtered.length === 0 ? (
                  <div className="py-6 text-center text-xs text-muted-foreground">
                    No adjustments match “{search}”.
                  </div>
                ) : (
                  filtered.map((r) => {
                    const isChecked = selected.has(r.id);
                    return (
                      <label
                        key={r.id}
                        className={cn(
                          "flex cursor-pointer items-center gap-3 px-3 py-2 text-sm transition-colors hover:bg-muted/40",
                          isChecked && "bg-rose-500/[0.06]",
                        )}
                      >
                        <Checkbox
                          checked={isChecked}
                          onCheckedChange={(v) => toggleOne(r.id, Boolean(v))}
                          aria-label={`Select adjustment ${r.reason}`}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium text-foreground">
                            {r.reason || "(no reason)"}
                          </div>
                          <div className="text-[11px] text-muted-foreground">
                            {formatDateTime(r.createdAt)} ·{" "}
                            {formatRelative(r.createdAt)}
                          </div>
                        </div>
                        <div
                          className={cn(
                            "shrink-0 font-semibold tabular-nums",
                            ROSE,
                          )}
                        >
                          +{formatCurrency(r.amount)}
                        </div>
                      </label>
                    );
                  })
                )}
              </div>
              {/* Running total */}
              <div className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-1.5 text-xs">
                <span className="text-muted-foreground">
                  <span className="font-semibold tabular-nums text-foreground">
                    {selectedCount}
                  </span>{" "}
                  selected
                </span>
                <span className="text-muted-foreground">
                  To remove:{" "}
                  <span className={cn("font-semibold tabular-nums", ROSE)}>
                    {formatCurrency(total)}
                  </span>
                </span>
              </div>
            </>
          )}
        </div>
      )}
    </InlineWrapper>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// CONFIRM PHASE — the combined "WILL DELETE" summary across every selected
// category with a grand total, the non-selectable preserved section, and the
// SINGLE 2FA field.
// ───────────────────────────────────────────────────────────────────────────
function ConfirmPhase({
  runnableCategories,
  balanceAmt,
  vaultAmt,
  adjAmt,
  adjSelectedRows,
  moneyTotal,
  invCount,
  invValue,
  totpCode,
  setTotpCode,
}: {
  runnableCategories: readonly WipeCategory[];
  balanceAmt: number;
  vaultAmt: number;
  adjAmt: number;
  adjSelectedRows: WipeableAdjustment[];
  moneyTotal: number;
  invCount: number;
  invValue: number;
  totpCode: string;
  setTotpCode: (v: string) => void;
}) {
  const wantsAdjustments = runnableCategories.includes("adjustments");
  const wantsBalance = runnableCategories.includes("balance");
  const wantsVault = runnableCategories.includes("vault");
  const wantsInventory = runnableCategories.includes("inventory");

  return (
    <div className="space-y-3">
      {/* WILL DELETE — combined, itemized, with the grand total. */}
      <div className="space-y-3 rounded-md border border-rose-500/30 bg-rose-500/[0.06] p-3 text-sm">
        <p className="flex items-center gap-2 font-semibold text-rose-500 dark:text-rose-400">
          <Eraser className="size-4" />
          Will delete ({runnableCategories.length})
        </p>

        {wantsAdjustments && (
          <SummaryBlock
            icon={SlidersHorizontal}
            label={`Content balance adjustments (${adjSelectedRows.length})`}
            amount={adjAmt}
          >
            <div className="max-h-32 divide-y overflow-y-auto rounded border bg-background/50">
              {adjSelectedRows.map((r) => (
                <div
                  key={r.id}
                  className="flex items-center justify-between px-2.5 py-1.5 text-xs"
                >
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {r.reason || "(no reason)"}
                  </span>
                  <span
                    className={cn(
                      "ml-2 shrink-0 font-semibold tabular-nums",
                      ROSE,
                    )}
                  >
                    +{formatCurrency(r.amount)}
                  </span>
                </div>
              ))}
            </div>
          </SummaryBlock>
        )}

        {wantsBalance && (
          <SummaryBlock
            icon={Wallet}
            label="Spendable balance"
            amount={balanceAmt}
          >
            <p className="text-xs text-muted-foreground">
              {formatCurrency(balanceAmt)} → {formatCurrency(0)}
            </p>
          </SummaryBlock>
        )}

        {wantsVault && (
          <SummaryBlock
            icon={Archive}
            label="Vault (locked balance)"
            amount={vaultAmt}
          >
            <p className="text-xs text-muted-foreground">
              {formatCurrency(vaultAmt)} → {formatCurrency(0)} · unlock window
              cleared
            </p>
          </SummaryBlock>
        )}

        {wantsInventory && (
          <SummaryBlock
            icon={Package}
            label={`Inventory (${invCount.toLocaleString()} item${invCount === 1 ? "" : "s"})`}
            amount={invValue}
          >
            <p className="text-xs text-muted-foreground">
              {invCount.toLocaleString()} item{invCount === 1 ? "" : "s"} ·{" "}
              {formatCurrency(invValue)} estimated value
            </p>
          </SummaryBlock>
        )}

        {/* Grand total. Money pools (balance + vault + adjustments) sum to one
            cash figure; inventory value is a card-value estimate shown
            alongside (different unit, not folded into the cash headline). */}
        <div className="border-t border-rose-500/20 pt-2.5">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-foreground">
              Grand total
            </span>
            <span className={cn("text-base font-bold tabular-nums", ROSE)}>
              {formatCurrency(moneyTotal + invValue)}
            </span>
          </div>
          {wantsInventory && (balanceAmt > 0 || vaultAmt > 0 || adjAmt > 0) && (
            <p className="mt-1 text-right text-[11px] text-muted-foreground">
              {formatCurrency(moneyTotal)} balance pools +{" "}
              {formatCurrency(invValue)} inventory value
            </p>
          )}
        </div>
      </div>

      {/* WILL NOT TOUCH — same non-selectable preserved promise. */}
      <PreservedPanel />

      <div className="rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-sm">
        <p className="flex items-center gap-2 font-medium text-rose-400">
          <ShieldAlert className="size-4" />
          Destructive but recoverable — each category snapshots first and is
          individually restorable from the wipe history.
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
        <p className="text-[11px] text-muted-foreground">
          One code runs all selected wipes in sequence.
        </p>
      </div>
    </div>
  );
}

function SummaryBlock({
  icon: Icon,
  label,
  amount,
  children,
}: {
  icon: LucideIcon;
  label: string;
  amount: number;
  children?: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          <Icon className="size-3.5 text-muted-foreground" />
          {label}
        </span>
        <span className={cn("shrink-0 font-semibold tabular-nums", ROSE)}>
          {formatCurrency(amount)}
        </span>
      </div>
      {children}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// RUNNING PHASE — per-category execution status so a partial run is legible.
// ───────────────────────────────────────────────────────────────────────────
function RunningPhase({ results }: { results: RunResult[] }) {
  return (
    <div className="space-y-2">
      <div className="divide-y rounded-md border">
        {results.map((r) => {
          const meta = CATEGORY_META[r.category];
          const Icon = meta.icon;
          return (
            <div
              key={r.category}
              className="flex items-center gap-3 px-3 py-2.5 text-sm"
            >
              <Icon className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="font-medium text-foreground">{meta.label}</div>
                {r.message && (
                  <div
                    className={cn(
                      "text-xs",
                      r.status === "failed"
                        ? "text-rose-500"
                        : "text-muted-foreground",
                    )}
                  >
                    {r.message}
                  </div>
                )}
              </div>
              <RunStatusBadge status={r.status} />
            </div>
          );
        })}
      </div>
      <p className="text-[11px] text-muted-foreground">
        Every successful wipe above is its own recoverable snapshot — restore any
        of them from the wipe history.
      </p>
    </div>
  );
}

function RunStatusBadge({ status }: { status: RunStatus }) {
  if (status === "success") {
    return (
      <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
        <CheckCircle2 className="size-4" />
        Done
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-rose-500">
        <XCircle className="size-4" />
        Failed
      </span>
    );
  }
  if (status === "running") {
    return (
      <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Running
      </span>
    );
  }
  if (status === "skipped") {
    return (
      <span className="shrink-0 text-xs font-medium text-muted-foreground">
        Skipped
      </span>
    );
  }
  return (
    <span className="shrink-0 text-xs text-muted-foreground/70">Pending</span>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Shared small components.
// ───────────────────────────────────────────────────────────────────────────

/** Disclosure for the fungible balance/vault pools (protected.ts note). */
function FungibleDisclosure({ pool }: { pool: string }) {
  return (
    <p className="flex items-start gap-1.5 rounded border border-amber-500/30 bg-amber-500/[0.06] px-2.5 py-1.5 text-xs text-amber-600 dark:text-amber-400">
      <Info className="mt-0.5 size-3.5 shrink-0" />
      <span>
        This is a single fungible {pool}. If any creator-deal payout was
        redeemed/converted into it, that portion is included here — fungible
        balance can&apos;t be separated by source.
      </span>
    </p>
  );
}

/** Note shown when a ticked category turns out to be empty (no-op). */
function EmptyNote({ what }: { what: string }) {
  return (
    <p className="text-xs text-muted-foreground">
      Nothing to wipe — this user&apos;s {what} is already empty. This category
      will be skipped.
    </p>
  );
}

/**
 * The non-selectable "WILL NOT TOUCH" section. These are NOT checkboxes — the
 * underlying data is structurally un-wipeable (the wipe actions never read or
 * write those tables). Same promise the server-side guards enforce.
 */
function PreservedPanel() {
  return (
    <div className="rounded-md border border-emerald-500/30 bg-emerald-500/[0.05] p-3 text-sm">
      <p className="flex items-start gap-2 text-emerald-600 dark:text-emerald-400">
        <ShieldCheck className="mt-0.5 size-4 shrink-0" />
        <span>
          <span className="font-semibold">
            Will NOT touch — not selectable.
          </span>{" "}
          {WIPE_PRESERVED_SUMMARY}
        </span>
      </p>
    </div>
  );
}
