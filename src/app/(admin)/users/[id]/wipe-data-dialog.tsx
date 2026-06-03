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
  Skull,
  AlertTriangle,
} from "lucide-react";
// Receipt is already imported above for the PnL wipe icon (matches the
// categories.ts "receipt" mapping).
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
  previewWagerWipe,
  wipeWager,
  type WagerWipePreview,
} from "./wipe-wager-actions";
import {
  previewGameWipe,
  wipeGame,
  type GameWipePreview,
} from "./wipe-game-actions";
import {
  previewPnlWipe,
  wipePnl,
  type PnlWipePreview,
} from "./wipe-pnl-actions";
// The window const + type come from the CLIENT-SAFE module, NOT the "use server"
// action file: a runtime const imported from a server-action module is a server
// reference (not the array) on the client and crashed the dialog on `.map`.
import {
  WAGER_WIPE_WINDOW_OPTIONS,
  type WagerWipeWindowHours,
} from "@/lib/account-wipes/wager-window";
import {
  WIPE_WINDOW_OPTIONS,
  type WipeWindowHours,
} from "@/lib/account-wipes/window";
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
// House-POV emerald: the user LOST value (a debit adjustment = the house took
// balance). Used for the debit rows in the adjustments list.
const EMERALD = "text-emerald-600 dark:text-emerald-400";

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
// The wager preview is exactly the server action's payload.
type WagerPreview = WagerWipePreview;
type GamePreview = GameWipePreview;
type PnlPreview = PnlWipePreview;

type LoadState<T> =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; data: T };

