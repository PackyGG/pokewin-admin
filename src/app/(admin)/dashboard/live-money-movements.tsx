"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowDownCircle, ArrowUpCircle, Wallet } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { AnimatedNumber } from "@/components/animated-number";
import { formatCurrency, formatRelative } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import type { LiveMoneyMovementItem } from "@/lib/queries/dashboard-live";
import { fetchRecentMoneyMovements } from "./live-actions";

const MAX_ITEMS = 20;
// 6s poll — same cadence as the (now-retired) Live Deposits panel. The
// combined query runs two parallel SELECTs + two parallel aggregates
// against the existing created_at / requested_at indexes, plus the small
// bonus-pairing query that only runs when there are fresh deposits in
// the slice. Cursor advances on every fetch so subsequent polls are
// bound by `created_at > <cursor>` / `requested_at > <cursor>` and only
// return rows added since the last poll.
const POLL_INTERVAL_MS = 6000;

/**
 * Live combined Deposits + Withdrawals feed for the dashboard. Bootstraps
 * its initial snapshot on mount, then polls `fetchRecentMoneyMovements`
 * every 6s (cursor-advanced so each row arrives once), pausing while the
 * tab is hidden. New rows slide in from the top.
 *
 * House-POV coloring (per CLAUDE.md, strict):
 *   - Deposit (user funds in) → house gain → 🟢 emerald
 *   - Withdrawal (user takes out) → house loss → 🔴 rose
 */
