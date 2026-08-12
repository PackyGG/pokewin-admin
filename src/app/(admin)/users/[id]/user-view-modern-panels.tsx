"use client";

/**
 * "Modern" stat panels used by the modern user detail view. Split out of
 * user-view-modern.tsx to keep files focused and under ~500 lines. Pure
 * presentation — no data fetching, no side effects.
 *
 * The generic primitives (TILE_COLORS / SectionHeading / StatPanel /
 * PanelRow) are NOT defined here anymore — this file used to carry local
 * copies that drifted from the canonical set (Record<string,…> typing,
 * missing orange/pink accents, stale heading tags, no responsive padding).
 * They now come from `@/components/modern-panels` (single source of truth)
 * and are re-exported below so the existing `./user-view-modern-panels`
 * import sites keep working. Only the genuinely page-specific pieces
 * (px-3 SectionHeading alignment, equal-height StatPanel column, the
 * Modern*Panel composites) stay local.
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
import { StepUpField } from "@/components/step-up-field";
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
  XpAdjustDialog,
} from "./user-tabs-dialogs";
import { extendVaultLock, refreshUserDetailCache } from "./actions";
import type {
  UserDetail,
  PnlBreakdown,
} from "./user-tabs-types";
import {
  TILE_COLORS,
  SectionHeading as SharedSectionHeading,
  StatPanel as SharedStatPanel,
} from "@/components/modern-panels";

// ───────────────────────────────────────────────────────────────────
//  SHARED PRIMITIVES — canonical copies live in @/components/modern-panels
// ───────────────────────────────────────────────────────────────────
// Re-exported (not redefined) so the sibling files that import them from
// "./user-view-modern-panels" keep working without carrying a second,
// drift-prone implementation in this file.

export { TILE_COLORS, PanelRow } from "@/components/modern-panels";
export type { AccentColor } from "@/components/modern-panels";

/**
 * Page-local alignment wrapper around the shared SectionHeading: px-3
 * matches CollapsibleSection's trigger padding so a plain SectionHeading's
 * icon/title lines up with a collapsible box's icon/title directly above
 * or below it, instead of sitting flush left. All heading styling comes
 * from the shared primitive.
 */
export function SectionHeading(
  props: React.ComponentProps<typeof SharedSectionHeading>,
) {
  return (
    <div className="px-3">
      <SharedSectionHeading {...props} />
    </div>
  );
}

/**
 * Page-local layout wrapper around the shared StatPanel: this page renders
 * its panels in equal-height grid rows with bottom-pinned footers (see
 * ModernPnlPanel's `mt-auto` rolling-P&L chips), so every panel here opts
 * into the `flex h-full flex-col` column. All panel styling comes from the
 * shared primitive.
 */
export function StatPanel({
  className,
  ...props
}: React.ComponentProps<typeof SharedStatPanel>) {
  return (
    <SharedStatPanel
      {...props}
      className={cn("flex h-full flex-col", className)}
    />
  );
}

