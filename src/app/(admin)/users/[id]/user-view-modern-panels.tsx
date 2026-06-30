"use client";

/**
 * Shared primitives + "modern" stat panels used by the modern user detail
 * view. Split out of user-view-modern.tsx to keep files focused and under
 * ~500 lines. Pure presentation — no data fetching, no side effects.
 */

import * as React from "react";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Wallet,
  TrendingUp,
  TrendingDown,
  Activity,
  Lock,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import {
  BalanceAdjustDialog,
  ManualWithdrawalDialog,
  XpAdjustDialog,
} from "./user-tabs-dialogs";
import { extendVaultLock, refreshUserDetailCache } from "./actions";
import type {
  UserDetail,
  PnlBreakdown,
} from "./user-tabs-types";

// ───────────────────────────────────────────────────────────────────
//  SHARED COLOR TOKENS
// ───────────────────────────────────────────────────────────────────

export const TILE_COLORS: Record<
  string,
  { bg: string; text: string; icon: string }
> = {
  blue: {
    bg: "bg-blue-500/10 border-blue-500/20",
    text: "text-blue-600 dark:text-blue-400",
    icon: "text-blue-500",
  },
  emerald: {
    bg: "bg-emerald-500/10 border-emerald-500/20",
    text: "text-emerald-600 dark:text-emerald-400",
    icon: "text-emerald-500",
  },
  rose: {
    bg: "bg-rose-500/10 border-rose-500/20",
    text: "text-rose-600 dark:text-rose-400",
    icon: "text-rose-500",
  },
  cyan: {
    bg: "bg-cyan-500/10 border-cyan-500/20",
    text: "text-cyan-600 dark:text-cyan-400",
    icon: "text-cyan-500",
  },
  amber: {
    bg: "bg-amber-500/10 border-amber-500/20",
    text: "text-amber-600 dark:text-amber-400",
    icon: "text-amber-500",
  },
  purple: {
    bg: "bg-purple-500/10 border-purple-500/20",
    text: "text-purple-600 dark:text-purple-400",
    icon: "text-purple-500",
  },
};

// ───────────────────────────────────────────────────────────────────
//  SECTION HEADING
// ───────────────────────────────────────────────────────────────────