// The selectable, ENABLED categories whose previews this dialog loads + runs.
// Disabled (coming-soon) categories are rendered greyed-out and are never
// loaded or executed. Adjustments is row-selectable; the rest are all-or-
// nothing. Deposits is creator-protected (disabled for an ever-creator).
// Wager (gameplay) is all-or-nothing + not creator-protected.
type SelectableCategory =
  | "adjustments"
  | "balance"
  | "vault"
  | "inventory"
  | "deposits"
  | "wager"
  // New windowed wipes (critical-incident sweep, 2026-06-03). Each has its OWN
  // independent 12h / 24h / 48h selector (never null/all — always bounded).
  | "game"
  | "pnl";

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
// skipped because an earlier one aborted the sequence). Every run step is a
// wipe category — the wipe flow is purely destructive (real deletions only);
// there is NO stat-exclusion step (the owner rejected excluding users
// entirely — "excluding users is no option").
type RunStatus = "pending" | "running" | "success" | "failed" | "skipped";
type RunResult = {
  category: SelectableCategory;
  status: RunStatus;
  message: string;
};

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
    wager: false,
    game: false,
    pnl: false,
  });

  // True only while a WIPE ALL run is executing — drives the running-phase
  // banner copy.
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
  const [wager, setWager] = useState<LoadState<WagerPreview> | null>(null);
  // The recent WINDOW the Wager/gameplay wipe is bounded to (owner's heavy-
  // account timeout fix). Default to a BOUNDED window (24h) so the common case
  // (a heavy account that times out on a full wipe) is fast; `null` = "All"
  // keeps the full-wipe behaviour for a light account. Changing it re-loads the
  // wager preview so the counts + warning reflect the chosen window.
  const [wagerWindow, setWagerWindow] = useState<WagerWipeWindowHours>(24);

  // Game / PnL windowed wipe state (critical-incident sweep, 2026-06-03). Each
  // has its OWN independent 12 / 24 / 48 window selector; default 24h. Always
  // bounded — no "All" sentinel.
  const [game, setGame] = useState<LoadState<GamePreview> | null>(null);
  const [gameWindow, setGameWindow] = useState<WipeWindowHours>(24);
  const [pnl, setPnl] = useState<LoadState<PnlPreview> | null>(null);
  const [pnlWindow, setPnlWindow] = useState<WipeWindowHours>(24);

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
      wager: false,
      game: false,
      pnl: false,
    });
    setBalance(null);
    setVault(null);
    setInventory(null);
    setDeposits(null);
    setWager(null);
    setWagerWindow(24);
    setGame(null);
    setGameWindow(24);
    setPnl(null);
    setPnlWindow(24);
    setAdjState(null);
    setAdjSelected(new Set());
    setAdjSearch("");
    setResults([]);
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

  // Load the wager preview for a given window. Defaults to the current
  // `wagerWindow` (so the first tick uses the bounded default); the window
  // selector passes the freshly-chosen value explicitly to avoid a stale
  // closure. The returned preview's counts are bounded to that window.
  const loadWager = useCallback(
    (hours: WagerWipeWindowHours = wagerWindow) => {
      setWager({ status: "loading" });
      previewWagerWipe(userId, hours)
        .then((res) =>
          setWager(
            res.success
              ? { status: "ready", data: res.preview }
              : { status: "error", error: res.error },
          ),
        )
        // A rejected preview Server Action is caught here and turned into an
        // inline error state (with a Retry button in WagerInline) + a toast —
        // it must NEVER surface as an unhandled rejection that bubbles to the
        // root error boundary and white-screens the app.
        .catch((e) => {
          const msg = e instanceof Error ? e.message : "Failed to load";
          setWager({ status: "error", error: msg });
          toast.error(`Could not load the wager preview: ${msg}`);
        });
    },
    [userId, wagerWindow],
  );

  // Change the wager window + re-fetch its preview so the counts + warning
  // reflect the new window. Only re-loads while the wager category is ticked
  // (otherwise it just records the choice for when it's next ticked).
  const changeWagerWindow = useCallback(
    (hours: WagerWipeWindowHours) => {
      setWagerWindow(hours);
      if (checked.wager) loadWager(hours);
    },
    [checked.wager, loadWager],
  );

  // Game wipe loader + window change. Same shape as the wager loader.
  const loadGame = useCallback(
    (hours: WipeWindowHours = gameWindow) => {
      setGame({ status: "loading" });
      previewGameWipe(userId, hours)
        .then((res) =>
          setGame(
            res.success
              ? { status: "ready", data: res.preview }
              : { status: "error", error: res.error },
          ),
        )
        .catch((e) => {
          const msg = e instanceof Error ? e.message : "Failed to load";
          setGame({ status: "error", error: msg });
          toast.error(`Could not load the game preview: ${msg}`);
        });
    },
    [userId, gameWindow],
  );
  const changeGameWindow = useCallback(
    (hours: WipeWindowHours) => {
      setGameWindow(hours);
      if (checked.game) loadGame(hours);
    },
    [checked.game, loadGame],
  );

  // PnL wipe loader + window change.
  const loadPnl = useCallback(
    (hours: WipeWindowHours = pnlWindow) => {
      setPnl({ status: "loading" });
      previewPnlWipe(userId, hours)
        .then((res) =>
          setPnl(
            res.success
              ? { status: "ready", data: res.preview }
              : { status: "error", error: res.error },
          ),
        )
        .catch((e) => {
          const msg = e instanceof Error ? e.message : "Failed to load";
          setPnl({ status: "error", error: msg });
          toast.error(`Could not load the PnL preview: ${msg}`);
        });
    },
    [userId, pnlWindow],
  );
  const changePnlWindow = useCallback(
    (hours: WipeWindowHours) => {
      setPnlWindow(hours);
      if (checked.pnl) loadPnl(hours);
    },
    [checked.pnl, loadPnl],
  );

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
    if (cat === "wager" && wager === null) loadWager();
    if (cat === "game" && game === null) loadGame();
    if (cat === "pnl" && pnl === null) loadPnl();
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
  // Signed sum of the selected adjustments (credits + debits) — informational.
  const adjSignedTotal = useMemo(
    () => adjSelectedRows.reduce((acc, r) => acc + r.amount, 0),
    [adjSelectedRows],
  );
  // The amount actually removed from the balance = Σ positive (credit) amounts
  // only. Deleting a debit leaves the balance unchanged (BALANCE RULE), so it
  // contributes 0 here. This is what feeds the cash grand-total.
  const adjCreditClawback = useMemo(
    () => adjSelectedRows.reduce((acc, r) => (r.amount > 0 ? acc + r.amount : acc), 0),
    [adjSelectedRows],
  );
  // How many selected rows are debits (records deleted, balance untouched).
  const adjDebitCount = useMemo(
    () => adjSelectedRows.reduce((acc, r) => (r.amount < 0 ? acc + 1 : acc), 0),
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
  // The adjustments' contribution to the cash grand-total is the CREDIT
  // clawback (what actually leaves the balance) — NOT the signed sum, since
  // deleting a debit removes no money.
  const adjAmt = checked.adjustments ? adjCreditClawback : 0;
  const depositsAmt =
    checked.deposits && deposits?.status === "ready"
      ? deposits.data.totalAmount
      : 0;
  // The wager category's cash contribution = the PAYOUT clawback (what leaves
  // the balance). The won-inventory value is a GGR-value estimate surfaced
  // separately (different unit, not folded into cash) alongside the inventory.
  const wagerData =
    checked.wager && wager?.status === "ready" ? wager.data : null;
  const wagerPayoutAmt = wagerData ? wagerData.payoutTotal : 0;
  // The money grand-total across the selected MONEY categories (balance, vault,
  // selected adjustments [credit clawback], deposits, wager payout clawback).
  // Inventory + won-card value are card-value estimates (different unit) and
  // are surfaced alongside, not folded into this cash figure.
  const moneyTotal = balanceAmt + vaultAmt + adjAmt + depositsAmt + wagerPayoutAmt;
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
        case "wager":
          return (
            wager?.status === "ready" &&
            (wager.data.ledgerLegCount > 0 ||
              wager.data.inventoryCount > 0 ||
              wager.data.upgraderGameCount > 0)
          );
        case "game":
          return (
            game?.status === "ready" &&
            (game.data.ledgerLegCount > 0 ||
              game.data.inventoryCount > 0 ||
              game.data.upgraderGameCount > 0)
          );
        case "pnl":
          return (
            pnl?.status === "ready" &&
            (pnl.data.ledgerLegCount > 0 ||
              pnl.data.inventoryCount > 0 ||
              pnl.data.voucherCount > 0 ||
              pnl.data.upgraderGameCount > 0)
          );
        case "adjustments":
          return adjSelected.size > 0;
      }
    },
    [balance, vault, inventory, deposits, wager, game, pnl, adjSelected],
  );

  // Order: PnL first (LARGEST scope), Game next, then Wager last so a WIPE-ALL
  // run lets the smaller, more-specific cleanups complete before the biggest
  // delete starts. Pre-existing categories keep their original positions.
  const SELECTABLE_ORDER: readonly SelectableCategory[] = useMemo(
    () => [
      "adjustments",
      "balance",
      "vault",
      "inventory",
      "deposits",
      "pnl",
      "game",
      "wager",
    ],
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
    if (c === "wager") return !wager || wager.status === "loading";
    if (c === "game") return !game || game.status === "loading";
    if (c === "pnl") return !pnl || pnl.status === "loading";
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
    if (c === "wager") return wager?.status === "error";
    if (c === "game") return game?.status === "error";
    if (c === "pnl") return pnl?.status === "error";
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

  // Whether every enabled (non-locked) category is already ticked — drives the
  // select-phase "Select all wipeable" toggle's label + checked styling.
  const allWipeableTicked =
    allEnabledCategories.length > 0 &&
    allEnabledCategories.every((c) => checked[c]);

  // Select-phase "WIPE ALL" affordance: tick (or untick) EVERY enabled, non-
  // locked, non-creator-protected category in one click. This only PRE-SELECTS
  // — it adds no new run path: the owner still proceeds through the existing
  // Review → confirm → single-2FA → "Wipe selected" flow, which runs exactly
  // the ticked + non-empty categories. Locked / disabled ("coming soon") /
  // creator-protected categories are never touched (they aren't in
  // `allEnabledCategories`). Ticking each one also kicks off its lazy preview
  // load via `toggleCategory`, same as a manual tick.
  function selectAllWipeable() {
    const next = !allWipeableTicked;
    for (const c of allEnabledCategories) {
      // Only flip categories that need flipping (avoids re-firing a load for an
      // already-ticked category) — toggleCategory guards the lazy load on the
      // "=== null" first-load check anyway, but this keeps it minimal.
      if (checked[c] !== next) toggleCategory(c, next);
    }
  }

  // ── Sequential multi-execute. One 2FA code, applied to each category's
  // EXISTING wipe action in turn. Each wipe action is independently
  // snapshot-first + recoverable, so a partial run is safe + individually
  // restorable from the wipe audit log. The flow is purely destructive — real
  // deletions only, with NO stat-exclusion step (the owner rejected excluding
  // users entirely).
  //
  //   • `seq`            — the ordered categories to wipe.
  //   • `adjIds`         — the adjustment ledger ids to wipe (for the
  //                        adjustments category). Empty for WIPE ALL when no
  //                        adjustments exist.
  //   • `softSkipEmpty`  — WIPE ALL mode: treat a category's "nothing to wipe"
  //                        / "already $0" empty-result as a SKIP rather than an
  //                        aborting failure (so an empty vault doesn't stop the
  //                        balance/inventory wipes). A REAL failure still
  //                        aborts the remaining wipes.
  //   • `wipeAll`        — drives the running-phase banner copy.
  //
  // SINGLE 2FA GATE PRESERVED: one code drives every wipe action; each server
  // action independently re-verifies it (require2FA is stateless, no replay
  // lock), exactly as the existing multi-category run already does.
  const runSequence = useCallback(
    (opts: {
      seq: readonly SelectableCategory[];
      adjIds: string[];
      softSkipEmpty: boolean;
      wipeAll: boolean;
    }) => {
      const { seq, adjIds, softSkipEmpty, wipeAll } = opts;
      if (!totpCode.trim()) {
        toast.error("Enter your 2FA code");
        return;
      }
      if (seq.length === 0) {
        toast.error("Nothing selected to wipe");
        return;
      }
      const code = totpCode.trim();

      setIsWipeAllRun(wipeAll);
      setPhase("running");

      // Build the run plan: a step per category. Seeded all-pending so the UI
      // shows the full plan.
      const plan: RunResult[] = seq.map((category) => ({
        category,
        status: "pending" as RunStatus,
        message: "",
      }));
      setResults(plan.map((r) => ({ ...r })));

      startTransition(async () => {
        const finalResults: RunResult[] = plan.map((r) => ({ ...r }));
        const commit = () => setResults(finalResults.map((r) => ({ ...r })));

        // Treat a category server-action error string that means "the category
        // was empty" as a soft-skip in WIPE ALL mode (an empty category is a
        // no-op, not a failure that should abort the rest).
        const isEmptyErr = (msg: string): boolean =>
          /nothing to wipe|already \$0|no inventory|no deposits|no wager|at least one adjustment/i.test(
            msg,
          );

        let aborted = false;
        for (let i = 0; i < finalResults.length; i++) {
          const { category } = finalResults[i];
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
            const outcome = await runCategory(
              category,
              userId,
              code,
              adjIds,
              wagerWindow,
              gameWindow,
              pnlWindow,
            );
            if (outcome.success) {
              finalResults[i] = {
                category,
                status: "success",
                message: outcome.message,
              };
            } else if (softSkipEmpty && isEmptyErr(outcome.error)) {
              // Empty category under WIPE ALL → skip, don't abort the rest.
              finalResults[i] = {
                category,
                status: "skipped",
                message: "Nothing to wipe — empty, skipped",
              };
            } else {
              finalResults[i] = {
                category,
                status: "failed",
                message: outcome.error,
              };
              aborted = true;
            }
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
    [totpCode, userId, router, wagerWindow, gameWindow, pnlWindow],
  );

  // Normal "Wipe selected" path: run the ticked, non-empty categories. Empty
  // categories can't reach here (runnableCategories excludes them), so
  // softSkipEmpty is off.
  function handleRun() {
    runSequence({
      seq: runnableCategories,
      adjIds: Array.from(adjSelected),
      softSkipEmpty: false,
      wipeAll: false,
    });
  }

  // WIPE ALL: run EVERY enabled, non-locked category (empties soft-skipped).
  // Loads the full adjustment list first (its ids are needed by the
  // adjustments action) — the only preview WIPE ALL depends on;
  // balance/vault/inventory/deposits/wager re-read server-side. The single 2FA
  // gate is unchanged (the code already entered in the confirm step drives
  // every action). NO stat-exclusion runs — WIPE ALL is purely the real
  // deletions (the owner rejected excluding users entirely).
  const handleWipeAll = useCallback(() => {
    if (!totpCode.trim()) {
      toast.error("Enter your 2FA code");
      return;
    }
    if (allEnabledCategories.length === 0) {
      // No destructive category is available (e.g. fully creator-protected) —
      // there is nothing to do (exclusion is no longer part of the flow).
      toast.error("No wipeable category is available for this user");
      return;
    }

    const start = (adjIds: string[]) =>
      runSequence({
        seq: allEnabledCategories,
        adjIds,
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
            allEnabledCount={allEnabledCategories.length}
            allWipeableTicked={allWipeableTicked}
            onSelectAllWipeable={selectAllWipeable}
            balance={balance}
            vault={vault}
            inventory={inventory}
            deposits={deposits}
            wager={wager}
            wagerWindow={wagerWindow}
            onWagerWindowChange={changeWagerWindow}
            onWagerReload={loadWager}
            game={game}
            gameWindow={gameWindow}
            onGameWindowChange={changeGameWindow}
            onGameReload={loadGame}
            pnl={pnl}
            pnlWindow={pnlWindow}
            onPnlWindowChange={changePnlWindow}
            onPnlReload={loadPnl}
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
            adjSignedTotal={adjSignedTotal}
            adjCreditClawback={adjCreditClawback}
            adjDebitCount={adjDebitCount}
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
            adjDebitCount={adjDebitCount}
            wagerData={wagerData}
            gameData={
              checked.game && game?.status === "ready" ? game.data : null
            }
            pnlData={checked.pnl && pnl?.status === "ready" ? pnl.data : null}
            moneyTotal={moneyTotal}
            invCount={invCount}
            invValue={invValue}
            totpCode={totpCode}
            setTotpCode={setTotpCode}
            allEnabledCategories={allEnabledCategories}
            wagerWindow={wagerWindow}
            gameWindow={gameWindow}
            pnlWindow={pnlWindow}
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
  wagerWindow: WagerWipeWindowHours,
  gameWindow: WipeWindowHours,
  pnlWindow: WipeWindowHours,
): Promise<{ success: true; message: string } | { success: false; error: string }> {
  if (category === "adjustments") {
    const res = await wipeBalanceAdjustments({
      userId,
      ledgerIds: adjIds,
      totpCode,
    });
    if (!res.success) return { success: false, error: res.error };
    // Report what actually LEFT the balance (the credit clawback =
    // balanceBefore − balanceAfter), not the signed sum — a debit-only batch
    // removes records without changing the balance, so this reads $0 there.
    const removedFromBalance = res.balanceBefore - res.balanceAfter;
    return {
      success: true,
      message: `Deleted ${res.deletedCount} adjustment${res.deletedCount === 1 ? "" : "s"} · ${formatCurrency(removedFromBalance)} clawed back from balance`,
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
  if (category === "wager") {
    const res = await wipeWager({ userId, totpCode, sinceHours: wagerWindow });
    if (!res.success) return { success: false, error: res.error };
    const parts: string[] = [];
    if (res.ledgerLegsDeleted > 0)
      parts.push(`${res.ledgerLegsDeleted} ledger leg${res.ledgerLegsDeleted === 1 ? "" : "s"}`);
    if (res.inventoryDeleted > 0)
      parts.push(`${res.inventoryDeleted} won item${res.inventoryDeleted === 1 ? "" : "s"}`);
    if (res.upgraderGamesDeleted > 0)
      parts.push(`${res.upgraderGamesDeleted} upgrader game${res.upgraderGamesDeleted === 1 ? "" : "s"}`);
    const skipped =
      res.withdrawalLockedSkipped > 0
        ? ` · ${res.withdrawalLockedSkipped} withdrawal-locked card${res.withdrawalLockedSkipped === 1 ? "" : "s"} skipped`
        : "";
    const windowLabel =
      res.windowHours === null ? "all gameplay" : `last ${res.windowHours}h`;
    return {
      success: true,
      message: `Deleted ${parts.join(" · ") || "nothing"} (${windowLabel}) · ${formatCurrency(res.balanceReduced)} clawed back from balance${skipped}`,
    };
  }
  if (category === "game") {
    const res = await wipeGame({ userId, totpCode, windowHours: gameWindow });
    if (!res.success) return { success: false, error: res.error };
    const parts: string[] = [];
    if (res.ledgerLegsDeleted > 0)
      parts.push(`${res.ledgerLegsDeleted} ledger leg${res.ledgerLegsDeleted === 1 ? "" : "s"}`);
    if (res.inventoryDeleted > 0)
      parts.push(`${res.inventoryDeleted} won item${res.inventoryDeleted === 1 ? "" : "s"}`);
    if (res.upgraderGamesDeleted > 0)
      parts.push(`${res.upgraderGamesDeleted} upgrader game${res.upgraderGamesDeleted === 1 ? "" : "s"}`);
    const skipped =
      res.withdrawalLockedSkipped > 0
        ? ` · ${res.withdrawalLockedSkipped} withdrawal-locked card${res.withdrawalLockedSkipped === 1 ? "" : "s"} skipped`
        : "";
    return {
      success: true,
      message: `Deleted ${parts.join(" · ") || "nothing"} (last ${res.windowHours}h) · ${formatCurrency(res.balanceReduced)} clawed back from balance${skipped}`,
    };
  }
  if (category === "pnl") {
    const res = await wipePnl({ userId, totpCode, windowHours: pnlWindow });
    if (!res.success) return { success: false, error: res.error };
    const parts: string[] = [];
    if (res.ledgerLegsDeleted > 0)
      parts.push(`${res.ledgerLegsDeleted} ledger leg${res.ledgerLegsDeleted === 1 ? "" : "s"}`);
    if (res.inventoryDeleted > 0)
      parts.push(`${res.inventoryDeleted} won item${res.inventoryDeleted === 1 ? "" : "s"}`);
    if (res.vouchersDeleted > 0)
      parts.push(`${res.vouchersDeleted} voucher${res.vouchersDeleted === 1 ? "" : "s"}`);
    if (res.upgraderGamesDeleted > 0)
      parts.push(`${res.upgraderGamesDeleted} upgrader game${res.upgraderGamesDeleted === 1 ? "" : "s"}`);
    const skipped =
      res.withdrawalLockedSkipped > 0
        ? ` · ${res.withdrawalLockedSkipped} withdrawal-locked card${res.withdrawalLockedSkipped === 1 ? "" : "s"} skipped`
        : "";
    return {
      success: true,
      message: `Deleted ${parts.join(" · ") || "nothing"} (last ${res.windowHours}h) · ${formatCurrency(res.balanceReduced)} clawed back from balance${skipped}`,
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
  allEnabledCount,
  allWipeableTicked,
  onSelectAllWipeable,
  balance,
  vault,
  inventory,
  deposits,
  wager,
  wagerWindow,
  onWagerWindowChange,
  onWagerReload,
  game,
  gameWindow,
  onGameWindowChange,
  onGameReload,
  pnl,
  pnlWindow,
  onPnlWindowChange,
  onPnlReload,
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
  adjSignedTotal,
  adjCreditClawback,
  adjDebitCount,
  tickedLoadError,
}: {
  checked: Record<SelectableCategory, boolean>;
  onToggle: (cat: SelectableCategory, v: boolean) => void;
  everCreator: boolean;
  wasCreator: boolean;
  isCategoryLocked: (key: WipeCategory) => boolean;
  /** How many categories are enabled + non-locked (what "select all" hits). */
  allEnabledCount: number;
  /** Whether every enabled category is already ticked. */
  allWipeableTicked: boolean;
  /** Tick (or untick) every enabled, non-locked category in one click. */
  onSelectAllWipeable: () => void;
  balance: LoadState<BalancePreview> | null;
  vault: LoadState<VaultPreview> | null;
  inventory: LoadState<InventoryPreview> | null;
  deposits: LoadState<DepositsPreview> | null;
  wager: LoadState<WagerPreview> | null;
  /** The currently-selected wager wipe window (12 / 24 / 48 / null="All"). */
  wagerWindow: WagerWipeWindowHours;
  /** Change the wager window (re-loads the preview if the category is ticked). */
  onWagerWindowChange: (hours: WagerWipeWindowHours) => void;
  /** Re-fetch the wager preview for the current window (retry after an error). */
  onWagerReload: () => void;
  /** Game / PnL windowed-wipe state — independent 12 / 24 / 48 selectors per row. */
  game: LoadState<GamePreview> | null;
  gameWindow: WipeWindowHours;
  onGameWindowChange: (hours: WipeWindowHours) => void;
  onGameReload: () => void;
  pnl: LoadState<PnlPreview> | null;
  pnlWindow: WipeWindowHours;
  onPnlWindowChange: (hours: WipeWindowHours) => void;
  onPnlReload: () => void;
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
  adjSignedTotal: number;
  adjCreditClawback: number;
  adjDebitCount: number;
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
      {/* Select-phase WIPE ALL affordance: one click ticks every enabled,
          non-locked, non-creator-protected category, then the owner proceeds
          through the normal Review → confirm → 2FA flow (no separate run path,
          no disabled/creator-protected category selected). Compact + matches
          the dialog's other controls. Solid rose with EXPLICIT white text once
          everything is ticked (never red-on-red); soft destructive outline
          otherwise. */}
      {allEnabledCount > 1 && (
        <div className="flex items-center justify-between gap-2 rounded-md border border-rose-500/30 bg-rose-500/[0.04] px-3 py-2">
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Wipe everything?</span>{" "}
            Tick every wipeable category at once, then review + confirm with 2FA.
          </p>
          <Button
            type="button"
            size="sm"
            variant={allWipeableTicked ? "default" : "destructive"}
            className={cn(
              "shrink-0",
              allWipeableTicked
                ? "bg-rose-600 text-white hover:bg-rose-700 hover:text-white focus-visible:ring-rose-600/40 dark:bg-rose-600 dark:text-white dark:hover:bg-rose-700"
                : undefined,
            )}
            onClick={onSelectAllWipeable}
            aria-pressed={allWipeableTicked}
          >
            <Skull className="mr-1.5 size-3.5" />
            {allWipeableTicked ? "All selected" : "Select all"}
          </Button>
        </div>
      )}

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
                  key === "deposits" ||
                  key === "wager" ||
                  key === "game" ||
                  key === "pnl";
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
                    {key === "wager" && checked.wager && (
                      <WagerInline
                        state={wager}
                        window={wagerWindow}
                        onWindowChange={onWagerWindowChange}
                        onReload={onWagerReload}
                      />
                    )}
                    {key === "game" && checked.game && (
                      <GameInline
                        state={game}
                        window={gameWindow}
                        onWindowChange={onGameWindowChange}
                        onReload={onGameReload}
                      />
                    )}
                    {key === "pnl" && checked.pnl && (
                      <PnlInline
                        state={pnl}
                        window={pnlWindow}
                        onWindowChange={onPnlWindowChange}
                        onReload={onPnlReload}
                      />
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
                        signedTotal={adjSignedTotal}
                        creditClawback={adjCreditClawback}
                        debitCount={adjDebitCount}
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

function WagerInline({
  state,
  window,
  onWindowChange,
  onReload,
}: {
  state: LoadState<WagerPreview> | null;
  window: WagerWipeWindowHours;
  onWindowChange: (hours: WagerWipeWindowHours) => void;
  /** Re-fetch the preview for the current window (retry after a load error). */
  onReload: () => void;
}) {
  return (
    <div className="space-y-2.5">
      {/* WINDOW SELECTOR — always shown (above the loading/ready preview) so the
          admin can pick the window even while the counts re-load. A BOUNDED
          window (12/24/48h) keeps a heavy account's delete small + fast (it was
          timing out on a full wipe); "All" keeps the full-wipe behaviour. The
          counts + warning below reflect the chosen window. */}
      <WagerWindowSelector value={window} onChange={onWindowChange} />
      {/* CRASH-PROOF preview body: a failed preview Server Action is surfaced
          INLINE with a Retry button (never thrown, never bubbles to the root
          error boundary). loadWager already catches the rejection into this
          error state; here we make it actionable instead of a dead-end. */}
      {(!state || state.status === "loading") && (
        <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          Loading…
        </div>
      )}
      {state?.status === "error" && (
        <div className="flex items-start justify-between gap-2 rounded border border-rose-500/30 bg-rose-500/5 px-2.5 py-2">
          <p className="text-xs text-rose-500">
            Could not load the wager / gameplay preview
            {state.error ? `: ${state.error}` : ""}. The window selector still
            works — pick a window or retry.
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-6 shrink-0 px-2 text-xs"
            onClick={onReload}
          >
            Retry
          </Button>
        </div>
      )}
      <>
        {state?.status === "ready" && (
          <div className="space-y-2 text-sm">
            {/* Honest caveat: a bounded window removes ONLY that window's
                gameplay — older gameplay (and its effect on lifetime stats)
                remains until wiped too. Repeatable per window. */}
            {window !== null && (
              <p className="flex items-start gap-1.5 rounded border border-amber-500/30 bg-amber-500/[0.06] px-2.5 py-1.5 text-xs text-amber-600 dark:text-amber-400">
                <Info className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  Only the last {window}h of gameplay will be removed. Older
                  gameplay (and its effect on lifetime Total Wagered / Total Won
                  and GGR) stays until you wipe it too — repeat with this or a
                  wider window. Pick <span className="font-medium">All</span> to
                  remove everything at once (may be slow / time out on a very
                  heavy account).
                </span>
              </p>
            )}
            {state.data.ledgerLegCount === 0 &&
            state.data.inventoryCount === 0 &&
            state.data.upgraderGameCount === 0 ? (
              <EmptyNote
                what={
                  window === null
                    ? "wager / gameplay data"
                    : `wager / gameplay data in the last ${window}h`
                }
              />
            ) : (
              <>
              {/* Ledger legs (wager vs payout). */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">
                    {state.data.ledgerLegCount.toLocaleString()} wager + payout
                    ledger leg{state.data.ledgerLegCount === 1 ? "" : "s"}
                  </span>
                </div>
                <div className="divide-y rounded border bg-background/50">
                  <div className="flex items-center justify-between px-2.5 py-1.5 text-xs">
                    <span className="text-muted-foreground">
                      Wager placed (pack / battle / upgrader bets)
                    </span>
                    {/* House-POV: user staked money = house gain = emerald. */}
                    <span className={cn("tabular-nums font-medium", EMERALD)}>
                      {formatCurrency(state.data.wagerTotal)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between px-2.5 py-1.5 text-xs">
                    <span className="text-muted-foreground">
                      Payout legs (clawed back from balance)
                    </span>
                    {/* House-POV: user won money = house loss = rose. */}
                    <span className={cn("tabular-nums font-medium", ROSE)}>
                      {formatCurrency(state.data.payoutTotal)}
                    </span>
                  </div>
                </div>
              </div>

              {/* Won pack/battle inventory. */}
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">
                  {state.data.inventoryCount.toLocaleString()} won pack/battle
                  item{state.data.inventoryCount === 1 ? "" : "s"} · GGR value
                </span>
                <span className={cn("font-semibold tabular-nums", ROSE)}>
                  {formatCurrency(state.data.inventoryValue)}
                </span>
              </div>

              {/* Upgrader games. */}
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">
                  {state.data.upgraderTablePresent
                    ? `${state.data.upgraderGameCount.toLocaleString()} upgrader game${state.data.upgraderGameCount === 1 ? "" : "s"}`
                    : "Upgrader games (table not on this DB)"}
                </span>
                {state.data.upgraderTablePresent && (
                  <span className="text-foreground/80 tabular-nums">
                    bet {formatCurrency(state.data.upgraderBet)} · won{" "}
                    {formatCurrency(state.data.upgraderWon)}
                  </span>
                )}
              </div>

              {/* Balance clawback summary (payout legs only). */}
              <div className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-1.5 text-xs">
                <span className="text-muted-foreground">
                  Removed from balance (payout legs only)
                </span>
                <span className={cn("font-semibold tabular-nums", ROSE)}>
                  {formatCurrency(state.data.payoutTotal)}
                </span>
              </div>

              {state.data.withdrawalLockedSkipped > 0 && (
                <p className="flex items-start gap-1.5 rounded border border-amber-500/30 bg-amber-500/[0.06] px-2.5 py-1.5 text-xs text-amber-600 dark:text-amber-400">
                  <Info className="mt-0.5 size-3.5 shrink-0" />
                  <span>
                    {state.data.withdrawalLockedSkipped} won card
                    {state.data.withdrawalLockedSkipped === 1 ? "" : "s"} will be
                    SKIPPED — they back an in-flight withdrawal and can&apos;t be
                    safely deleted here.
                  </span>
                </p>
              )}

              {/* Heavy-account note: a large gameplay history can take a while
                  to delete (the wipe raises its DB statement timeout to 180s).
                  Surfaced so the admin expects the wait and keeps the dialog
                  open instead of assuming it hung. */}
              {state.data.ledgerLegCount +
                state.data.inventoryCount +
                state.data.upgraderGameCount >
                2000 && (
                <p className="flex items-start gap-1.5 rounded border border-amber-500/30 bg-amber-500/[0.06] px-2.5 py-1.5 text-xs text-amber-600 dark:text-amber-400">
                  <Info className="mt-0.5 size-3.5 shrink-0" />
                  <span>
                    Large account (
                    {(
                      state.data.ledgerLegCount +
                      state.data.inventoryCount +
                      state.data.upgraderGameCount
                    ).toLocaleString()}{" "}
                    rows) — this wipe can take up to a minute or two. Keep the
                    dialog open until it finishes; it either fully completes or
                    deletes nothing.
                  </span>
                </p>
              )}

              <DangerWarning kind="wager" />
              </>
            )}
          </div>
        )}
      </>
    </div>
  );
}

/**
 * The 12h / 24h / 48h / All window selector for the wager wipe. A bounded
 * window keeps a heavy account's delete small + fast (a full wipe was timing
 * out); "All" keeps the full-wipe behaviour for a light account. Segmented
 * button row, matching the dialog's clean style (no new UI deps).
 */
function WagerWindowSelector({
  value,
  onChange,
}: {
  value: WagerWipeWindowHours;
  onChange: (hours: WagerWipeWindowHours) => void;
}) {
  // The bounded options + the "All" sentinel, as { hours, label } entries.
  // DEFENSIVE: derive the bounded list from WAGER_WIPE_WINDOW_OPTIONS only when
  // it is genuinely an array. This const is now imported from a client-safe
  // module so it IS the real array; the Array.isArray guard is belt-and-braces
  // so any future client/server-boundary regression (which would hand the
  // client a function proxy instead of the array) degrades to just the "All"
  // option INSTEAD of throwing `.map is not a function` at render and
  // white-screening the whole app.
  const boundedOptions = Array.isArray(WAGER_WIPE_WINDOW_OPTIONS)
    ? WAGER_WIPE_WINDOW_OPTIONS
    : [];
  const options: ReadonlyArray<{ hours: WagerWipeWindowHours; label: string }> = [
    ...boundedOptions.map((h) => ({ hours: h as WagerWipeWindowHours, label: `${h}h` })),
    { hours: null, label: "All" },
  ];
  return (
    <div className="space-y-1">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Time window
      </p>
      <div className="inline-flex rounded-md border bg-background/50 p-0.5">
        {options.map((opt) => {
          const active = value === opt.hours;
          return (
            <button
              key={opt.label}
              type="button"
              onClick={() => onChange(opt.hours)}
              aria-pressed={active}
              className={cn(
                "rounded px-2.5 py-1 text-xs font-medium tabular-nums transition-colors",
                active
                  ? "bg-rose-500/15 text-rose-600 dark:text-rose-400"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Inline preview for the Game (12 / 24 / 48h) wipe. Smaller than the Wager
 * preview — Game wipe is windowed-only (no "All" sentinel) and only
 * decrements total_won (not total_wagered). Shape mirrors WagerInline.
 */
function GameInline({
  state,
  window,
  onWindowChange,
  onReload,
}: {
  state: LoadState<GamePreview> | null;
  window: WipeWindowHours;
  onWindowChange: (hours: WipeWindowHours) => void;
  onReload: () => void;
}) {
  return (
    <div className="space-y-2.5">
      <WipeWindowSelector value={window} onChange={onWindowChange} />
      {(!state || state.status === "loading") && (
        <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          Loading…
        </div>
      )}
      {state?.status === "error" && (
        <div className="flex items-start justify-between gap-2 rounded border border-rose-500/30 bg-rose-500/5 px-2.5 py-2">
          <p className="text-xs text-rose-500">
            Could not load the game preview{state.error ? `: ${state.error}` : ""}.
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-6 shrink-0 px-2 text-xs"
            onClick={onReload}
          >
            Retry
          </Button>
        </div>
      )}
      {state?.status === "ready" && (
        <div className="space-y-2 text-sm">
          <p className="flex items-start gap-1.5 rounded border border-amber-500/30 bg-amber-500/[0.06] px-2.5 py-1.5 text-xs text-amber-600 dark:text-amber-400">
            <Info className="mt-0.5 size-3.5 shrink-0" />
            <span>
              Pure gameplay events in the last {window}h. Only{" "}
              <span className="font-medium">total_won</span> is decremented —{" "}
              <span className="font-medium">total_wagered</span> is left as
              bookkeeping (Wager wipe&apos;s territory).
            </span>
          </p>
          {state.data.ledgerLegCount === 0 &&
          state.data.inventoryCount === 0 &&
          state.data.upgraderGameCount === 0 ? (
            <EmptyNote what={`gameplay events in the last ${window}h`} />
          ) : (
            <>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">
                  {state.data.ledgerLegCount.toLocaleString()} wager + payout
                  ledger leg{state.data.ledgerLegCount === 1 ? "" : "s"}
                </span>
                <span className={cn("font-semibold tabular-nums", ROSE)}>
                  {formatCurrency(state.data.payoutTotal)}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">
                  {state.data.inventoryCount.toLocaleString()} won pack/battle
                  item{state.data.inventoryCount === 1 ? "" : "s"}
                </span>
                <span className={cn("font-semibold tabular-nums", ROSE)}>
                  {formatCurrency(state.data.inventoryValue)}
                </span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">
                  {state.data.upgraderTablePresent
                    ? `${state.data.upgraderGameCount.toLocaleString()} upgrader game${state.data.upgraderGameCount === 1 ? "" : "s"}`
                    : "Upgrader games (table not on this DB)"}
                </span>
              </div>
              {state.data.withdrawalLockedSkipped > 0 && (
                <p className="flex items-start gap-1.5 rounded border border-amber-500/30 bg-amber-500/[0.06] px-2.5 py-1.5 text-xs text-amber-600 dark:text-amber-400">
                  <Info className="mt-0.5 size-3.5 shrink-0" />
                  <span>
                    {state.data.withdrawalLockedSkipped} won card
                    {state.data.withdrawalLockedSkipped === 1 ? "" : "s"} will be
                    SKIPPED — they back an in-flight withdrawal.
                  </span>
                </p>
              )}
              <DangerWarning kind="game" />
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Inline preview for the PnL (12 / 24 / 48h) wipe — the LARGEST of the three
 * windowed wipes. Same shape as GameInline plus deposits/withdrawals/rewards/
 * vouchers/adjustments summary.
 */
function PnlInline({
  state,
  window,
  onWindowChange,
  onReload,
}: {
  state: LoadState<PnlPreview> | null;
  window: WipeWindowHours;
  onWindowChange: (hours: WipeWindowHours) => void;
  onReload: () => void;
}) {
  return (
    <div className="space-y-2.5">
      <WipeWindowSelector value={window} onChange={onWindowChange} />
      {(!state || state.status === "loading") && (
        <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          Loading…
        </div>
      )}
      {state?.status === "error" && (
        <div className="flex items-start justify-between gap-2 rounded border border-rose-500/30 bg-rose-500/5 px-2.5 py-2">
          <p className="text-xs text-rose-500">
            Could not load the PnL preview{state.error ? `: ${state.error}` : ""}.
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-6 shrink-0 px-2 text-xs"
            onClick={onReload}
          >
            Retry
          </Button>
        </div>
      )}
      {state?.status === "ready" && (
        <div className="space-y-2 text-sm">
          <p className="flex items-start gap-1.5 rounded border border-rose-500/40 bg-rose-500/[0.07] px-2.5 py-1.5 text-xs text-rose-500">
            <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>
              LARGEST scope of the three windowed wipes. Removes every
              PnL-affecting event in the last {window}h — deposits, gameplay
              legs + won inventory, rewards, vouchers, admin adjustments.
              Counters: total_wagered / total_won / total_deposited
              decremented. Snapshotted + restorable.
            </span>
          </p>
          {state.data.ledgerLegCount === 0 &&
          state.data.inventoryCount === 0 &&
          state.data.voucherCount === 0 &&
          state.data.upgraderGameCount === 0 ? (
            <EmptyNote what={`PnL-affecting events in the last ${window}h`} />
          ) : (
            <>
              <div className="divide-y rounded border bg-background/50">
                <div className="flex items-center justify-between px-2.5 py-1.5 text-xs">
                  <span className="text-muted-foreground">
                    Deposits (cash in)
                  </span>
                  <span className={cn("tabular-nums font-medium", EMERALD)}>
                    {formatCurrency(state.data.depositSum)}
                  </span>
                </div>
                <div className="flex items-center justify-between px-2.5 py-1.5 text-xs">
                  <span className="text-muted-foreground">
                    Wager / payout legs (Σ wager {formatCurrency(state.data.wagerSum)})
                  </span>
                  <span className={cn("tabular-nums font-medium", ROSE)}>
                    {formatCurrency(state.data.payoutSum)}
                  </span>
                </div>
                <div className="flex items-center justify-between px-2.5 py-1.5 text-xs">
                  <span className="text-muted-foreground">Reward payouts</span>
                  <span className={cn("tabular-nums font-medium", ROSE)}>
                    {formatCurrency(state.data.rewardSum)}
                  </span>
                </div>
                <div className="flex items-center justify-between px-2.5 py-1.5 text-xs">
                  <span className="text-muted-foreground">
                    Won pack/battle items
                  </span>
                  <span className={cn("tabular-nums font-medium", ROSE)}>
                    {state.data.inventoryCount.toLocaleString()} ·{" "}
                    {formatCurrency(state.data.inventoryValue)}
                  </span>
                </div>
                <div className="flex items-center justify-between px-2.5 py-1.5 text-xs">
                  <span className="text-muted-foreground">Vouchers created</span>
                  <span className={cn("tabular-nums font-medium", ROSE)}>
                    {state.data.voucherCount.toLocaleString()} ·{" "}
                    {formatCurrency(state.data.voucherValue)}
                  </span>
                </div>
                <div className="flex items-center justify-between px-2.5 py-1.5 text-xs">
                  <span className="text-muted-foreground">
                    Upgrader games
                  </span>
                  <span className="text-foreground/80 tabular-nums">
                    {state.data.upgraderTablePresent
                      ? state.data.upgraderGameCount.toLocaleString()
                      : "table not on this DB"}
                  </span>
                </div>
              </div>
              <div className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-1.5 text-xs">
                <span className="text-muted-foreground">
                  Will be clawed back from balance
                </span>
                <span className={cn("font-semibold tabular-nums", ROSE)}>
                  {formatCurrency(state.data.balanceClawback)}
                </span>
              </div>
              {state.data.withdrawalLockedSkipped > 0 && (
                <p className="flex items-start gap-1.5 rounded border border-amber-500/30 bg-amber-500/[0.06] px-2.5 py-1.5 text-xs text-amber-600 dark:text-amber-400">
                  <Info className="mt-0.5 size-3.5 shrink-0" />
                  <span>
                    {state.data.withdrawalLockedSkipped} won card
                    {state.data.withdrawalLockedSkipped === 1 ? "" : "s"} will be
                    SKIPPED — they back an in-flight withdrawal.
                  </span>
                </p>
              )}
              <DangerWarning kind="pnl" />
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Unified 12 / 24 / 48 hour selector used by the Game + PnL windowed wipes.
 * No "All" sentinel — these wipes are always bounded.
 */
function WipeWindowSelector({
  value,
  onChange,
}: {
  value: WipeWindowHours;
  onChange: (hours: WipeWindowHours) => void;
}) {
  const options = Array.isArray(WIPE_WINDOW_OPTIONS) ? WIPE_WINDOW_OPTIONS : [];
  return (
    <div className="space-y-1">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Time window
      </p>
      <div className="inline-flex rounded-md border bg-background/50 p-0.5">
        {options.map((h) => {
          const active = value === h;
          return (
            <button
              key={h}
              type="button"
              onClick={() => onChange(h as WipeWindowHours)}
              aria-pressed={active}
              className={cn(
                "rounded px-2.5 py-1 text-xs font-medium tabular-nums transition-colors",
                active
                  ? "bg-rose-500/15 text-rose-600 dark:text-rose-400"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
            >
              {h}h
            </button>
          );
        })}
      </div>
    </div>
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
  signedTotal,
  creditClawback,
  debitCount,
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
  /** Signed sum of the selected rows (credits + debits) — informational. */
  signedTotal: number;
  /** Amount actually removed from the balance (Σ credit amounts only). */
  creditClawback: number;
  /** How many selected rows are debits (records deleted, balance untouched). */
  debitCount: number;
}) {
  return (
    <InlineWrapper state={state}>
      {state?.status === "ready" && (
        <div className="space-y-2">
          {state.data.length === 0 ? (
            <div className="py-2 text-xs text-muted-foreground">
              This user has no admin balance adjustments to delete.
            </div>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                Pick the admin adjustments to delete — credits AND debits.
                Deleting a credit claws its amount back out of the balance;
                deleting a debit removes the record but leaves the balance
                unchanged (it never adds money back). Manual withdrawals,
                deposits and gaming rows are never listed.
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
                            {r.amount < 0 ? " · debit (balance kept)" : ""}
                          </div>
                        </div>
                        {/* House-POV: a CREDIT (user got money) renders rose;
                            a DEBIT (user lost money) renders emerald. The sign
                            shows the original direction of the adjustment. */}
                        <div
                          className={cn(
                            "shrink-0 font-semibold tabular-nums",
                            r.amount < 0 ? EMERALD : ROSE,
                          )}
                        >
                          {r.amount < 0 ? "−" : "+"}
                          {formatCurrency(Math.abs(r.amount))}
                        </div>
                      </label>
                    );
                  })
                )}
              </div>
              {/* Running total — "removed from balance" is the CREDIT clawback
                  only (debits delete but keep the balance). */}
              <div className="space-y-0.5 rounded-md border bg-muted/30 px-3 py-1.5 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">
                    <span className="font-semibold tabular-nums text-foreground">
                      {selectedCount}
                    </span>{" "}
                    selected
                    {debitCount > 0 ? (
                      <span className="text-muted-foreground">
                        {" "}
                        ({debitCount} debit{debitCount === 1 ? "" : "s"})
                      </span>
                    ) : (
                      ""
                    )}
                  </span>
                  <span className="text-muted-foreground">
                    Removed from balance:{" "}
                    <span className={cn("font-semibold tabular-nums", ROSE)}>
                      {formatCurrency(creditClawback)}
                    </span>
                  </span>
                </div>
                {debitCount > 0 && (
                  <p className="text-[11px] text-muted-foreground/80">
                    Net adjustment value {formatCurrency(signedTotal)} · deleting
                    the {debitCount} debit{debitCount === 1 ? "" : "s"} removes
                    the record{debitCount === 1 ? "" : "s"} but does not add money
                    back.
                  </p>
                )}
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
  adjDebitCount,
  wagerData,
  gameData,
  pnlData,
  moneyTotal,
  invCount,
  invValue,
  totpCode,
  setTotpCode,
  allEnabledCategories,
  wagerWindow,
  gameWindow,
  pnlWindow,
  onWipeAll,
  isPending,
}: {
  runnableCategories: readonly SelectableCategory[];
  everCreator: boolean;
  anyLiveFinancialSelected: boolean;
  balanceAmt: number;
  vaultAmt: number;
  /** Adjustments' cash contribution = the CREDIT clawback (what leaves the balance). */
  adjAmt: number;
  depositsAmt: number;
  depositsCount: number;
  adjSelectedRows: WipeableAdjustment[];
  /** How many selected adjustments are debits (records deleted, balance untouched). */
  adjDebitCount: number;
  /** The wager preview when the category is ticked + ready, else null. */
  wagerData: WagerPreview | null;
  /** Game wipe preview when ticked + ready. */
  gameData: GamePreview | null;
  /** PnL wipe preview when ticked + ready. */
  pnlData: PnlPreview | null;
  moneyTotal: number;
  invCount: number;
  invValue: number;
  totpCode: string;
  setTotpCode: (v: string) => void;
  /** Every enabled, non-locked category — what WIPE ALL will hit. */
  allEnabledCategories: readonly SelectableCategory[];
  /** The wager window WIPE ALL / the wager step will use (12/24/48/null="All"). */
  wagerWindow: WagerWipeWindowHours;
  /** The Game wipe window (12 / 24 / 48). */
  gameWindow: WipeWindowHours;
  /** The PnL wipe window (12 / 24 / 48). */
  pnlWindow: WipeWindowHours;
  /** Fire the nuke-everything WIPE ALL run (every enabled category). */
  onWipeAll: () => void;
  isPending: boolean;
}) {
  const wantsAdjustments = runnableCategories.includes("adjustments");
  const wantsBalance = runnableCategories.includes("balance");
  const wantsVault = runnableCategories.includes("vault");
  const wantsInventory = runnableCategories.includes("inventory");
  const wantsDeposits = runnableCategories.includes("deposits");
  const wantsWager = runnableCategories.includes("wager") && wagerData !== null;
  const wantsGame = runnableCategories.includes("game") && gameData !== null;
  const wantsPnl = runnableCategories.includes("pnl") && pnlData !== null;

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
                      r.amount < 0 ? EMERALD : ROSE,
                    )}
                  >
                    {r.amount < 0 ? "−" : "+"}
                    {formatCurrency(Math.abs(r.amount))}
                  </span>
                </div>
              ))}
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {formatCurrency(adjAmt)} clawed back from balance
              {adjDebitCount > 0
                ? ` · ${adjDebitCount} debit${adjDebitCount === 1 ? "" : "s"} deleted with no balance change (never adds money back)`
                : ""}
              .
            </p>
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

        {wantsPnl && pnlData && (
          <SummaryBlock
            icon={Receipt}
            label={`PnL wipe · last ${pnlData.windowHours}h (${pnlData.ledgerLegCount.toLocaleString()} leg${pnlData.ledgerLegCount === 1 ? "" : "s"})`}
            amount={pnlData.balanceClawback}
            danger="LARGEST scope — deletes every PnL-affecting event in window (deposits, gameplay legs + won inventory, rewards, vouchers, admin adjustments). Counters: wagered/won/deposited decremented. Recoverable via snapshot."
          >
            <p className="text-xs text-muted-foreground">
              Last {pnlData.windowHours}h ·{" "}
              {pnlData.ledgerLegCount.toLocaleString()} ledger leg
              {pnlData.ledgerLegCount === 1 ? "" : "s"} (deposits{" "}
              {formatCurrency(pnlData.depositSum)} · gameplay payouts{" "}
              {formatCurrency(pnlData.payoutSum)} · rewards{" "}
              {formatCurrency(pnlData.rewardSum)}) ·{" "}
              {pnlData.inventoryCount.toLocaleString()} won item
              {pnlData.inventoryCount === 1 ? "" : "s"} (
              {formatCurrency(pnlData.inventoryValue)}) ·{" "}
              {pnlData.voucherCount.toLocaleString()} voucher
              {pnlData.voucherCount === 1 ? "" : "s"} (
              {formatCurrency(pnlData.voucherValue)})
              {pnlData.upgraderTablePresent
                ? ` · ${pnlData.upgraderGameCount.toLocaleString()} upgrader game${pnlData.upgraderGameCount === 1 ? "" : "s"}`
                : ""}
              {" · "}
              {formatCurrency(pnlData.balanceClawback)} clawed back from balance
              {pnlData.withdrawalLockedSkipped > 0
                ? ` · ${pnlData.withdrawalLockedSkipped} withdrawal-locked card${pnlData.withdrawalLockedSkipped === 1 ? "" : "s"} skipped`
                : ""}
              .
            </p>
          </SummaryBlock>
        )}

        {wantsGame && gameData && (
          <SummaryBlock
            icon={Gamepad2}
            label={`Game wipe · last ${gameData.windowHours}h (${gameData.ledgerLegCount.toLocaleString()} leg${gameData.ledgerLegCount === 1 ? "" : "s"})`}
            amount={gameData.payoutTotal}
            danger="Pure gameplay events in window — decrements total_won only (not total_wagered). Recoverable via snapshot."
          >
            <p className="text-xs text-muted-foreground">
              Last {gameData.windowHours}h ·{" "}
              {gameData.ledgerLegCount.toLocaleString()} wager + payout leg
              {gameData.ledgerLegCount === 1 ? "" : "s"} ·{" "}
              {gameData.inventoryCount.toLocaleString()} won item
              {gameData.inventoryCount === 1 ? "" : "s"} (
              {formatCurrency(gameData.inventoryValue)})
              {gameData.upgraderTablePresent
                ? ` · ${gameData.upgraderGameCount.toLocaleString()} upgrader game${gameData.upgraderGameCount === 1 ? "" : "s"}`
                : ""}
              {" · "}
              {formatCurrency(gameData.payoutTotal)} clawed back from balance
              {gameData.withdrawalLockedSkipped > 0
                ? ` · ${gameData.withdrawalLockedSkipped} withdrawal-locked card${gameData.withdrawalLockedSkipped === 1 ? "" : "s"} skipped`
                : ""}
              .
            </p>
          </SummaryBlock>
        )}

        {wantsWager && wagerData && (
          <SummaryBlock
            icon={Gamepad2}
            label={`Wager / gameplay${wagerData.windowHours === null ? "" : ` · last ${wagerData.windowHours}h`} (${wagerData.ledgerLegCount.toLocaleString()} leg${wagerData.ledgerLegCount === 1 ? "" : "s"})`}
            amount={wagerData.payoutTotal}
            danger="Deletes real gaming history (GGR / margin / P&L) — recoverable (best-effort) via snapshot"
          >
            <p className="text-xs text-muted-foreground">
              {wagerData.windowHours === null
                ? "All gameplay · "
                : `Last ${wagerData.windowHours}h · `}
              {wagerData.ledgerLegCount.toLocaleString()} wager + payout leg
              {wagerData.ledgerLegCount === 1 ? "" : "s"} ·{" "}
              {wagerData.inventoryCount.toLocaleString()} won item
              {wagerData.inventoryCount === 1 ? "" : "s"} (
              {formatCurrency(wagerData.inventoryValue)})
              {wagerData.upgraderTablePresent
                ? ` · ${wagerData.upgraderGameCount.toLocaleString()} upgrader game${wagerData.upgraderGameCount === 1 ? "" : "s"}`
                : ""}
              {" · "}
              {formatCurrency(wagerData.payoutTotal)} clawed back from balance
              {wagerData.withdrawalLockedSkipped > 0
                ? ` · ${wagerData.withdrawalLockedSkipped} withdrawal-locked card${wagerData.withdrawalLockedSkipped === 1 ? "" : "s"} skipped`
                : ""}
              .
            </p>
            {wagerData.windowHours !== null && (
              <p className="mt-1 flex items-start gap-1.5 text-[11px] text-amber-600 dark:text-amber-400">
                <Info className="mt-px size-3 shrink-0" />
                Only the last {wagerData.windowHours}h is removed — older
                gameplay (and its lifetime-stat / GGR effect) remains until wiped
                too.
              </p>
            )}
          </SummaryBlock>
        )}

        {/* Grand total. Money pools (balance + vault + adjustments + deposits +
            wager payout clawback) sum to one cash figure; inventory + won-card
            value are card-value estimates shown alongside (different unit, not
            folded into the cash headline). */}
        <div className="border-t border-rose-500/20 pt-2.5">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-foreground">
              Grand total
            </span>
            <span className={cn("text-base font-bold tabular-nums", ROSE)}>
              {formatCurrency(moneyTotal + invValue + (wagerData?.inventoryValue ?? 0))}
            </span>
          </div>
          {(wantsInventory || wantsWager) && moneyTotal > 0 && (
            <p className="mt-1 text-right text-[11px] text-muted-foreground">
              {formatCurrency(moneyTotal)} balance / finance +{" "}
              {formatCurrency(invValue + (wagerData?.inventoryValue ?? 0))}{" "}
              inventory / won-card value
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

      {/* ───────────────────────────────────────────────────────────────────
          WIPE ALL — bottom-left nuke-everything control. Selects every
          currently-ENABLED category and runs them through the SAME single 2FA
          gate (the code above). Purely the real deletions — no stat-exclusion.
          Disabled ("coming soon") + creator-protected categories are NOT
          touched. Deliberately loud + unmistakably destructive. */}
      <WipeAllPanel
        everCreator={everCreator}
        allEnabledCategories={allEnabledCategories}
        wagerWindow={wagerWindow}
        gameWindow={gameWindow}
        pnlWindow={pnlWindow}
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
// every enabled category through the existing single 2FA gate. It NEVER
// enables a disabled category and NEVER bypasses creator-protection (the
// locked categories are excluded from `allEnabledCategories`), and it does NOT
// exclude the user from stats (the owner rejected exclusion entirely).
// ───────────────────────────────────────────────────────────────────────────
function WipeAllPanel({
  everCreator,
  allEnabledCategories,
  wagerWindow,
  gameWindow,
  pnlWindow,
  totpReady,
  isPending,
  onWipeAll,
}: {
  everCreator: boolean;
  allEnabledCategories: readonly SelectableCategory[];
  /** The wager window the wager step inside WIPE ALL will use. */
  wagerWindow: WagerWipeWindowHours;
  gameWindow: WipeWindowHours;
  pnlWindow: WipeWindowHours;
  totpReady: boolean;
  isPending: boolean;
  onWipeAll: () => void;
}) {
  // Human labels for the categories WIPE ALL will hit (in run order).
  const hitLabels = allEnabledCategories.map((c) => wipeCategoryMeta(c).label);
  // WIPE ALL runs the wager step with the SAME window selected above. Surface
  // it so a bounded window (e.g. 24h) doesn't silently leave older gameplay
  // behind without the owner realizing.
  const wagerInAll = allEnabledCategories.includes("wager");
  const gameInAll = allEnabledCategories.includes("game");
  const pnlInAll = allEnabledCategories.includes("pnl");

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
              for this user in one go. Each part is snapshotted + individually
              restorable, but{" "}
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
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground/80">
                Empty categories are skipped. Disabled “coming soon” categories
                are not touched.
              </p>
              {wagerInAll && (
                <p className="mt-1 flex items-start gap-1.5 text-[11px] text-amber-600 dark:text-amber-400">
                  <Info className="mt-px size-3 shrink-0" />
                  {wagerWindow === null
                    ? "Wager / gameplay runs for ALL gameplay (may be slow on a very heavy account — adjust the time window above)."
                    : `Wager / gameplay runs for the last ${wagerWindow}h only — older gameplay stays until wiped (change the time window above).`}
                </p>
              )}
              {gameInAll && (
                <p className="mt-1 flex items-start gap-1.5 text-[11px] text-amber-600 dark:text-amber-400">
                  <Info className="mt-px size-3 shrink-0" />
                  Game wipe runs for the last {gameWindow}h.
                </p>
              )}
              {pnlInAll && (
                <p className="mt-1 flex items-start gap-1.5 text-[11px] text-amber-600 dark:text-amber-400">
                  <Info className="mt-px size-3 shrink-0" />
                  PnL wipe runs for the last {pnlWindow}h (largest scope).
                </p>
              )}
            </div>
          ) : (
            <div className="rounded border border-rose-600/30 bg-background/40 px-2.5 py-2 text-xs text-muted-foreground">
              No wipeable category is available for this user
              {everCreator ? " (creator-protected)" : ""} — there is nothing for
              WIPE ALL to do.
            </div>
          )}

          {/* Role-aware WILL NOT TOUCH note. */}
          <p className="flex items-start gap-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">
            <ShieldCheck className="mt-px size-3 shrink-0" />
            <span>
              Will NOT touch: {wipePreservedSummary(everCreator)}
            </span>
          </p>

          {/* Solid-red danger button. The `destructive` variant supplies the
              focus-ring + disabled states, but its faint bg + red `text-
              destructive` are overridden here: a SOLID rose bg with EXPLICIT
              white text (never red-on-red). `cn`/tailwind-merge keeps these
              last-wins classes over the variant's bg/text. Legible in light
              AND dark (rose-600 stays dark enough for white text in both). */}
          <Button
            size="sm"
            variant="destructive"
            className="w-full bg-rose-600 text-white hover:bg-rose-700 hover:text-white focus-visible:ring-rose-600/40 dark:bg-rose-600 dark:text-white dark:hover:bg-rose-700 sm:w-auto"
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
            {isPending ? "Wiping…" : "WIPE ALL"}
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
// RUNNING PHASE — per-step execution status so a partial run is legible. Every
// step is a wipe category (the flow is purely destructive — no stat-exclusion
// step).
// ───────────────────────────────────────────────────────────────────────────
function RunningPhase({
  results,
  isWipeAll,
}: {
  results: RunResult[];
  isWipeAll: boolean;
}) {
  // Whether the wager / gameplay category is part of this run AND still in
  // flight (pending or running). The gameplay wipe is the one category that
  // can legitimately take a long time on a heavy account (its DB transaction
  // raises its own statement_timeout to 180s), so we surface a "don't close
  // this" note while it's working — the spinner / dialog must stay open until
  // the server returns the real result.
  const wagerInFlight = results.some(
    (r) =>
      r.category === "wager" &&
      (r.status === "running" || r.status === "pending"),
  );
  return (
    <div className="space-y-2">
      {isWipeAll && (
        <div className="rounded-md border border-rose-600/40 bg-rose-600/[0.07] px-3 py-2 text-xs font-medium text-rose-600 dark:text-rose-400">
          <span className="flex items-center gap-1.5">
            <Skull className="size-3.5" />
            WIPE ALL in progress — running every enabled category.
          </span>
        </div>
      )}
      {wagerInFlight && (
        <div className="flex items-start gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
          <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin" />
          <span>
            Wiping gameplay can take up to a minute or two for a very heavy
            account — please keep this dialog open and don&apos;t close the tab.
            Nothing is left half-done: the delete either fully completes or
            nothing is removed.
          </span>
        </div>
      )}
      <div className="divide-y rounded-md border">
        {results.map((r) => {
          const label = wipeCategoryMeta(r.category).label;
          const Icon = categoryIcon(r.category);
          return (
            <div
              key={r.category}
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

/** Per-category live-financial danger warning shown inline in the preview. */
function DangerWarning({ kind }: { kind: "deposits" | "wager" | "game" | "pnl" }) {
  let copy: string;
  if (kind === "deposits") {
    copy =
      "Deletes real deposit history and reduces the lifetime deposited counter. Recoverable via snapshot, but this is real financial data — not house-granted content value.";
  } else if (kind === "wager") {
    copy =
      "Deletes the user's wager + payout ledger legs, won pack/battle inventory and upgrader games — real gaming history that drives GGR / the gaming margin / P&L. Recoverable (best-effort) via snapshot. The balance is reduced only by the payout legs (never inflated); game_sessions/battles shells are left intact.";
  } else if (kind === "game") {
    copy =
      "Deletes pure gameplay events in the selected window — pack openings, battles, upgrader, won pack/battle inventory + provably-fair children. Decrements total_won (not total_wagered — Wager wipe's territory). Recoverable via snapshot.";
  } else {
    copy =
      "LARGEST scope. Deletes every PnL-affecting event in the selected window — deposits, gameplay legs + won inventory, rewards, vouchers, admin balance adjustments. Decrements total_wagered / total_won / total_deposited by the deleted sums. Withdrawals are NOT touched. Recoverable via snapshot.";
  }
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