// Compact "mini-box" stat tile rendered INSIDE a StatPanel's breakdown grid
// (the small boxes-inside-the-box the dashboard uses). Replaces the old
// vertical PanelRow list so the three Overview panels stay short + equal
// height. Flat + neutral by design: one hairline border + a subtle
// `bg-muted/40` inset on the card surface, `rounded-lg`, NO glow / gradient /
// sheen — matches the just-shipped flat pilot. The accent lives only on the
// value number (House-POV tinted where it's money) via `valueClassName`.
//   • `sub`    — optional tiny caption under the value (e.g. the Vault
//                unlock-at timestamp, the Locked wager-progress hint).
//   • `action` — optional top-right affordance on the label row (e.g. the
//                Vault "Remove"/freeze button).
//   • `className` — grid escape hatch, e.g. `col-span-2` for a wide tile.
function PanelStat({
  label,
  value,
  valueClassName,
  sub,
  action,
  className,
}: {
  label: string;
  value: React.ReactNode;
  valueClassName?: string;
  sub?: string | null;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col rounded-lg border border-border bg-muted/40 px-2.5 py-2",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-1.5">
        <p className="min-w-0 truncate text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          {label}
        </p>
        {action}
      </div>
      <p className={cn("mt-1 truncate text-sm font-semibold tabular-nums", valueClassName)}>
        {value}
      </p>
      {sub ? (
        <p className="mt-0.5 truncate text-[10px] uppercase tracking-wider text-muted-foreground/70">
          {sub}
        </p>
      ) : null}
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
 *     the backend HTTP API. That action exists but it is a
 *     panel-wide action surfaced on the Wager Progress card; reusing it
 *     from this row would dilute the dialog UX that card carries (confirm copy +
 *     audit row + toast). For now the row's inline Remove button stays
 *     disabled and the tooltip points operators at that card —
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
  showRemove = true,
  className,
}: {
  label: string;
  amount: number;
  valueClassName?: string;
  sub?: string | null;
  removeKind: "vault" | "wager";
  // Optional handler — when provided the Remove button is enabled and
  // clicking it fires this callback (typically opens a confirm dialog).
  // Wired for `removeKind="vault"` via the freeze-vault flow.
  onRemoveClick?: () => void;
  // When false the trailing Remove affordance is not rendered at all
  // (used for the wager-debt row, which has no backend unlock action).
  // Defaults to true so the Vault row keeps its Remove button unchanged.
  showRemove?: boolean;
  // Grid escape hatch forwarded to the underlying PanelStat mini-box
  // (e.g. `col-span-2` so the Locked pocket spans the full breakdown grid).
  className?: string;
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

  // The Vault / Locked pockets render as the SAME mini-box as every other
  // breakdown stat (via PanelStat); the only extra is the trailing Remove
  // affordance in the box's top-right action slot (Vault: enabled freeze
  // flow; Locked: suppressed via showRemove=false → no button at all).
  const removeButton =
    amount > 0 && showRemove ? (
      <Button
        variant="ghost"
        size="sm"
        disabled={!enabled}
        onClick={enabled ? onRemoveClick : undefined}
        className={cn(
          "h-5 shrink-0 px-1.5 text-[10px] font-semibold uppercase tracking-wider",
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
    ) : null;

  return (
    <PanelStat
      label={label}
      value={formatCurrency(amount)}
      valueClassName={valueClassName}
      sub={sub}
      action={removeButton}
      className={className}
    />
  );
}

export function ModernBalancePanel({
  balances,
  userId,
  pnl7d,
  canAdjustBalance = false,
  canUseUltraLossback = false,
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
  canUseUltraLossback?: boolean;
}) {
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [vaultFreezeOpen, setVaultFreezeOpen] = useState(false);
  // Soft-refresh the page server data when the admin clicks the icon —
  // re-runs the parent server components without a hard browser
  // reload, so the user keeps their tab focus / scroll position and
  // the rest of the page DOM stays intact while the balance numbers
  // re-fetch. useTransition wraps the call so the icon can show a
  // pending spinner without blocking the rest of the UI.
  //
  // CACHE-BUST FIRST: the surrounding user-detail aggregate remains cached,
  // but page.tsx overlays this box with a narrow, uncached primary-DB read.
  // Invalidating the per-user tag keeps the rest of the profile coherent;
  // router.refresh() then obtains authoritative balance values even while the
  // read mirror is catching up.
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
  const showAdjust =
    (canAdjustBalance || canUseUltraLossback) && Boolean(userId);
  return (
    <StatPanel
      title="Balances"
      icon={Wallet}
      accent="emerald"
      action={refreshAction}
    >
      <div className="space-y-0.5">
        <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          Total Value
        </p>
        <p className="text-2xl sm:text-3xl font-bold tracking-tight tabular-nums text-emerald-600 dark:text-emerald-400 truncate">
          {formatCurrency(total)}
        </p>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 border-t pt-3">
        <PanelStat label="Cash" value={formatCurrency(balances.availableBalance)} />
        {/* Vault — cooldown-locked balance (user's own money, just not
            spendable yet). BLUE/muted neutral: it IS the user's money.
            Trailing "Remove" affordance freezes the vault for 10 years —
            see LockedRowWithRemove. */}
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
        <PanelStat label="Inventory" value={formatCurrency(balances.inventoryValue)} />
        <PanelStat label="Vouchers" value={formatCurrency(balances.vouchersValue)} />
      </div>
      {showAdjust && (
        <div className="mt-3 pt-3 border-t">
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => setAdjustOpen(true)}
          >
            Adjust Balance
          </Button>
        </div>
      )}
      {showAdjust && userId && (
        <BalanceAdjustDialog
          userId={userId}
          availableBalance={balances.availableBalance}
          availableBalanceRaw={balances.availableBalanceRaw}
          lockedBalance={balances.lockedBalance}
          pnl7d={pnl7d}
          canUseUltraLossback={canUseUltraLossback}
          open={adjustOpen}
          onOpenChange={setAdjustOpen}
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
          <StepUpField value={totpCode} onChange={setTotpCode} />
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
  const fiatDeposits = balances?.fiatDeposits ?? 0;
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
        <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground truncate">
          Deposits − Withdrawals − Balance − Inventory
        </p>
        <p
          className={cn(
            "text-2xl sm:text-3xl font-bold tracking-tight tabular-nums truncate",
            isProfit ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400",
          )}
        >
          {isProfit ? "+" : ""}
          {formatCurrency(pnl)}
        </p>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 border-t pt-3">
        <PanelStat
          label="Deposited"
          value={formatCurrency(deposits)}
          sub={fiatDeposits > 0 ? `${formatCurrency(fiatDeposits)} fiat` : null}
        />
        <PanelStat label="Withdrawn" value={formatCurrency(withdrawals)} />
        {vouchersValue > 0 ? (
          <PanelStat
            label="Unclaimed vouchers"
            value={`-${formatCurrency(vouchersValue)}`}
          />
        ) : null}
        {/* Bonuses given — house handed the user money (house-loss side) →
            rose. When the Unclaimed-vouchers box is absent this is the 3rd
            (odd) box, so it spans the full grid width to avoid a lonely
            half-tile. */}
        <PanelStat
          label="Bonuses given"
          value={`-${formatCurrency(pnlBreakdown.bonusesCost)}`}
          valueClassName="text-rose-500"
          className={vouchersValue > 0 ? undefined : "col-span-2"}
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
  inventoryCount,
  avgDeposit,
  userId,
  canAdjustXp = false,
}: {
  statistics: UserDetail["statistics"];
  // `balances` is still accepted (the caller passes it) but no longer read
  // here — the Avg House Edge tile that used balances.totalWagered/totalWon
  // was removed. Kept in the type so the call site stays valid without a
  // cross-file change; drop it here if the prop is ever removed upstream.
  balances?: UserDetail["balances"];
  inventoryCount: number;
  avgDeposit: number;
  userId?: string;
  canAdjustXp?: boolean;
}) {
  const [xpAdjustOpen, setXpAdjustOpen] = useState(false);

  const showXpAdjust = canAdjustXp && Boolean(userId);
  return (
    <StatPanel title="Activity" icon={Activity} accent="blue">
      <div className="flex flex-wrap items-baseline gap-4">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            Level
          </p>
          <p className="text-2xl sm:text-3xl font-bold tracking-tight tabular-nums text-blue-600 dark:text-blue-400">
            {statistics?.level ?? 0}
          </p>
        </div>
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            XP
          </p>
          <p className="text-base sm:text-lg font-semibold tabular-nums text-muted-foreground truncate">
            {formatNumber(statistics?.xp ?? 0)}
          </p>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 border-t pt-3">
        <PanelStat label="Packs Opened" value={String(statistics?.openedPacks ?? 0)} />
        <PanelStat label="Battles Played" value={String(statistics?.battlesPlayed ?? 0)} />
        <PanelStat label="Inventory Items" value={String(inventoryCount)} />
        <PanelStat label="Avg Deposit" value={formatCurrency(avgDeposit)} />
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
  // Flat tile: neutral bg-card surface + hairline border (no per-hue tinted
  // box, no shadow). The accent survives only on the icon + the value number,
  // so the strip reads as calm neutral cards with meaningful colored numbers
  // rather than a rainbow of tinted boxes. Kept deliberately denser than the
  // hero-style tiles (p-3 / text-xl, no responsive scale-up) — the Account
  // tab stacks several of these grids in a row, so a compact tile keeps the
  // tab scannable instead of towering.
  return (
    <div className="rounded-lg border bg-card p-3 min-w-0">
      <div className="flex items-center gap-1.5">
        <Icon className={cn("size-3.5 shrink-0", colors.icon)} />
        <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground truncate">
          {label}
        </span>
      </div>
      <p className={cn("mt-1 text-xl font-bold tracking-tight tabular-nums truncate", colors.text)}>
        {value}
      </p>
    </div>
  );
}