export function SectionHeading({
  icon: Icon,
  title,
}: {
  icon: React.ElementType;
  title: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <div className="rounded-md bg-primary/10 p-1.5">
        <Icon className="size-4 text-primary" />
      </div>
      <h3 className="text-base font-semibold">{title}</h3>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────
//  MODERN STAT PANELS — used in the Overview tab
// ───────────────────────────────────────────────────────────────────

export function StatPanel({
  title,
  icon: Icon,
  accent,
  action,
  children,
}: {
  title: string;
  icon: React.ElementType;
  accent: keyof typeof TILE_COLORS;
  // Optional right-aligned slot in the header, e.g. for the Balances
  // panel's refresh icon button.
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const colors = TILE_COLORS[accent] ?? TILE_COLORS.blue;
  return (
    <div className="relative h-full overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-card/80">
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute -right-12 -top-12 size-32 rounded-full blur-2xl opacity-40",
          colors.bg,
        )}
      />
      <div className="relative flex h-full flex-col p-4 sm:p-5">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <div className={cn("flex size-7 items-center justify-center rounded-lg shrink-0", colors.bg)}>
              <Icon className={cn("size-3.5", colors.icon)} />
            </div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground truncate">
              {title}
            </h3>
          </div>
          {action}
        </div>
        {children}
      </div>
    </div>
  );
}

export function PanelRow({
  label,
  value,
  valueClassName,
  // Optional small subtitle line rendered beneath the label, e.g. for the
  // Vault row's unlock-at timestamp or the Locked row's wager-progress hint.
  // Kept optional + string-typed so the dozens of existing PanelRow call
  // sites stay unchanged.
  sub,
}: {
  label: string;
  value: React.ReactNode;
  valueClassName?: string;
  sub?: string | null;
}) {
  if (sub) {
    return (
      <div className="flex items-start justify-between gap-3 py-1 text-sm">
        <div className="min-w-0">
          <div className="text-muted-foreground">{label}</div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70 truncate">
            {sub}
          </div>
        </div>
        <span
          className={cn(
            "font-medium tabular-nums shrink-0",
            valueClassName,
          )}
        >
          {value}
        </span>
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between py-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("font-medium tabular-nums", valueClassName)}>{value}</span>
    </div>
  );
}

// Compact rolling-P&L chip for the Platform-P&L panel footer (24h / 7d).
// House POV — must match the panel's main P&L number coloring exactly:
//   value > 0  → house gained  → emerald
//   value < 0  → house lost     → rose
//   value === 0 → flat          → muted
// No sign flip. Currency via the shared formatCurrency; tabular-nums so the
// two chips align. Dark-mode variants included.
function RollingPnlChip({ label, value }: { label: string; value: number }) {
  const tone =
    value > 0
      ? "text-emerald-600 dark:text-emerald-400"
      : value < 0
        ? "text-rose-600 dark:text-rose-400"
        : "text-muted-foreground";
  return (
    <div className="flex min-w-0 flex-1 items-baseline justify-between gap-1.5 rounded-lg border bg-muted/30 px-2.5 py-1.5">
      <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className={cn("truncate text-sm font-semibold tabular-nums", tone)}>
        {value > 0 ? "+" : ""}
        {formatCurrency(value)}
      </span>
    </div>
  );
}

/**
 * Vault / Locked balance row with a small inline "Remove" affordance.
 *
 * Both pockets show the same affordance but for different reasons (and
 * both ship DISABLED today):
 *
 *   • Vault (`removeKind="vault"`) — the platform writes vault locks via
 *     `moveBalanceToVault` (admin action → `vault_lock` ledger row, MAIN-DB
 *     write). There is NO reverse action — no `moveBalanceFromVault`,
 *     no `vault_unlock` writer. Per CLAUDE.md the MAIN GAME DB is
 *     read-only and we don't ship a new MAIN write path without explicit
 *     owner sign-off, so the button is rendered + disabled with a
 *     tooltip explaining the gap.
 *
 *   • Locked (`removeKind="wager"`) — the bonus/wager-requirement debt is
 *     cleared by `clearUserWagerRequirementAction`, which routes through
 *     the backend HTTP API (not Prisma). That action exists but it's a
 *     panel-wide action surfaced on the dedicated Wager Requirement card
 *     (`user-wager-requirement-card.tsx`); reusing it from this row
 *     would dilute the dialog UX that card carries (confirm copy +
 *     audit row + toast). For now the row's inline Remove button stays
 *     disabled and the tooltip points operators at the dedicated card —
 *     same "show the affordance" reasoning as the vault case.
 *
 * When either action ships in a panel-friendly form (a confirm dialog +
 * 2FA + audit row pattern matching `moveBalanceToVault`), wire it up here
 * by replacing the disabled button with a click handler that opens the
 * dialog. Don't add an `onClick` that fires a write straight from the
 * row — confirm-dialog + audit-event is the panel standard.
 */
function LockedRowWithRemove({
  label,
  amount,
  valueClassName,
  sub,
  removeKind,
  onRemoveClick,
}: {
  label: string;
  amount: number;
  valueClassName?: string;
  sub?: string | null;
  removeKind: "vault" | "wager";
  // Optional handler — when provided the Remove button is enabled and
  // clicking it fires this callback (typically opens a confirm dialog).
  // Wired for `removeKind="vault"` via the freeze-vault flow; the wager
  // case still falls back to the disabled-button + tooltip explanation.
  onRemoveClick?: () => void;
}) {
  // Vault: wired to the freeze-for-10-years flow when an onRemoveClick
  // handler is supplied; otherwise (defensive fallback) shows the same
  // disabled affordance as before. Wager: still no inline flow — pointer
  // to the dedicated Wager Requirement card.
  const enabled = removeKind === "vault" && typeof onRemoveClick === "function";
  const removeTitle = enabled
    ? "Freeze the user's vault balance for 10 years (effectively prevents unlock; money stays in the vault)"
    : removeKind === "vault"
      ? "Vault freeze action not available in this context"
      : "Clear wager debt via the dedicated Wager Requirement card (audit + 2FA flow); inline Remove not wired yet";

  // Mirrors the optional-sub variant of PanelRow so the Vault / Locked
  // rows stay visually aligned with every other row in the breakdown.
  const valueNode = (
    <div className="flex items-center gap-1.5 shrink-0">
      <span className={cn("font-medium tabular-nums", valueClassName)}>
        {formatCurrency(amount)}
      </span>
      {amount > 0 ? (
        <Button
          variant="ghost"
          size="sm"
          disabled={!enabled}
          onClick={enabled ? onRemoveClick : undefined}
          className={cn(
            "h-5 px-1.5 text-[10px] font-semibold uppercase tracking-wider",
            enabled
              ? "text-rose-600 hover:text-rose-600 hover:bg-rose-500/10 dark:text-rose-400 dark:hover:text-rose-400"
              : "text-amber-600 dark:text-amber-400",
          )}
          title={removeTitle}
          aria-label={
            enabled
              ? `Freeze ${label.toLowerCase()} balance for 10 years`
              : `Force unlock ${label.toLowerCase()} balance (not yet implemented)`
          }
        >
          <Lock className="size-3 shrink-0" />
          Remove
        </Button>
      ) : null}
    </div>
  );

  if (sub) {
    return (
      <div className="flex items-start justify-between gap-3 py-1 text-sm">
        <div className="min-w-0">
          <div className="text-muted-foreground">{label}</div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70 truncate">
            {sub}
          </div>
        </div>
        {valueNode}
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between py-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      {valueNode}
    </div>
  );
}

export function ModernBalancePanel({
  balances,
  userId,
  pnl7d,
  canAdjustBalance = false,
  canRecordManualWithdrawal = false,
}: {
  balances: UserDetail["balances"];
  userId?: string;
  // The user's rolling 7-day house P&L — the SAME value shown in the
  // "Past 7d" rung of the P&L panel (`pnlBreakdown.pnl7d`). Threaded into
  // the Adjust-Balance dialog so the Lossback section auto-fills it (no
  // drift vs the Accounts tab). Serializable number — safe across the
  // server→client boundary.
  pnl7d?: number;
  canAdjustBalance?: boolean;
  canRecordManualWithdrawal?: boolean;
}) {
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [vaultFreezeOpen, setVaultFreezeOpen] = useState(false);
  // Soft-refresh the page server data when the admin clicks the icon —
  // re-runs the parent server components without a hard browser
  // reload, so the user keeps their tab focus / scroll position and
  // the rest of the page DOM stays intact while the balance numbers
  // re-fetch. useTransition wraps the call so the icon can show a
  // pending spinner without blocking the rest of the UI.
  //
  // CACHE-BUST FIRST: the balance reads are unstable_cache'd (25s, tagged
  // both "users-detail" AND `users-detail-${userId}`), and the route segment
  // itself is also cached. A bare router.refresh() would replay both. We
  // invalidate the per-user tag AND the route segment server-side first, so
  // router.refresh() re-queries Postgres LIVE — the click is always fresh.
  // Per-user (not global) so a refresh on user A doesn't nuke unrelated
  // users' warmed entries.
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const handleRefresh = () => {
    startRefresh(async () => {
      await refreshUserDetailCache(userId);
      router.refresh();
    });
  };
  const refreshAction = (
    <Button
      variant="ghost"
      size="icon"
      onClick={handleRefresh}
      disabled={refreshing}
      className="size-7"
      title="Reload balances"
      aria-label="Reload balances"
    >
      <RefreshCw
        className={cn("size-3.5", refreshing && "animate-spin")}
      />
    </Button>
  );

  if (!balances) {
    return (
      <StatPanel
        title="Balances"
        icon={Wallet}
        accent="emerald"
        action={refreshAction}
      >
        <p className="text-sm text-muted-foreground">No balance data</p>
      </StatPanel>
    );
  }
  // Total = spendable cash + vault cooldown + held items + voucher liability.
  // The wager-locked debt (`wagerLocked`) is NOT added here — it's a portion
  // of `availableBalance` reserved from withdrawal, not separate money, so
  // including it would double-count. Vault IS separate from cash (different
  // column), so it goes into the sum.
  const total =
    balances.availableBalance +
    balances.lockedBalance +
    balances.inventoryValue +
    balances.vouchersValue;
  // Vault row — render unlock-at subtitle when the cooldown window has a
  // timestamp. Past timestamp = the user can withdraw it now; future = how
  // long until they can.
  const vaultSub = (() => {
    if (!balances.unlockAt) return null;
    const t = Date.parse(balances.unlockAt);
    if (!Number.isFinite(t)) return null;
    const d = new Date(t);
    const stamp = d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "UTC",
    });
    return t <= Date.now()
      ? "Eligible to unlock now"
      : `Unlocks ${stamp} UTC`;
  })();
  // Locked row — render only when the column exists on the connected DB
  // (`wagerLocked != null`). With the column present we render even at $0
  // so an operator can see the user has nothing wagered-locked right now;
  // hiding-on-zero would create the wrong impression that the panel just
  // forgot the line.
  const showLocked = balances.wagerLocked != null;
  const lockedSub = (() => {
    if (!showLocked) return null;
    const progress = balances.wagerProgress ?? 0;
    const debt = balances.wagerLocked ?? 0;
    if (debt <= 0) return `${formatCurrency(progress)} wagered · no debt`;
    return `${formatCurrency(progress)} wagered · ${formatCurrency(debt)} to clear`;
  })();
  const showAdjust = canAdjustBalance && Boolean(userId);
  // Show the manual-withdrawal button whenever the admin has the
  // capability — it's also useful at $0 balance for backfilling
  // historical off-platform payouts so P&L counts them.
  const showManual = canRecordManualWithdrawal && Boolean(userId);
  return (
    <StatPanel
      title="Balances"
      icon={Wallet}
      accent="emerald"
      action={refreshAction}
    >
      <div className="space-y-0.5">
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
          Total Value
        </p>
        <p className="text-2xl sm:text-3xl font-bold tabular-nums text-emerald-600 dark:text-emerald-400 truncate">
          {formatCurrency(total)}
        </p>
      </div>
      <div className="mt-4 space-y-0.5 border-t pt-3">
        <PanelRow label="Cash" value={formatCurrency(balances.availableBalance)} />
        {/* Vault — cooldown-locked balance (user's own money, just not
            spendable yet). BLUE/muted neutral: it IS the user's money.
            Trailing "Remove" affordance is shipped DISABLED — see
            LockedRowWithRemove for why (no backend unlock action exists). */}
        <LockedRowWithRemove
          label="Vault"
          amount={balances.lockedBalance}
          valueClassName="text-blue-600 dark:text-blue-400"
          sub={vaultSub}
          removeKind="vault"
          onRemoveClick={
            userId && balances.lockedBalance > 0
              ? () => setVaultFreezeOpen(true)
              : undefined
          }
        />
        {/* Locked — wager-requirement debt (bonus dollars spendable on
            wagers but reserved from withdrawal until cleared). AMBER
            warning: spendable but not withdrawable. Hidden if the column
            isn't on this DB. Same DISABLED Remove affordance — clearing
            wager-req debt goes through a backend-API path
            (clearUserWagerRequirementAction) the panel doesn't own. */}
        {showLocked && (
          <LockedRowWithRemove
            label="Locked"
            amount={balances.wagerLocked ?? 0}
            valueClassName="text-amber-600 dark:text-amber-400"
            sub={lockedSub}
            removeKind="wager"
          />
        )}
        <PanelRow label="Inventory" value={formatCurrency(balances.inventoryValue)} />
        <PanelRow label="Vouchers" value={formatCurrency(balances.vouchersValue)} />
      </div>
      {(showAdjust || showManual) && (
        <div className="mt-3 pt-3 border-t space-y-2">
          {showAdjust && (
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => setAdjustOpen(true)}
            >
              Adjust Balance
            </Button>
          )}
          {showManual && (
            <Button
              variant="outline"
              size="sm"
              className="w-full text-rose-600 hover:text-rose-600 dark:text-rose-400 dark:hover:text-rose-400 border-rose-500/40 hover:bg-rose-500/10"
              onClick={() => setManualOpen(true)}
              title="Record an off-platform payout (deducts on-site balance + bumps total_withdrawn so PnL stays correct)"
            >
              Record Manual Withdrawal
            </Button>
          )}
        </div>
      )}
      {showAdjust && userId && (
        <BalanceAdjustDialog
          userId={userId}
          availableBalance={balances.availableBalance}
          availableBalanceRaw={balances.availableBalanceRaw}
          lockedBalance={balances.lockedBalance}
          pnl7d={pnl7d}
          open={adjustOpen}
          onOpenChange={setAdjustOpen}
        />
      )}
      {showManual && userId && (
        <ManualWithdrawalDialog
          userId={userId}
          availableBalance={balances.availableBalance}
          open={manualOpen}
          onOpenChange={setManualOpen}
        />
      )}
      {userId && balances.lockedBalance > 0 && (
        <VaultFreezeDialog
          userId={userId}
          lockedBalance={balances.lockedBalance}
          open={vaultFreezeOpen}
          onOpenChange={setVaultFreezeOpen}
        />
      )}
    </StatPanel>
  );
}