export function LiveMoneyMovements() {
  const [items, setItems] = React.useState<LiveMoneyMovementItem[]>([]);
  const [total24hDeposits, setTotal24hDeposits] = React.useState<number>(0);
  const [total24hWithdrawals, setTotal24hWithdrawals] = React.useState<number>(0);
  const [bootstrapped, setBootstrapped] = React.useState(false);
  // The id set is used to flag newly-arrived rows for the slide-in animation.
  // The bootstrap snapshot is rendered statically — only rows that appear
  // after it get the entry animation so the first paint doesn't flash.
  const [newIds, setNewIds] = React.useState<Set<string>>(() => new Set());
  const cursorRef = React.useRef<string | null>(null);
  // Re-render every 30s so relative timestamps ("12s ago") stay fresh even
  // when no new items arrive.
  const [, setNow] = React.useState(0);

  React.useEffect(() => {
    const tick = setInterval(() => setNow((n) => n + 1), 30_000);
    return () => clearInterval(tick);
  }, []);

  // One-shot bootstrap: load the newest snapshot + the 24h totals on mount
  // (cursor null = newest N). Runs before the polling loop so the panel
  // fills immediately instead of waiting a poll interval.
  React.useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetchRecentMoneyMovements(null);
        if (!alive) return;
        setTotal24hDeposits(res.total24hDeposits);
        setTotal24hWithdrawals(res.total24hWithdrawals);
        const snap = res.items.slice(0, MAX_ITEMS);
        setItems(snap);
        cursorRef.current = snap.length > 0 ? snap[0].createdAt : null;
      } catch {
        // Silent — the polling loop below will retry and fill the panel.
      } finally {
        if (alive) setBootstrapped(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  React.useEffect(() => {
    let alive = true;
    const poll = async () => {
      if (!alive) return;
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        return;
      }
      try {
        const res = await fetchRecentMoneyMovements(cursorRef.current);
        if (!alive) return;
        setTotal24hDeposits(res.total24hDeposits);
        setTotal24hWithdrawals(res.total24hWithdrawals);
        if (res.items.length > 0) {
          // Server returns newest first; cursor is the newest seen timestamp.
          cursorRef.current = res.items[0].createdAt;
          setItems((prev) => {
            const existing = new Set(prev.map((i) => i.id));
            const fresh = res.items.filter((i) => !existing.has(i.id));
            if (fresh.length === 0) return prev;
            // Flag the fresh ids so the entry animation runs for them, then
            // clear the flags after the animation is done so re-renders from
            // the 30s time-refresh don't re-trigger.
            setNewIds((old) => {
              const next = new Set(old);
              for (const f of fresh) next.add(f.id);
              return next;
            });
            window.setTimeout(() => {
              setNewIds((old) => {
                if (old.size === 0) return old;
                const next = new Set(old);
                for (const f of fresh) next.delete(f.id);
                return next;
              });
            }, 600);
            return [...fresh, ...prev].slice(0, MAX_ITEMS);
          });
        }
      } catch {
        // Silent — admin sees stale data rather than a toast storm.
      }
    };
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  return (
    <div className="relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-card/80">
      {/* Two corner glows — emerald top-right echoes the deposits hero,
          rose bottom-left echoes the withdrawals hero. Subtle, matches
          the rest of the dashboard's modern panels. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -right-12 -top-12 size-40 rounded-full bg-emerald-500/10 blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -left-12 -bottom-12 size-40 rounded-full bg-rose-500/10 blur-3xl"
      />
      <div className="relative flex flex-col p-5">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="flex size-7 items-center justify-center rounded-lg bg-emerald-500/10">
              <Wallet className="size-3.5 text-emerald-500" />
            </div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Live Money Movements
            </h3>
          </div>
          <LivePulse />
        </div>

        {/* Two stacked hero numbers — deposits (emerald) and withdrawals
            (rose). Side-by-side at sm+, stacked on narrow screens so each
            value can stay legible without truncation. */}
        <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            {bootstrapped ? (
              <AnimatedNumber
                value={total24hDeposits}
                format="currency"
                className="text-2xl font-bold text-emerald-600 dark:text-emerald-400 sm:text-3xl"
              />
            ) : (
              <Skeleton className="h-9 w-36" />
            )}
            <p className="mt-0.5 text-xs text-muted-foreground">
              Last 24h deposited
            </p>
          </div>
          <div>
            {bootstrapped ? (
              <AnimatedNumber
                value={total24hWithdrawals}
                format="currency"
                className="text-2xl font-bold text-rose-600 dark:text-rose-400 sm:text-3xl"
              />
            ) : (
              <Skeleton className="h-9 w-36" />
            )}
            <p className="mt-0.5 text-xs text-muted-foreground">
              Last 24h withdrawn
            </p>
          </div>
        </div>

        <div className="max-h-[32rem] overflow-y-auto -mx-5 px-5">
          {items.length === 0 ? (
            bootstrapped ? (
              <EmptyState
                icon={Wallet}
                title="Waiting for activity"
                description="New deposits and withdrawal requests land here in real time."
                compact
              />
            ) : (
              <MovementsSkeleton />
            )
          ) : (
            <ul className="divide-y divide-border/60">
              {items.map((item) => (
                <MovementRow
                  key={item.id}
                  item={item}
                  isNew={newIds.has(item.id)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function MovementRow({
  item,
  isNew,
}: {
  item: LiveMoneyMovementItem;
  isNew: boolean;
}) {
  const fallback = (item.username ?? "?").slice(0, 2).toUpperCase();
  const isDeposit = item.kind === "deposit";
  // House-POV colors (per CLAUDE.md): deposit = emerald (house gain),
  // withdrawal = rose (house loss). Sign mirrors the existing
  // RecentActivity feed — "+" for deposits (money in), "-" for
  // withdrawals (money out).
  const amountClass = isDeposit
    ? "text-emerald-600 dark:text-emerald-400"
    : "text-rose-600 dark:text-rose-400";
  const KindIcon = isDeposit ? ArrowDownCircle : ArrowUpCircle;
  const kindIconClass = isDeposit ? "text-emerald-500" : "text-rose-500";
  const sign = isDeposit ? "+" : "-";

  return (
    <li
      className={cn(
        "group -mx-5 flex items-center gap-3 px-5 py-3 transition-colors hover:bg-muted/30",
        isNew &&
          "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-2 motion-safe:duration-300 motion-reduce:animate-in motion-reduce:fade-in motion-reduce:duration-200",
      )}
    >
      <div className="relative shrink-0">
        <Avatar className="size-9">
          {item.image ? (
            <AvatarImage src={item.image} alt={item.username} />
          ) : null}
          <AvatarFallback>{fallback}</AvatarFallback>
        </Avatar>
        {/* Small kind badge tucked at the bottom-right of the avatar —
            green down-arrow for deposits, red up-arrow for withdrawals.
            Same visual language as RecentActivity's kind chip. */}
        <span
          className={cn(
            "absolute -bottom-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full bg-card ring-2 ring-card",
          )}
          aria-hidden
        >
          <KindIcon className={cn("size-3.5", kindIconClass)} />
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Link
            href={`/users/${item.userId}`}
            className="truncate hover:underline"
          >
            {item.username}
          </Link>
          {item.cryptoAsset && (
            <span className="shrink-0 rounded-md border border-border/70 bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              {item.cryptoAsset}
            </span>
          )}
          {/* Withdrawal-only: surface the method (physical / crypto) so an
              admin can tell at a glance whether shipping or crypto-rails
              is in play. Deposits don't need this — the asset chip above
              already tells the story. */}
          {!isDeposit && item.method && (
            <span className="shrink-0 rounded-md border border-rose-500/30 bg-rose-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-rose-600 dark:text-rose-400">
              {item.method}
            </span>
          )}
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {formatRelative(item.createdAt)}
          {isDeposit && item.bonusAmount != null && item.bonusAmount > 0 ? (
            <span className="ml-1 text-emerald-600/80 dark:text-emerald-400/80">
              +{formatCurrency(item.bonusAmount)} bonus
            </span>
          ) : null}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <div
          className={cn(
            "text-base font-bold tabular-nums",
            amountClass,
          )}
        >
          {sign}
          {formatCurrency(item.amount)}
        </div>
      </div>
    </li>
  );
}

function LivePulse() {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400"
      aria-label="Live"
    >
      <span className="relative flex size-1.5">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-75 motion-reduce:hidden" />
        <span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
      </span>
      Live
    </span>
  );
}

function MovementsSkeleton() {
  // Skeleton rows mirroring MovementRow (avatar + two text lines + amount)
  // so the initial bootstrap reads as a clean loading state — matching
  // Recent Activity's skeleton — instead of a bare spinner.
  return (
    <ul className="divide-y divide-border/60" aria-hidden>
      {Array.from({ length: 5 }).map((_, i) => (
        <li key={i} className="-mx-5 flex items-center gap-3 px-5 py-3">
          <Skeleton className="size-9 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-3 w-16" />
          </div>
          <Skeleton className="ml-auto h-4 w-14 shrink-0" />
        </li>
      ))}
    </ul>
  );
}
