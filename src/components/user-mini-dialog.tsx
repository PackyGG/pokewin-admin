"use client";

import * as React from "react";
import Link from "next/link";
import {
  ExternalLink,
  Wallet,
  Coins,
  Trophy,
  TrendingUp,
  TrendingDown,
  Hash,
  Globe,
  Mail,
  Calendar,
  Loader2,
  RefreshCw,
  AlertTriangle,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import {
  formatCurrency,
  formatNumber,
  formatRelative,
} from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ROLE_COLORS } from "@/lib/constants";
import type { UserMiniSummary } from "@/lib/queries/users-mini";
import { fetchUserMiniSummary } from "@/app/(admin)/users/mini-actions";

/**
 * Compact "preview" pop-up of a user, opened from any surface that
 * surfaces a username in the live admin shell — the LiveMoneyChat
 * rail rows, and any future component that needs a peek without a
 * full page navigation.
 *
 * Shows:
 *   • Avatar, username, email, role chip, country, signup date
 *   • Balance summary: cash + locked + inventory value + voucher
 *     value (matched against the /users/[id] panel's scope)
 *   • Lifetime totals: Deposited / Withdrawn / Wagered / Won
 *   • House P&L (house-POV: deposits − withdrawals − cash −
 *     inventory − vouchers)
 *   • Recent 5 ledger transactions for quick activity context
 *   • "Open full profile" button → /users/[id]
 *
 * Data is fetched lazily on `open=true` so the dialog doesn't run
 * the query when it's closed. Re-fetches whenever `userId` changes
 * (so toggling between rows reloads cleanly).
 */
