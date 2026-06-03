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
  ShieldX,
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
  ArrowDownToLine,
  ArrowUpFromLine,
  Receipt,
  Gift,
  Gamepad2,
  Users,
  UserCog,
  Lock,
  BarChart3,
  Skull,
  AlertTriangle,
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
import { wipePreservedSummary } from "@/lib/account-wipes/protected";
import {
  WIPE_CATEGORIES,
  WIPE_CATEGORY_GROUPS,
  wipeCategoryMeta,
  type WipeCategory,
  type WipeCategoryIcon,
  type WipeCategoryGroup,
} from "@/lib/account-wipes/categories";
import { excludeUserFromAllStats } from "./wipe-exclude-actions";
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
  previewDepositsWipe,
  wipeDeposits,
} from "./wipe-deposits-actions";
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

// Map the icon NAME from the categories module to a lucide component (keeps
// that module icon-lib-free + client-safe).
const ICONS: Record<WipeCategoryIcon, LucideIcon> = {
  sliders: SlidersHorizontal,
  wallet: Wallet,
  archive: Archive,
  package: Package,
  "arrow-down-to-line": ArrowDownToLine,
  "arrow-up-from-line": ArrowUpFromLine,
  receipt: Receipt,
  gift: Gift,
  gamepad: Gamepad2,
  users: Users,
  "user-cog": UserCog,
};

function categoryIcon(key: WipeCategory): LucideIcon {
  return ICONS[wipeCategoryMeta(key).icon];
}

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
type DepositsPreview = {
  count: number;
  totalAmount: number;
  totalDeposited: number;
  recent: Array<{ id: string; amount: number; createdAt: string; description: string }>;
};

type LoadState<T> =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; data: T };

// The selectable, ENABLED categories whose previews this dialog loads + runs.
// Disabled (coming-soon) categories are rendered greyed-out and are never
// loaded or executed. Adjustments is row-selectable; the rest are all-or-
// nothing. Deposits is creator-protected (disabled for an ever-creator).
type SelectableCategory =
  | "adjustments"
  | "balance"
  | "vault"
  | "inventory"
  | "deposits";

// ───────────────────────────────────────────────────────────────────────────
// Entry button — the SINGLE "Wipe data" button that replaces the four separate
// per-category buttons in the moderation toolbar. The OLD full-account
// `WipeAccountButton` (nuclear, non-recoverable) stays a separate button — this
// is the recoverable, targeted, customizable one. Admin-gated upstream; every
// underlying server action re-checks (requireAdmin + __can_wipe_accounts + 2FA)
// regardless.
//
// `everCreator` / `wasCreator` are surfaced from the user-detail page so the
// panel can DISABLE the creator-protected categories ("Protected — creator").
// The flags are UI hints only — every server action re-derives the ever-creator
// status server-side (dual-DB) and hard-rejects a protected category
// regardless of what the client sends.
// ───────────────────────────────────────────────────────────────────────────

export function WipeDataButton({
  userId,
  everCreator = false,
  wasCreator = false,
}: {
  userId: string;
  everCreator?: boolean;
  wasCreator?: boolean;
}) {
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
      <WipeDataDialog
        userId={userId}
        everCreator={everCreator}
        wasCreator={wasCreator}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}

type Phase = "select" | "confirm" | "running";

// Per-step execution outcome surfaced in the running/results phase so a
// partial run is fully legible (which succeeded, which failed, which were
// skipped because an earlier one aborted the sequence).
//
// A run step is EITHER a wipe category OR the special "exclude from all stats"
// step (a non-destructive blacklist add that runs as the FINAL step). The
// `kind` discriminator lets the RunningPhase render the right label/icon for
// the stat-exclusion row, which has no WipeCategory.
type RunStatus = "pending" | "running" | "success" | "failed" | "skipped";
type RunResult =
  | { kind: "category"; category: SelectableCategory; status: RunStatus; message: string }
  | { kind: "exclude"; status: RunStatus; message: string };