// ───────────────────────────────────────────────────────────────────
//  VAULT FREEZE DIALOG
// ───────────────────────────────────────────────────────────────────
//
// Operator-controlled "soft remove" of the vault pocket. Calls
// `extendVaultLock` which pushes `balances.unlock_at` to NOW + 10 years
// without moving any money. The user keeps the dollars in their vault
// but can't withdraw them until 2036.
//
// Gated by capability + TOTP on the server (see `extendVaultLock` in
// actions.ts) — this dialog only collects the operator's inputs and
// surfaces the success/error toast.

function VaultFreezeDialog({
  userId,
  lockedBalance,
  open,
  onOpenChange,
}: {
  userId: string;
  lockedBalance: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [reason, setReason] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  // Display the projected unlock date — computed client-side as a preview
  // only. The server is the source of truth: it computes NOW+10y at the
  // moment of the write and records that ISO timestamp in the audit row.
  const projectedUnlock = React.useMemo(() => {
    const d = new Date();
    d.setUTCFullYear(d.getUTCFullYear() + 10);
    return d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "UTC",
    });
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleSubmit() {
    if (!totpCode.trim()) {
      toast.error("Please enter your 2FA code");
      return;
    }
    startTransition(async () => {
      try {
        const result = await extendVaultLock(
          userId,
          totpCode.trim(),
          reason.trim() || undefined,
        );
        if (!result.success) {
          toast.error(result.error);
          return;
        }
        const stamp = new Date(result.new_unlock_at).toLocaleString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
          timeZone: "UTC",
        });
        toast.success(`Vault locked until ${stamp} UTC`);
        setReason("");
        setTotpCode("");
        onOpenChange(false);
        router.refresh();
      } catch (e) {
        toast.error(
          e instanceof Error ? e.message : "Failed to freeze vault balance",
        );
      }
    });
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          // Reset transient form state on close so the next open starts clean
          setReason("");
          setTotpCode("");
        }
        onOpenChange(o);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Lock className="size-4 text-rose-500" />
            Freeze vault balance
          </AlertDialogTitle>
          <AlertDialogDescription>
            <span className="font-semibold tabular-nums text-foreground">
              {formatCurrency(lockedBalance)}
            </span>{" "}
            currently locked. This sets the unlock date to 10 years from now.
            The money stays in the user&apos;s vault but they cannot withdraw it
            until{" "}
            <span className="font-mono text-foreground">
              {projectedUnlock} UTC
            </span>
            .
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              Reason (optional)
            </Label>
            <Textarea
              placeholder="Why are you freezing this vault?"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
            />
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
            />
          </div>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleSubmit}
            disabled={isPending || !totpCode.trim()}
            className="bg-rose-500 hover:bg-rose-500/90 text-white"
          >
            {isPending ? "Freezing..." : "Freeze for 10 years"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function ModernPnlPanel({
  balances,
  pnlBreakdown,
}: {
  balances: UserDetail["balances"];
  pnlBreakdown: PnlBreakdown;
}) {
  // True house-perspective P&L for this user, matching CLAUDE.md's
  // financial coloring rule:
  //
  //   pnl = deposits − withdrawals − (available + locked balance)
  //                   − inventory value − voucher liability
  //
  // i.e. money we've captured minus money we still owe the user. If the
  // user has more sitting on-site than they've deposited (paper win),
  // the number goes negative and we show red.
  const deposits = balances?.totalDeposited ?? 0;
  const withdrawals = balances?.totalWithdrawn ?? 0;
  const onSiteBalance =
    (balances?.availableBalance ?? 0) + (balances?.lockedBalance ?? 0);
  const inventoryValue = balances?.inventoryValue ?? 0;
  const vouchersValue = balances?.vouchersValue ?? 0;
  const pnl =
    deposits - withdrawals - onSiteBalance - inventoryValue - vouchersValue;
  const isProfit = pnl >= 0;
  const Icon = isProfit ? TrendingUp : TrendingDown;
  return (
    <StatPanel title="Platform P&L" icon={Icon} accent={isProfit ? "emerald" : "rose"}>
      <div className="space-y-0.5">
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground truncate">
          Deposits − Withdrawals − Balance − Inventory
        </p>
        <p
          className={cn(
            "text-2xl sm:text-3xl font-bold tabular-nums truncate",
            isProfit ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400",
          )}
        >
          {isProfit ? "+" : ""}
          {formatCurrency(pnl)}
        </p>
      </div>
      <div className="mt-4 space-y-0.5 border-t pt-3">
        <PanelRow label="Deposited" value={formatCurrency(deposits)} />
        <PanelRow label="Withdrawn" value={formatCurrency(withdrawals)} />
        <PanelRow label="On-site balance" value={`-${formatCurrency(onSiteBalance)}`} />
        <PanelRow label="Inventory value" value={`-${formatCurrency(inventoryValue)}`} />
        {vouchersValue > 0 ? (
          <PanelRow label="Unclaimed vouchers" value={`-${formatCurrency(vouchersValue)}`} />
        ) : null}
        <PanelRow
          label="Bonuses given"
          value={
            <span className="text-rose-500">
              -{formatCurrency(pnlBreakdown.bonusesCost)}
            </span>
          }
        />
      </div>
      {/* Compact rolling-P&L footer — the full 12h/24h/3d/7d/14d ladder was
          removed from this panel (it made the box taller than the sibling
          Balances / Activity panels and unbalanced the 3-up Overview row;
          the full ladder still lives on the Account tab as a tile strip).
          Per owner request the two most-watched windows (24h + 7d) return
          here as two compact inline chips, pinned to the BOTTOM via mt-auto
          so they sit in the vertical slack the equal-height grid already
          gives this (shortest) panel — they do NOT add height beyond the
          stretched row. Same already-computed values as the Account-tab
          strip (pnlBreakdown.pnl24h / pnl7d) — no new query, no new prop.
          House POV matches the hero number above exactly: house gain (>=0)
          → emerald, house loss (<0) → rose, flat (===0) → muted. */}
      <div className="mt-auto flex items-center gap-2 border-t pt-3">
        <RollingPnlChip label="24h" value={pnlBreakdown.pnl24h} />
        <RollingPnlChip label="7d" value={pnlBreakdown.pnl7d} />
      </div>
    </StatPanel>
  );
}

export function ModernActivityPanel({
  statistics,
  balances,
  inventoryCount,
  avgDeposit,
  userId,
  canAdjustXp = false,
}: {
  statistics: UserDetail["statistics"];
  balances: UserDetail["balances"];
  inventoryCount: number;
  avgDeposit: number;
  userId?: string;
  canAdjustXp?: boolean;
}) {
  const [xpAdjustOpen, setXpAdjustOpen] = useState(false);

  const houseEdge =
    balances && balances.totalWagered > 0
      ? ((balances.totalWagered - balances.totalWon) / balances.totalWagered) * 100
      : 0;
  const showXpAdjust = canAdjustXp && Boolean(userId);
  return (
    <StatPanel title="Activity" icon={Activity} accent="blue">
      <div className="flex flex-wrap items-baseline gap-4">
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
            Level
          </p>
          <p className="text-2xl sm:text-3xl font-bold tabular-nums text-blue-600 dark:text-blue-400">
            {statistics?.level ?? 0}
          </p>
        </div>
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
            XP
          </p>
          <p className="text-base sm:text-lg font-semibold tabular-nums text-muted-foreground truncate">
            {formatNumber(statistics?.xp ?? 0)}
          </p>
        </div>
      </div>
      <div className="mt-4 space-y-0.5 border-t pt-3">
        <PanelRow label="Packs Opened" value={String(statistics?.openedPacks ?? 0)} />
        <PanelRow label="Battles Played" value={String(statistics?.battlesPlayed ?? 0)} />
        <PanelRow label="Inventory Items" value={String(inventoryCount)} />
        <PanelRow label="Avg Deposit" value={formatCurrency(avgDeposit)} />
        <PanelRow
          label="Avg House Edge"
          value={balances && balances.totalWagered > 0 ? `${houseEdge.toFixed(2)}%` : "—"}
        />
      </div>
      {showXpAdjust && (
        <div className="mt-3 pt-3 border-t">
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => setXpAdjustOpen(true)}
          >
            Adjust XP
          </Button>
        </div>
      )}
      {showXpAdjust && userId && (
        <XpAdjustDialog
          userId={userId}
          open={xpAdjustOpen}
          onOpenChange={setXpAdjustOpen}
        />
      )}
    </StatPanel>
  );
}

// ───────────────────────────────────────────────────────────────────
//  COMPACT METRIC TILE — used in-tab (e.g. CreatorTab)
// ───────────────────────────────────────────────────────────────────

/**
 * Compact metric tile — similar to the hero KPI tile but for in-tab use.
 * Kept inline rather than reusing the hero KpiTile so in-tab tiles can
 * have their own sizing rules independent of the hero.
 */
export function ModernMetricTile({
  label,
  value,
  accent,
  icon: Icon,
}: {
  label: string;
  value: string;
  accent: keyof typeof TILE_COLORS;
  icon: React.ElementType;
}) {
  const colors = TILE_COLORS[accent] ?? TILE_COLORS.blue;
  return (
    <div className={cn("rounded-xl border p-3 sm:p-4 min-w-0", colors.bg)}>
      <div className="flex items-center gap-2">
        <Icon className={cn("size-4 shrink-0", colors.icon)} />
        <span className="text-[10px] sm:text-[11px] font-semibold uppercase tracking-wider text-muted-foreground truncate">
          {label}
        </span>
      </div>
      <p className={cn("mt-1 text-xl sm:text-2xl font-bold tabular-nums truncate", colors.text)}>
        {value}
      </p>
    </div>
  );
}