export function UserMiniDialog({
  userId,
  open,
  onOpenChange,
}: {
  userId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [data, setData] = React.useState<UserMiniSummary | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [errorCode, setErrorCode] = React.useState<string | null>(null);
  const [retryKey, setRetryKey] = React.useState(0);

  React.useEffect(() => {
    if (!open || !userId) return;
    let alive = true;
    setLoading(true);
    setError(null);
    setErrorCode(null);
    setData(null);
    fetchUserMiniSummary(userId)
      .then((result) => {
        if (!alive) return;
        if (!result.success) {
          setError(result.error);
          setErrorCode(result.code ?? null);
          return;
        }
        setData(result.data);
      })
      .catch(() => {
        if (!alive) return;
        setError(
          "Couldn't load this preview right now. Try again or open the full profile.",
        );
        setErrorCode("LOAD_FAILED");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, userId, retryKey]);

  const handleRetry = React.useCallback(() => {
    setError(null);
    setErrorCode(null);
    setLoading(true);
    setRetryKey((k) => k + 1);
  }, []);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {loading || (!data && !error) ? (
          <DialogLoadingSkeleton />
        ) : error ? (
          <ErrorState
            message={error}
            code={errorCode}
            userId={userId}
            onRetry={handleRetry}
            retrying={loading}
          />
        ) : data ? (
          <UserMiniContent data={data} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function DialogLoadingSkeleton() {
  return (
    <>
      <DialogHeader>
        <DialogTitle className="sr-only">Loading user</DialogTitle>
        <DialogDescription className="sr-only">
          Fetching user summary
        </DialogDescription>
      </DialogHeader>
      <div className="flex items-center gap-3">
        <Skeleton className="size-12 rounded-full" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-48" />
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <Skeleton className="h-16 rounded-lg" />
        <Skeleton className="h-16 rounded-lg" />
        <Skeleton className="h-16 rounded-lg" />
        <Skeleton className="h-16 rounded-lg" />
      </div>
      <div className="mt-2 flex items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        Loading…
      </div>
    </>
  );
}

function ErrorState({
  message,
  code,
  userId,
  onRetry,
  retrying,
}: {
  message: string;
  code: string | null;
  userId: string | null;
  onRetry: () => void;
  retrying: boolean;
}) {
  const title =
    code === "FORBIDDEN"
      ? "No access"
      : code === "NOT_FOUND"
        ? "User not found"
        : "Preview unavailable";

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <AlertTriangle className="size-4 text-amber-500 shrink-0" />
          {title}
        </DialogTitle>
        <DialogDescription>{message}</DialogDescription>
      </DialogHeader>
      <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onRetry}
          disabled={retrying}
          className="w-full sm:w-auto"
        >
          {retrying ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          Try again
        </Button>
        {userId && code !== "FORBIDDEN" && (
          <Link
            href={`/users/${userId}`}
            className={cn(
              "inline-flex w-full items-center justify-center gap-1 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 sm:w-auto",
            )}
          >
            Open full profile
            <ExternalLink className="size-3.5" />
          </Link>
        )}
      </DialogFooter>
    </>
  );
}

function UserMiniContent({ data }: { data: UserMiniSummary }) {
  const { user, balance } = data;
  const initials = (user.username ?? user.email ?? "?").slice(0, 2).toUpperCase();
  const roleColor = ROLE_COLORS[user.role] ?? ROLE_COLORS.user;

  const totalBalance =
    balance.availableBalance +
    balance.lockedBalance +
    data.inventoryValue +
    data.vouchersValue;

  // Use the canonical lifetime P&L straight off the helper. The query
  // routes through `calculateUserPnl` so deposits/withdrawals/balance/
  // inventory/voucher inputs match /users/[id] exactly — recomputing
  // from the wire data would re-introduce the under-reported-withdrawals
  // bug (the canonical helper sums BOTH `balances.total_withdrawn` AND
  // `card_withdrawal_requests`, which we don't ship separately).
  const pnl = data.pnl;
  const pnlPositive = pnl >= 0;
  const pnlDegraded = data.degraded?.pnl === true;
  const recentTxDegraded = data.degraded?.recentTransactions === true;

  // Avg RTP — total_won / total_wagered.
  const rtp =
    balance.totalWagered > 0
      ? (balance.totalWon / balance.totalWagered) * 100
      : 0;

  return (
    <>
      <DialogHeader>
        <div className="flex items-start gap-3">
          <Avatar className="size-12 shrink-0">
            {user.image ? (
              <AvatarImage src={user.image} alt={user.username ?? "user"} />
            ) : null}
            <AvatarFallback>{initials}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate">
              {user.username ?? user.email ?? user.id.slice(0, 12)}
            </DialogTitle>
            <DialogDescription className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              {user.email && (
                <span className="flex items-center gap-1">
                  <Mail className="size-3" />
                  <span className="truncate">{user.email}</span>
                </span>
              )}
              {user.country && (
                <span className="flex items-center gap-1">
                  <Globe className="size-3" />
                  {user.country.toUpperCase()}
                </span>
              )}
              <span className="flex items-center gap-1">
                <Calendar className="size-3" />
                Joined {formatRelative(user.createdAt)}
              </span>
            </DialogDescription>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span
                className={cn(
                  "inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
                  roleColor,
                )}
              >
                {user.role}
              </span>
              <span className="font-mono text-[10px] text-muted-foreground">
                {user.id.slice(0, 8)}…
              </span>
            </div>
          </div>
        </div>
      </DialogHeader>

      {(pnlDegraded || recentTxDegraded) && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-muted-foreground">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
          <span>
            {pnlDegraded && recentTxDegraded
              ? "Some stats timed out — numbers may be incomplete. Open the full profile for the complete view."
              : pnlDegraded
                ? "House P&L timed out — other stats still loaded. Open the full profile for exact numbers."
                : "Recent activity timed out — other stats still loaded."}
          </span>
        </div>
      )}

      {/* Stat grid — 2x2 hero. */}
      <div className="grid grid-cols-2 gap-2">
        <MiniStat
          icon={Wallet}
          label="Total Balance"
          value={formatCurrency(totalBalance)}
          accentClass="text-emerald-600 dark:text-emerald-400"
          sub={`${formatCurrency(balance.availableBalance)} cash`}
        />
        <MiniStat
          icon={pnlPositive ? TrendingUp : TrendingDown}
          label="House P&L"
          value={
            pnlDegraded
              ? "—"
              : `${pnlPositive ? "+" : ""}${formatCurrency(pnl)}`
          }
          accentClass={
            pnlDegraded
              ? "text-muted-foreground"
              : pnlPositive
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-rose-600 dark:text-rose-400"
          }
          sub={pnlDegraded ? "timed out" : "lifetime"}
        />
        <MiniStat
          icon={Coins}
          label="Deposited"
          value={formatCurrency(balance.totalDeposited)}
          sub={`${formatCurrency(balance.totalWithdrawn)} withdrawn`}
        />
        <MiniStat
          icon={Trophy}
          label="Avg RTP"
          value={`${rtp.toFixed(1)}%`}
          sub={`${formatCurrency(balance.totalWagered)} wagered`}
        />
      </div>

      {/* Inventory + Vouchers compact row. */}
      <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/40 px-3 py-2 text-xs">
        <div className="flex items-center gap-1.5">
          <Hash className="size-3.5 text-muted-foreground" />
          <span className="text-muted-foreground">Inventory</span>
          <span className="font-mono font-semibold tabular-nums">
            {formatCurrency(data.inventoryValue)}
          </span>
          <span className="text-muted-foreground">
            ({formatNumber(data.inventoryCount)} items)
          </span>
        </div>
        {data.vouchersValue > 0 && (
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground">Vouchers</span>
            <span className="font-mono font-semibold tabular-nums">
              {formatCurrency(data.vouchersValue)}
            </span>
          </div>
        )}
      </div>

      {/* Recent activity — last 5 ledger rows, compact. */}
      <div className="space-y-1.5">
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Recent activity
        </p>
        {recentTxDegraded ? (
          <p className="text-xs text-muted-foreground">
            Recent activity timed out — open the full profile to see it.
          </p>
        ) : data.recentTransactions.length === 0 ? (
          <p className="text-xs text-muted-foreground">No activity yet.</p>
        ) : (
          <ul className="divide-y divide-border/60 rounded-lg border bg-muted/30">
            {data.recentTransactions.map((tx) => (
              <li
                key={tx.id}
                className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-xs"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">
                    {prettyTxType(tx.type)}
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    {formatRelative(tx.createdAt)}
                  </p>
                </div>
                <span
                  className={cn(
                    "shrink-0 font-mono text-xs font-semibold tabular-nums",
                    tx.amount >= 0
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-rose-600 dark:text-rose-400",
                  )}
                >
                  {tx.amount > 0 ? "+" : ""}
                  {formatCurrency(tx.amount)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <DialogFooter>
        <Link
          href={`/users/${user.id}`}
          className={cn(
            "inline-flex w-full items-center justify-center gap-1 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 sm:w-auto",
          )}
        >
          Open full profile
          <ExternalLink className="size-3.5" />
        </Link>
      </DialogFooter>
    </>
  );
}

function MiniStat({
  icon: Icon,
  label,
  value,
  sub,
  accentClass,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  sub?: string;
  accentClass?: string;
}) {
  return (
    <div className="rounded-lg border bg-card/40 px-3 py-2 min-w-0">
      <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        <Icon className="size-3" />
        <span className="truncate">{label}</span>
      </div>
      <p
        className={cn(
          "mt-1 truncate text-base font-bold tabular-nums",
          accentClass,
        )}
      >
        {value}
      </p>
      {sub && (
        <p className="truncate text-[10px] text-muted-foreground">{sub}</p>
      )}
    </div>
  );
}

/**
 * Render a ledger `type` string as a friendly label. Falls back to a
 * Title Case of the raw value so unknown types still read cleanly.
 */
function prettyTxType(type: string): string {
  const map: Record<string, string> = {
    deposit: "Deposit",
    pack_opening: "Pack opening",
    battle_bet: "Battle bet",
    battle_sponsorship: "Battle sponsorship",
    battle_refund: "Battle win",
    upgrader_bet: "Upgrader bet",
    upgrader_payout: "Upgrader win",
    card_sale: "Card sale",
    card_withdrawal: "Card withdrawal",
    rain_win: "Rain win",
    race_prize: "Race prize",
    creator_tip: "Creator tip",
    deposit_bonus: "Deposit bonus",
    rakeback_claim: "Rakeback claim",
    affiliate_claim: "Affiliate claim",
    admin_balance_adjustment: "Admin adjustment",
    voucher_redeemed: "Voucher redeemed",
    gift_card_redeemed: "Gift card redeemed",
    promo_code_redeemed: "Promo code",
    waitlist_prize: "Waitlist prize",
    balance_reward_claim: "Balance reward",
  };
  return map[type] ?? type.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}