function WipeDataDialog({
  userId,
  everCreator,
  wasCreator,
  open,
  onOpenChange,
}: {
  userId: string;
  everCreator: boolean;
  wasCreator: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("select");
  const [totpCode, setTotpCode] = useState("");
  const [isPending, startTransition] = useTransition();

  // Which categories are ticked (selectable ones only).
  const [checked, setChecked] = useState<Record<SelectableCategory, boolean>>({
    adjustments: false,
    balance: false,
    vault: false,
    inventory: false,
    deposits: false,
  });

  // "Also remove from all stats" — when ON, the user is added to the
  // excluded-users blacklist after the wipes so they vanish from every metric
  // surface (dashboard / GGR / analytics / insights / P&L). Default ON per the
  // owner's ask. Non-destructive (deletes nothing — just filters them out of
  // aggregates), so it is safe even for creators. WIPE ALL forces this ON
  // regardless of this toggle.
  const [excludeFromStats, setExcludeFromStats] = useState(true);

  // True only while a WIPE ALL run is executing — drives the running-phase
  // banner copy + forces the stat-exclusion step on.
  const [isWipeAllRun, setIsWipeAllRun] = useState(false);

  // Lazily-loaded previews — one per category, only fetched when that category
  // is first ticked (hidden-component rule: never preload on page render, and
  // never load a category the admin hasn't selected).
  const [balance, setBalance] = useState<LoadState<BalancePreview> | null>(null);
  const [vault, setVault] = useState<LoadState<VaultPreview> | null>(null);
  const [inventory, setInventory] =
    useState<LoadState<InventoryPreview> | null>(null);
  const [deposits, setDeposits] = useState<LoadState<DepositsPreview> | null>(
    null,
  );

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
      deposits: false,
    });
    setBalance(null);
    setVault(null);
    setInventory(null);
    setDeposits(null);
    setAdjState(null);
    setAdjSelected(new Set());
    setAdjSearch("");
    setResults([]);
    setExcludeFromStats(true);
    setIsWipeAllRun(false);
  }, [open]);

  // Whether a selectable category is interactable: enabled AND not creator-
  // protected for THIS user. Disabled / creator-protected categories render
  // greyed-out and can never be ticked.
  const isCategoryLocked = useCallback(
    (key: WipeCategory): boolean => {
      const meta = wipeCategoryMeta(key);
      if (!meta.enabled) return true;
      if (meta.creatorProtected && everCreator) return true;
      return false;
    },
    [everCreator],
  );

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

  const loadDeposits = useCallback(() => {
    setDeposits({ status: "loading" });
    previewDepositsWipe(userId)
      .then((res) =>
        setDeposits(
          res.success
            ? {
                status: "ready",
                data: {
                  count: res.preview.count,
                  totalAmount: res.preview.totalAmount,
                  totalDeposited: res.preview.totalDeposited,
                  recent: res.preview.recent,
                },
              }
            : { status: "error", error: res.error },
        ),
      )
      .catch((e) =>
        setDeposits({
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

  function toggleCategory(cat: SelectableCategory, v: boolean) {
    if (v && isCategoryLocked(cat)) return; // can't tick a locked category
    setChecked((prev) => ({ ...prev, [cat]: v }));
    if (!v) return;
    // Kick off the lazy load the first time the category is ticked.
    if (cat === "balance" && balance === null) loadBalance();
    if (cat === "vault" && vault === null) loadVault();
    if (cat === "inventory" && inventory === null) loadInventory();
    if (cat === "deposits" && deposits === null) loadDeposits();
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
  const depositsAmt =
    checked.deposits && deposits?.status === "ready"
      ? deposits.data.totalAmount
      : 0;
  // The money grand-total across the selected MONEY categories (balance, vault,
  // selected adjustments, deposits). Inventory value is a card-value estimate
  // (different unit) and is surfaced alongside, not folded into this cash
  // figure.
  const moneyTotal = balanceAmt + vaultAmt + adjAmt + depositsAmt;
  const invValue =
    checked.inventory && inventory?.status === "ready"
      ? inventory.data.value
      : 0;
  const invCount =
    checked.inventory && inventory?.status === "ready"
      ? inventory.data.count
      : 0;
  const depositsCount =
    checked.deposits && deposits?.status === "ready" ? deposits.data.count : 0;

  // Whether a ticked category actually contributes something to delete. A
  // ticked-but-empty category (e.g. $0 balance) is treated as a no-op rather
  // than producing a guaranteed-failing wipe call.
  const categoryHasContent = useCallback(
    (cat: SelectableCategory): boolean => {
      switch (cat) {
        case "balance":
          return balance?.status === "ready" && balance.data.amount > 0;
        case "vault":
          return vault?.status === "ready" && vault.data.amount > 0;
        case "inventory":
          return inventory?.status === "ready" && inventory.data.count > 0;
        case "deposits":
          return deposits?.status === "ready" && deposits.data.count > 0;
        case "adjustments":
          return adjSelected.size > 0;
      }
    },
    [balance, vault, inventory, deposits, adjSelected],
  );

  const SELECTABLE_ORDER: readonly SelectableCategory[] = useMemo(
    () => ["adjustments", "balance", "vault", "inventory", "deposits"],
    [],
  );

  // The categories that will actually run: ticked AND non-empty AND not locked.
  // Drives the Review button's enabled state + the execution loop.
  const runnableCategories = useMemo(
    () =>
      SELECTABLE_ORDER.filter(
        (c) => checked[c] && !isCategoryLocked(c) && categoryHasContent(c),
      ),
    [SELECTABLE_ORDER, checked, isCategoryLocked, categoryHasContent],
  );

  // A ticked category whose preview is still loading blocks Review (we don't
  // know yet whether it has content / what the total is).
  const anyTickedStillLoading = SELECTABLE_ORDER.some((c) => {
    if (!checked[c]) return false;
    if (c === "balance") return !balance || balance.status === "loading";
    if (c === "vault") return !vault || vault.status === "loading";
    if (c === "inventory") return !inventory || inventory.status === "loading";
    if (c === "deposits") return !deposits || deposits.status === "loading";
    if (c === "adjustments") return !adjState || adjState.status === "loading";
    return false;
  });

  // A ticked category whose preview errored — block Review and surface it.
  const tickedLoadError = SELECTABLE_ORDER.find((c) => {
    if (!checked[c]) return false;
    if (c === "balance") return balance?.status === "error";
    if (c === "vault") return vault?.status === "error";
    if (c === "inventory") return inventory?.status === "error";
    if (c === "deposits") return deposits?.status === "error";
    if (c === "adjustments") return adjState?.status === "error";
    return false;
  });

  const canReview =
    runnableCategories.length > 0 && !anyTickedStillLoading && !tickedLoadError;

  // Whether any runnable category is a live-financial one (drives the combined
  // danger banner in the confirm step).
  const anyLiveFinancialSelected = runnableCategories.some(
    (c) => wipeCategoryMeta(c).liveFinancial,
  );

  // Every ENABLED, non-creator-locked selectable category — the set WIPE ALL
  // runs. Disabled ("coming soon") + creator-protected categories are excluded
  // here exactly as in the per-category flow (WIPE ALL never enables a disabled
  // category and never bypasses creator-protection). Empty categories are still
  // included in the run plan and are soft-skipped at execution time.
  const allEnabledCategories = useMemo(
    () => SELECTABLE_ORDER.filter((c) => !isCategoryLocked(c)),
    [SELECTABLE_ORDER, isCategoryLocked],
  );

  // ── Sequential multi-execute. One 2FA code, applied to each step's EXISTING
  // action in turn. Each wipe action is independently snapshot-first +
  // recoverable, so a partial run is safe + individually restorable from the
  // wipe audit log. The OPTIONAL final step is the non-destructive
  // "exclude from all stats" blacklist add.
  //
  //   • `seq`            — the ordered categories to wipe.
  //   • `adjIds`         — the adjustment ledger ids to wipe (for the
  //                        adjustments category). Empty for WIPE ALL when no
  //                        adjustments exist.
  //   • `alsoExclude`    — append the stat-exclusion step at the end.
  //   • `softSkipEmpty`  — WIPE ALL mode: treat a category's "nothing to wipe"
  //                        / "already $0" empty-result as a SKIP rather than an
  //                        aborting failure (so an empty vault doesn't stop the
  //                        balance/inventory wipes). A REAL failure still
  //                        aborts the remaining wipes. The stat-exclusion step
  //                        always runs (it doesn't depend on the wipes).
  //   • `wipeAll`        — drives the running-phase banner copy.
  //
  // SINGLE 2FA GATE PRESERVED: one code drives every wipe action AND the
  // exclusion action; each server action independently re-verifies it
  // (require2FA is stateless, no replay lock), exactly as the existing
  // multi-category run already does.
  const runSequence = useCallback(
    (opts: {
      seq: readonly SelectableCategory[];
      adjIds: string[];
      alsoExclude: boolean;
      softSkipEmpty: boolean;
      wipeAll: boolean;
    }) => {
      const { seq, adjIds, alsoExclude, softSkipEmpty, wipeAll } = opts;
      if (!totpCode.trim()) {
        toast.error("Enter your 2FA code");
        return;
      }
      if (seq.length === 0 && !alsoExclude) {
        toast.error("Nothing selected to wipe");
        return;
      }
      const code = totpCode.trim();

      setIsWipeAllRun(wipeAll);
      setPhase("running");

      // Build the run plan: a step per category, plus the optional final
      // stat-exclusion step. Seeded all-pending so the UI shows the full plan.
      const plan: RunResult[] = seq.map((category) => ({
        kind: "category" as const,
        category,
        status: "pending" as RunStatus,
        message: "",
      }));
      if (alsoExclude) {
        plan.push({ kind: "exclude", status: "pending", message: "" });
      }
      setResults(plan.map((r) => ({ ...r })));

      startTransition(async () => {
        const finalResults: RunResult[] = plan.map((r) => ({ ...r }));
        const commit = () => setResults(finalResults.map((r) => ({ ...r })));

        // Treat a category server-action error string that means "the category
        // was empty" as a soft-skip in WIPE ALL mode (an empty category is a
        // no-op, not a failure that should abort the rest).
        const isEmptyErr = (msg: string): boolean =>
          /nothing to wipe|already \$0|no inventory|no deposits|at least one adjustment/i.test(
            msg,
          );

        let aborted = false;
        for (let i = 0; i < finalResults.length; i++) {
          const step = finalResults[i];

          if (step.kind === "exclude") {
            // The stat-exclusion step ALWAYS runs (it doesn't depend on the
            // wipes succeeding) — it's non-destructive and is the whole point
            // of "gone everywhere", so an earlier wipe failure must not skip
            // it. It runs LAST so the metric-cache bust reflects the wipes too.
            finalResults[i] = { kind: "exclude", status: "running", message: "" };
            commit();
            try {
              const res = await excludeUserFromAllStats({
                userId,
                totpCode: code,
                reason: wipeAll
                  ? "Auto-excluded on WIPE ALL"
                  : "Auto-excluded on account wipe",
              });
              finalResults[i] = res.success
                ? {
                    kind: "exclude",
                    status: "success",
                    message: res.inserted
                      ? "Removed from all stats (dashboard / GGR / analytics / insights)"
                      : "Already excluded from all stats — no change",
                  }
                : { kind: "exclude", status: "failed", message: res.error };
            } catch (e) {
              finalResults[i] = {
                kind: "exclude",
                status: "failed",
                message: e instanceof Error ? e.message : "Unexpected error",
              };
            }
            commit();
            continue;
          }

          const category = step.category;
          if (aborted) {
            finalResults[i] = {
              kind: "category",
              category,
              status: "skipped",
              message: "Skipped — an earlier wipe failed",
            };
            commit();
            continue;
          }
          finalResults[i] = { kind: "category", category, status: "running", message: "" };
          commit();

          try {
            const outcome = await runCategory(category, userId, code, adjIds);
            if (outcome.success) {
              finalResults[i] = {
                kind: "category",
                category,
                status: "success",
                message: outcome.message,
              };
            } else if (softSkipEmpty && isEmptyErr(outcome.error)) {
              // Empty category under WIPE ALL → skip, don't abort the rest.
              finalResults[i] = {
                kind: "category",
                category,
                status: "skipped",
                message: "Nothing to wipe — empty, skipped",
              };
            } else {
              finalResults[i] = {
                kind: "category",
                category,
                status: "failed",
                message: outcome.error,
              };
              aborted = true;
            }
          } catch (e) {
            finalResults[i] = {
              kind: "category",
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
            wipeAll
              ? "Wipe all complete"
              : succeeded === 1
                ? "Wipe complete"
                : `Wiped ${succeeded} step${succeeded === 1 ? "" : "s"}`,
          );
        } else if (succeeded > 0) {
          toast.error(
            `${succeeded} done, ${failed} failed — see the breakdown. Succeeded wipes are individually restorable.`,
          );
        } else {
          toast.error("Wipe failed — nothing was changed");
        }

        // Always refresh so any committed wipe + the exclusion are reflected.
        // Each successful action already revalidated the page + busted metric
        // caches server-side.
        router.refresh();
      });
    },
    [totpCode, userId, router],
  );

  // Normal "Wipe selected" path: run the ticked, non-empty categories, with the
  // stat-exclusion appended only when the "Also remove from all stats" toggle
  // is ON. Empty categories can't reach here (runnableCategories excludes them),
  // so softSkipEmpty is off.
  function handleRun() {
    runSequence({
      seq: runnableCategories,
      adjIds: Array.from(adjSelected),
      alsoExclude: excludeFromStats,
      softSkipEmpty: false,
      wipeAll: false,
    });
  }

  // WIPE ALL: run EVERY enabled, non-locked category (empties soft-skipped) and
  // ALWAYS add the stat-exclusion. Loads the full adjustment list first (its
  // ids are needed by the adjustments action) — the only preview WIPE ALL
  // depends on; balance/vault/inventory/deposits re-read server-side. The
  // single 2FA gate is unchanged (the code already entered in the confirm step
  // drives every action).
  const handleWipeAll = useCallback(() => {
    if (!totpCode.trim()) {
      toast.error("Enter your 2FA code");
      return;
    }
    if (allEnabledCategories.length === 0) {
      // No destructive category is available (e.g. fully creator-protected),
      // but the non-destructive stat-exclusion still applies → run it alone.
      runSequence({
        seq: [],
        adjIds: [],
        alsoExclude: true,
        softSkipEmpty: true,
        wipeAll: true,
      });
      return;
    }

    const start = (adjIds: string[]) =>
      runSequence({
        seq: allEnabledCategories,
        adjIds,
        alsoExclude: true,
        softSkipEmpty: true,
        wipeAll: true,
      });

    // If adjustments is one of the enabled categories, make sure we have its
    // ledger ids before running (the action requires explicit ids). Use the
    // already-loaded list if present; otherwise fetch it now.
    if (!allEnabledCategories.includes("adjustments")) {
      start([]);
      return;
    }
    if (adjState?.status === "ready") {
      start(adjState.data.map((r) => r.id));
      return;
    }
    // Fetch the adjustment ids inline, then run.
    startTransition(async () => {
      try {
        const res = await listWipeableAdjustments(userId);
        start(res.success ? res.rows.map((r) => r.id) : []);
      } catch {
        // If listing fails, still run the rest (adjustments will soft-skip on
        // its "select at least one" empty error).
        start([]);
      }
    });
  }, [totpCode, allEnabledCategories, adjState, userId, runSequence]);

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
                from the wipe history below.
                {everCreator
                  ? " This user is or was a creator, so their finance, deposits and affiliate data are protected."
                  : ""}
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
            everCreator={everCreator}
            wasCreator={wasCreator}
            isCategoryLocked={isCategoryLocked}
            balance={balance}
            vault={vault}
            inventory={inventory}
            deposits={deposits}
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
            everCreator={everCreator}
            anyLiveFinancialSelected={anyLiveFinancialSelected}
            balanceAmt={balanceAmt}
            vaultAmt={vaultAmt}
            adjAmt={adjAmt}
            depositsAmt={depositsAmt}
            depositsCount={depositsCount}
            adjSelectedRows={adjSelectedRows}
            moneyTotal={moneyTotal}
            invCount={invCount}
            invValue={invValue}
            totpCode={totpCode}
            setTotpCode={setTotpCode}
            excludeFromStats={excludeFromStats}
            setExcludeFromStats={setExcludeFromStats}
            allEnabledCategories={allEnabledCategories}
            onWipeAll={handleWipeAll}
            isPending={isPending}
          />
        )}

        {phase === "running" && (
          <RunningPhase results={results} isWipeAll={isWipeAllRun} />
        )}

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
  category: SelectableCategory,
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
  if (category === "deposits") {
    const res = await wipeDeposits({ userId, totpCode });
    if (!res.success) return { success: false, error: res.error };
    return {
      success: true,
      message: `Deleted ${res.deletedCount} deposit${res.deletedCount === 1 ? "" : "s"} (${formatCurrency(res.totalAmount)}) · counter −${formatCurrency(res.counterReduced)}`,
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
// SELECT PHASE — the grouped checklist. Each category is a row with a checkbox;
// ticking expands its inline preview. Disabled (coming-soon) + creator-protected
// categories render greyed-out and non-tickable. Below sits the role-aware
// "WILL NOT TOUCH" section.
// ───────────────────────────────────────────────────────────────────────────
function SelectPhase({
  checked,
  onToggle,
  everCreator,
  wasCreator,
  isCategoryLocked,
  balance,
  vault,
  inventory,
  deposits,
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
  checked: Record<SelectableCategory, boolean>;
  onToggle: (cat: SelectableCategory, v: boolean) => void;
  everCreator: boolean;
  wasCreator: boolean;
  isCategoryLocked: (key: WipeCategory) => boolean;
  balance: LoadState<BalancePreview> | null;
  vault: LoadState<VaultPreview> | null;
  inventory: LoadState<InventoryPreview> | null;
  deposits: LoadState<DepositsPreview> | null;
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
  tickedLoadError: SelectableCategory | undefined;
}) {
  // Group the canonical category list by group, preserving order.
  const byGroup = useMemo(() => {
    const map = new Map<WipeCategoryGroup, WipeCategory[]>();
    for (const c of WIPE_CATEGORIES) {
      const arr = map.get(c.group) ?? [];
      arr.push(c.key);
      map.set(c.group, arr);
    }
    return map;
  }, []);

  return (
    <div className="space-y-3">
      {WIPE_CATEGORY_GROUPS.map((group) => {
        const keys = byGroup.get(group.key) ?? [];
        if (keys.length === 0) return null;
        return (
          <div key={group.key} className="space-y-2">
            <p className="px-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {group.label}
            </p>
            <div className="space-y-2">
              {keys.map((key) => {
                const meta = wipeCategoryMeta(key);
                const locked = isCategoryLocked(key);
                const lockReason = !meta.enabled
                  ? "Coming soon"
                  : meta.creatorProtected && everCreator
                    ? wasCreator
                      ? "Protected — ex-creator"
                      : "Protected — creator"
                    : null;
                const isSelectable =
                  key === "adjustments" ||
                  key === "balance" ||
                  key === "vault" ||
                  key === "inventory" ||
                  key === "deposits";
                return (
                  <CategoryRow
                    key={key}
                    category={key}
                    checked={isSelectable ? checked[key as SelectableCategory] : false}
                    locked={locked}
                    lockReason={lockReason}
                    disabledReason={!meta.enabled ? meta.disabledReason : ""}
                    liveFinancial={meta.liveFinancial}
                    onToggle={
                      isSelectable && !locked
                        ? (v) => onToggle(key as SelectableCategory, v)
                        : undefined
                    }
                  >
                    {key === "balance" && checked.balance && (
                      <BalanceInline state={balance} />
                    )}
                    {key === "vault" && checked.vault && (
                      <VaultInline state={vault} />
                    )}
                    {key === "inventory" && checked.inventory && (
                      <InventoryInline state={inventory} />
                    )}
                    {key === "deposits" && checked.deposits && (
                      <DepositsInline state={deposits} />
                    )}
                    {key === "adjustments" && checked.adjustments && (
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
                );
              })}
            </div>
          </div>
        );
      })}

      {tickedLoadError && (
        <div className="rounded-md border border-rose-500/30 bg-rose-500/5 p-2.5 text-xs text-rose-500">
          Could not load the{" "}
          {wipeCategoryMeta(tickedLoadError).label.toLowerCase()} preview —
          untick it or retry.
        </div>
      )}

      {/* WILL NOT TOUCH — role-aware, non-selectable preserved data. */}
      <PreservedPanel everCreator={everCreator} />
    </div>
  );
}

function CategoryRow({
  category,
  checked,
  locked,
  lockReason,
  disabledReason,
  liveFinancial,
  onToggle,
  children,
}: {
  category: WipeCategory;
  checked: boolean;
  locked: boolean;
  lockReason: string | null;
  disabledReason: string;
  liveFinancial: boolean;
  onToggle?: (v: boolean) => void;
  children?: React.ReactNode;
}) {
  const meta = wipeCategoryMeta(category);
  const Icon = categoryIcon(category);
  const isCreatorLock = lockReason?.startsWith("Protected");

  return (
    <div
      className={cn(
        "rounded-md border transition-colors",
        locked
          ? "border-border/60 bg-muted/20 opacity-75"
          : checked
            ? "border-rose-500/40 bg-rose-500/[0.04]"
            : "border-border",
      )}
    >
      <label
        className={cn(
          "flex items-start gap-3 p-3",
          locked ? "cursor-not-allowed" : "cursor-pointer",
        )}
      >
        <Checkbox
          checked={checked}
          disabled={locked}
          onCheckedChange={(v) => onToggle?.(Boolean(v))}
          aria-label={`Select ${meta.label}`}
          className="mt-0.5"
        />
        <span className="flex min-w-0 flex-1 items-start gap-2">
          <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="text-sm font-medium text-foreground">
                {meta.label}
              </span>
              {lockReason && (
                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[10px] font-medium",
                    isCreatorLock
                      ? "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400"
                      : "border-border bg-muted/40 text-muted-foreground",
                  )}
                >
                  {isCreatorLock ? (
                    <ShieldX className="size-3" />
                  ) : (
                    <Lock className="size-3" />
                  )}
                  {lockReason}
                </span>
              )}
              {!locked && liveFinancial && (
                <span className="inline-flex items-center gap-1 rounded-full border border-rose-500/40 bg-rose-500/10 px-1.5 py-px text-[10px] font-medium text-rose-500">
                  <ShieldAlert className="size-3" />
                  Live financial
                </span>
              )}
            </span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {meta.blurb}
            </span>
            {locked && disabledReason && (
              <span className="mt-1 block text-[11px] text-muted-foreground/80">
                {disabledReason}
              </span>
            )}
          </span>
        </span>
      </label>
      {checked && !locked && children && (
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

function DepositsInline({ state }: { state: LoadState<DepositsPreview> | null }) {
  return (
    <InlineWrapper state={state}>
      {state?.status === "ready" && (
        <div className="space-y-2 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">
              {state.data.count.toLocaleString()} deposit
              {state.data.count === 1 ? "" : "s"} · total
            </span>
            <span className={cn("font-semibold tabular-nums", ROSE)}>
              {formatCurrency(state.data.totalAmount)}
            </span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">
              Lifetime deposited counter
            </span>
            <span className="text-foreground/80 tabular-nums">
              {formatCurrency(state.data.totalDeposited)} → reduced by{" "}
              {formatCurrency(
                Math.min(state.data.totalAmount, state.data.totalDeposited),
              )}
            </span>
          </div>
          {state.data.count <= 0 ? (
            <EmptyNote what="deposit history" />
          ) : (
            <>
              <DangerWarning kind="deposits" />
              {state.data.recent.length > 0 && (
                <div className="space-y-1">
                  <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    Most recent
                  </p>
                  <div className="max-h-40 divide-y overflow-y-auto rounded border bg-background/50">
                    {state.data.recent.map((d) => (
                      <div
                        key={d.id}
                        className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-xs"
                      >
                        <span className="min-w-0 flex-1 truncate text-muted-foreground">
                          {formatDateTime(d.createdAt)}
                        </span>
                        <span
                          className={cn(
                            "shrink-0 font-medium tabular-nums",
                            ROSE,
                          )}
                        >
                          {formatCurrency(d.amount)}
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
                deposits, withdrawals and gaming rows are never listed.
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
// category with a grand total, the role-aware preserved section, the combined
// live-financial danger banner, and the SINGLE 2FA field.
// ───────────────────────────────────────────────────────────────────────────
function ConfirmPhase({
  runnableCategories,
  everCreator,
  anyLiveFinancialSelected,
  balanceAmt,
  vaultAmt,
  adjAmt,
  depositsAmt,
  depositsCount,
  adjSelectedRows,
  moneyTotal,
  invCount,
  invValue,
  totpCode,
  setTotpCode,
  excludeFromStats,
  setExcludeFromStats,
  allEnabledCategories,
  onWipeAll,
  isPending,
}: {
  runnableCategories: readonly SelectableCategory[];
  everCreator: boolean;
  anyLiveFinancialSelected: boolean;
  balanceAmt: number;
  vaultAmt: number;
  adjAmt: number;
  depositsAmt: number;
  depositsCount: number;
  adjSelectedRows: WipeableAdjustment[];
  moneyTotal: number;
  invCount: number;
  invValue: number;
  totpCode: string;
  setTotpCode: (v: string) => void;
  /** "Also remove from all stats" toggle (default ON; controls the partial-wipe exclusion). */
  excludeFromStats: boolean;
  setExcludeFromStats: (v: boolean) => void;
  /** Every enabled, non-locked category — what WIPE ALL will hit. */
  allEnabledCategories: readonly SelectableCategory[];
  /** Fire the nuke-everything WIPE ALL run (all enabled categories + exclusion). */
  onWipeAll: () => void;
  isPending: boolean;
}) {
  const wantsAdjustments = runnableCategories.includes("adjustments");
  const wantsBalance = runnableCategories.includes("balance");
  const wantsVault = runnableCategories.includes("vault");
  const wantsInventory = runnableCategories.includes("inventory");
  const wantsDeposits = runnableCategories.includes("deposits");

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

        {wantsDeposits && (
          <SummaryBlock
            icon={ArrowDownToLine}
            label={`Deposits (${depositsCount.toLocaleString()})`}
            amount={depositsAmt}
            danger="Deletes real deposit history — recoverable via snapshot"
          >
            <p className="text-xs text-muted-foreground">
              {depositsCount.toLocaleString()} deposit
              {depositsCount === 1 ? "" : "s"} · {formatCurrency(depositsAmt)} ·
              lifetime deposited counter reduced
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

        {/* Grand total. Money pools (balance + vault + adjustments + deposits)
            sum to one cash figure; inventory value is a card-value estimate
            shown alongside (different unit, not folded into the cash
            headline). */}
        <div className="border-t border-rose-500/20 pt-2.5">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-foreground">
              Grand total
            </span>
            <span className={cn("text-base font-bold tabular-nums", ROSE)}>
              {formatCurrency(moneyTotal + invValue)}
            </span>
          </div>
          {wantsInventory && moneyTotal > 0 && (
            <p className="mt-1 text-right text-[11px] text-muted-foreground">
              {formatCurrency(moneyTotal)} balance / finance +{" "}
              {formatCurrency(invValue)} inventory value
            </p>
          )}
        </div>
      </div>

      {/* Combined live-financial danger banner. */}
      {anyLiveFinancialSelected && (
        <div className="rounded-md border border-rose-500/40 bg-rose-500/[0.08] p-3 text-sm">
          <p className="flex items-start gap-2 font-medium text-rose-500 dark:text-rose-400">
            <ShieldAlert className="mt-0.5 size-4 shrink-0" />
            <span>
              One or more selected categories delete REAL financial /
              transaction history (not house-granted content value). This is
              recoverable via the per-category snapshot, but it changes the
              user&apos;s real records — double-check before confirming.
            </span>
          </p>
        </div>
      )}

      {/* WILL NOT TOUCH — role-aware preserved promise. */}
      <PreservedPanel everCreator={everCreator} />

      <div className="rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-sm">
        <p className="flex items-center gap-2 font-medium text-rose-400">
          <ShieldAlert className="size-4" />
          Destructive but recoverable — each category snapshots first and is
          individually restorable from the wipe history.
        </p>
      </div>

      {/* Also remove from all stats — non-destructive blacklist add (default
          ON). Adds the user to the excluded-users list so they vanish from
          every metric surface (dashboard / GGR / analytics / insights / P&L).
          Deletes nothing, so it is safe even for creators. WIPE ALL always
          does this regardless of this toggle. */}
      <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border bg-muted/20 p-3 text-sm">
        <Checkbox
          checked={excludeFromStats}
          onCheckedChange={(v) => setExcludeFromStats(Boolean(v))}
          className="mt-0.5"
          aria-label="Also remove from all stats"
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 font-medium text-foreground">
            <BarChart3 className="size-3.5 text-muted-foreground" />
            Also remove from all stats
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            Adds this user to the excluded-users list so they disappear from
            every metric surface — dashboard, GGR, analytics, insights and P&L.
            Non-destructive (deletes nothing, just filters them out) and
            reversible from the excluded-users page.
          </span>
        </span>
      </label>

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
          One code runs all selected wipes{excludeFromStats ? " + the stat removal" : ""} in
          sequence.
        </p>
      </div>

      {/* ───────────────────────────────────────────────────────────────────
          WIPE ALL — bottom-left nuke-everything control. Selects every
          currently-ENABLED category, runs them through the SAME single 2FA
          gate (the code above), and ALWAYS removes the user from all stats.
          Disabled ("coming soon") + creator-protected categories are NOT
          touched. Deliberately loud + unmistakably destructive. */}
      <WipeAllPanel
        everCreator={everCreator}
        allEnabledCategories={allEnabledCategories}
        totpReady={Boolean(totpCode.trim())}
        isPending={isPending}
        onWipeAll={onWipeAll}
      />
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// WIPE ALL panel — the bottom-left destructive "nuke everything wipeable for
// this user" control inside the confirm step. Big red warning, explicit list
// of what it hits + the role-aware WILL-NOT-TOUCH note, and a button that runs
// every enabled category + the stat-exclusion through the existing single 2FA
// gate. It NEVER enables a disabled category and NEVER bypasses creator-
// protection (the locked categories are excluded from `allEnabledCategories`).
// ───────────────────────────────────────────────────────────────────────────
function WipeAllPanel({
  everCreator,
  allEnabledCategories,
  totpReady,
  isPending,
  onWipeAll,
}: {
  everCreator: boolean;
  allEnabledCategories: readonly SelectableCategory[];
  totpReady: boolean;
  isPending: boolean;
  onWipeAll: () => void;
}) {
  // Human labels for the categories WIPE ALL will hit (in run order).
  const hitLabels = allEnabledCategories.map((c) => wipeCategoryMeta(c).label);

  return (
    <div className="rounded-md border-2 border-rose-600/70 bg-rose-600/[0.09] p-3.5 shadow-[0_0_0_1px_rgba(225,29,72,0.15)]">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-rose-600/20 text-rose-600 dark:text-rose-400">
          <Skull className="size-4" />
        </span>
        <div className="min-w-0 flex-1 space-y-2">
          <div>
            <p className="flex items-center gap-1.5 text-sm font-bold uppercase tracking-wide text-rose-600 dark:text-rose-400">
              <AlertTriangle className="size-4" />
              Danger zone — WIPE ALL
            </p>
            <p className="mt-1 text-xs text-rose-600/90 dark:text-rose-300/90">
              Nukes <span className="font-semibold">everything wipeable</span>{" "}
              for this user in one go and removes them from all stats. Each part
              is snapshotted + individually restorable, but{" "}
              <span className="font-semibold">
                this cannot be easily undone
              </span>{" "}
              — restore is per-category, by hand, from the wipe history.
            </p>
          </div>

          {/* What it will hit. */}
          {hitLabels.length > 0 ? (
            <div className="rounded border border-rose-600/30 bg-background/40 px-2.5 py-2 text-xs">
              <p className="font-medium text-foreground">
                Will run ({hitLabels.length}):
              </p>
              <p className="mt-0.5 text-muted-foreground">
                {hitLabels.join(" · ")}
                {" · "}
                <span className="font-medium text-rose-600 dark:text-rose-400">
                  remove from all stats
                </span>
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground/80">
                Empty categories are skipped. Disabled “coming soon” categories
                are not touched.
              </p>
            </div>
          ) : (
            <div className="rounded border border-rose-600/30 bg-background/40 px-2.5 py-2 text-xs text-muted-foreground">
              No wipeable category is available for this user
              {everCreator ? " (creator-protected)" : ""} — WIPE ALL will only
              remove them from all stats.
            </div>
          )}

          {/* Role-aware WILL NOT TOUCH note. */}
          <p className="flex items-start gap-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">
            <ShieldCheck className="mt-px size-3 shrink-0" />
            <span>
              Will NOT touch: {wipePreservedSummary(everCreator)}
            </span>
          </p>

          <Button
            size="sm"
            variant="destructive"
            className="w-full bg-rose-600 hover:bg-rose-700 sm:w-auto"
            onClick={onWipeAll}
            disabled={isPending || !totpReady}
            title={
              !totpReady ? "Enter your 2FA code above first" : undefined
            }
          >
            {isPending ? (
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
            ) : (
              <Skull className="mr-1.5 size-3.5" />
            )}
            {isPending ? "Wiping…" : "WIPE ALL + remove from stats"}
          </Button>
          {!totpReady && (
            <p className="text-[11px] text-rose-600/80 dark:text-rose-400/80">
              Enter your 2FA code above to enable WIPE ALL.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function SummaryBlock({
  icon: Icon,
  label,
  amount,
  danger,
  children,
}: {
  icon: LucideIcon;
  label: string;
  amount: number;
  danger?: string;
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
      {danger && (
        <p className="flex items-start gap-1.5 text-[11px] text-rose-500">
          <ShieldAlert className="mt-px size-3 shrink-0" />
          {danger}
        </p>
      )}
      {children}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// RUNNING PHASE — per-step execution status so a partial run is legible. Each
// step is a wipe category OR the final non-destructive "remove from all stats"
// step (rendered with its own label/icon).
// ───────────────────────────────────────────────────────────────────────────
function RunningPhase({
  results,
  isWipeAll,
}: {
  results: RunResult[];
  isWipeAll: boolean;
}) {
  return (
    <div className="space-y-2">
      {isWipeAll && (
        <div className="rounded-md border border-rose-600/40 bg-rose-600/[0.07] px-3 py-2 text-xs font-medium text-rose-600 dark:text-rose-400">
          <span className="flex items-center gap-1.5">
            <Skull className="size-3.5" />
            WIPE ALL in progress — running every enabled category + removing from
            all stats.
          </span>
        </div>
      )}
      <div className="divide-y rounded-md border">
        {results.map((r, i) => {
          const label =
            r.kind === "exclude"
              ? "Remove from all stats"
              : wipeCategoryMeta(r.category).label;
          const Icon = r.kind === "exclude" ? BarChart3 : categoryIcon(r.category);
          const key = r.kind === "exclude" ? `exclude-${i}` : r.category;
          return (
            <div
              key={key}
              className="flex items-center gap-3 px-3 py-2.5 text-sm"
            >
              <Icon className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="font-medium text-foreground">{label}</div>
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
        of them from the wipe history. Removing from all stats is reversible from
        the excluded-users page.
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

/** Per-category live-financial danger warning shown inline in the preview. */
function DangerWarning({ kind }: { kind: "deposits" }) {
  const copy =
    kind === "deposits"
      ? "Deletes real deposit history and reduces the lifetime deposited counter. Recoverable via snapshot, but this is real financial data — not house-granted content value."
      : "Deletes real financial/transaction history — recoverable via snapshot.";
  return (
    <p className="flex items-start gap-1.5 rounded border border-rose-500/40 bg-rose-500/[0.07] px-2.5 py-1.5 text-xs text-rose-500">
      <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
      <span>{copy}</span>
    </p>
  );
}

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
 * The non-selectable "WILL NOT TOUCH" section, ROLE-AWARE. For a creator/ex-
 * creator it spells out the protected finance/deposits/affiliate/deal set; for
 * a never-creator it states the structurally un-wipeable surfaces (affiliate
 * tables, deal ledger flows). Same promise the server-side guards enforce.
 */
function PreservedPanel({ everCreator }: { everCreator: boolean }) {
  return (
    <div className="rounded-md border border-emerald-500/30 bg-emerald-500/[0.05] p-3 text-sm">
      <p className="flex items-start gap-2 text-emerald-600 dark:text-emerald-400">
        <ShieldCheck className="mt-0.5 size-4 shrink-0" />
        <span>
          <span className="font-semibold">
            Will NOT touch — not selectable.
          </span>{" "}
          {wipePreservedSummary(everCreator)}
        </span>
      </p>
    </div>
  );
}
