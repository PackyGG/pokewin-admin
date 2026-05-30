"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowDownCircle,
  ArrowUpCircle,
  ChevronRight,
  Wallet,
} from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { formatCurrency, formatRelative } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import type { LiveMoneyMovementItem } from "@/lib/queries/dashboard-live";
import { fetchRecentMoneyMovements } from "@/app/(admin)/dashboard/live-actions";
import {
  COLLAPSED_LIVE_HEIGHT_REM,
  useRightRail,
} from "@/components/right-rail-context";

/**
 * Persistent right-side live-activity widget — a "chat-style" panel
 * that streams every deposit + withdrawal request as it hits the
 * platform. Always visible (not behind a button) and positioned with
 * `fixed` so it floats above page content and stays in place when the
 * admin scrolls.
 *
 * Designed as a reusable primitive: drop `<LiveMoneyChat />` into any
 * page that wants the live feed alongside it. The component itself
 * handles bootstrapping, polling, collapse state, and persistence —
 * pages don't need to pass anything.
 *
 * House-POV colors (per CLAUDE.md):
 *   • Deposit (user funds in)    → emerald (house gain)
 *   • Withdrawal (user takes out) → rose (house loss)
 *
 * Collapse state survives reloads via localStorage so an admin who
 * minimized it on one page returns to a minimized panel on another.
 *
 * Note on width: the panel reserves its own right-side real estate via
 * the `<LiveMoneyChatSpacer />` companion component, which pages can
 * render once at the top of their main content so the floating panel
 * doesn't cover anything important. The two stay in sync via a shared
 * width constant.
 */

// Two source files reference these dimensions — keep them in sync.
const PANEL_WIDTH_PX = 320;
const COLLAPSED_WIDTH_PX = 56;

const MAX_ITEMS = 30;
// 6s poll cadence — same as the (retired) bottom-row panel. The
// underlying query runs four parallel SELECTs against existing indexed
// columns; no full-table scans.
const POLL_INTERVAL_MS = 6000;

export function LiveMoneyChat() {
  // Open/close state lives in the shared right-rail context so the
  // chat dock below can react: collapsing the live feed pulls the
  // chat up to fill the freed space; expanding it pushes chat back
  // into the bottom half.
  const { liveOpen: open, setLiveOpen: setOpen } = useRightRail();
  const [items, setItems] = React.useState<LiveMoneyMovementItem[]>([]);
  const [total24hDeposits, setTotal24hDeposits] = React.useState(0);
  const [total24hWithdrawals, setTotal24hWithdrawals] = React.useState(0);
  const [bootstrapped, setBootstrapped] = React.useState(false);
  const [newIds, setNewIds] = React.useState<Set<string>>(() => new Set());
  const cursorRef = React.useRef<string | null>(null);
  // Re-render every 30s so relative timestamps stay fresh.
  const [, setNow] = React.useState(0);

  React.useEffect(() => {
    const tick = setInterval(() => setNow((n) => n + 1), 30_000);
    return () => clearInterval(tick);
  }, []);

  // One-shot bootstrap.
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
        // Silent — polling loop retries.
      } finally {
        if (alive) setBootstrapped(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Polling loop — pauses while the tab is hidden.
  React.useEffect(() => {
    let alive = true;
    const poll = async () => {
      if (!alive) return;
      if (
        typeof document !== "undefined" &&
        document.visibilityState !== "visible"
      ) {
        return;
      }
      try {
        const res = await fetchRecentMoneyMovements(cursorRef.current);
        if (!alive) return;
        setTotal24hDeposits(res.total24hDeposits);
        setTotal24hWithdrawals(res.total24hWithdrawals);
        if (res.items.length > 0) {
          cursorRef.current = res.items[0].createdAt;
          setItems((prev) => {
            const existing = new Set(prev.map((i) => i.id));
            const fresh = res.items.filter((i) => !existing.has(i.id));
            if (fresh.length === 0) return prev;
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
        // Silent.
      }
    };
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // Collapsed: a thin vertical tab on the right edge. Clicking expands.
  // The tab is pinned to a fixed height (COLLAPSED_LIVE_HEIGHT_REM) so
  // the chat dock below can position itself predictably right under
  // it when live is closed — without a fixed height the chat dock
  // would have to measure the tab dynamically.
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open live money feed"
        title="Open live money feed"
        style={{ height: `${COLLAPSED_LIVE_HEIGHT_REM}rem` }}
        className={cn(
          // Top tab, anchored just under the admin header. The chat
          // dock sits below in the bottom half, so this tab stays in
          // the top slot when collapsed.
          "fixed right-0 top-20 z-30 flex flex-col items-center justify-center gap-2 rounded-l-lg border border-r-0 bg-card/95 px-2 shadow-md backdrop-blur",
          "hover:bg-card transition-colors",
        )}
      >
        <Wallet className="size-4 text-emerald-500" />
        <span className="relative flex size-1.5">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-75 motion-reduce:hidden" />
          <span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
        </span>
        <span
          className="font-mono text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
          style={{ writingMode: "vertical-rl" }}
        >
          Live
        </span>
      </button>
    );
  }

  return (
    <aside
      aria-label="Live money feed"
      style={{ width: PANEL_WIDTH_PX, bottom: "calc(50vh + 0.25rem)" }}
      className={cn(
        // Top HALF of the right edge — leaves the bottom half for the
        // docked chat. `top-20` tucks under the admin header; the
        // `bottom` inline-style splits the viewport at the midpoint
        // with a small gap (0.25rem) between the two stacked panels.
        // `z-30` sits above normal content but below modals (z-50).
        "fixed right-0 top-20 z-30 flex flex-col overflow-hidden rounded-l-2xl border border-r-0 bg-card/95 shadow-xl backdrop-blur",
      )}
    >
      {/* Header — title + live pulse + minimize. */}
      <div className="flex items-center justify-between gap-2 border-b bg-gradient-to-r from-emerald-500/5 via-card to-rose-500/5 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex size-6 shrink-0 items-center justify-center rounded-md bg-emerald-500/10">
            <Wallet className="size-3.5 text-emerald-500" />
          </div>
          <h3 className="truncate text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Live Money
          </h3>
          <LivePulse />
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Minimize live money feed"
          title="Minimize"
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ChevronRight className="size-3.5" />
        </button>
      </div>

      {/* Summary — compact 24h totals. */}
      <div className="grid grid-cols-2 gap-2 border-b px-3 py-2 text-xs">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            24h In
          </p>
          {bootstrapped ? (
            <p className="font-mono text-sm font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
              {formatCurrency(total24hDeposits)}
            </p>
          ) : (
            <Skeleton className="h-5 w-20" />
          )}
        </div>
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            24h Out
          </p>
          {bootstrapped ? (
            <p className="font-mono text-sm font-bold tabular-nums text-rose-600 dark:text-rose-400">
              {formatCurrency(total24hWithdrawals)}
            </p>
          ) : (
            <Skeleton className="h-5 w-20" />
          )}
        </div>
      </div>

      {/* Scrolling event list. */}
      <div className="flex-1 overflow-y-auto">
        {items.length === 0 ? (
          bootstrapped ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-4 py-8 text-center">
              <Wallet className="size-6 text-muted-foreground/40" />
              <p className="text-xs font-medium text-muted-foreground">
                Waiting for activity
              </p>
              <p className="text-[10px] text-muted-foreground/70">
                New deposits + withdrawals appear here as they happen.
              </p>
            </div>
          ) : (
            <ChatSkeleton />
          )
        ) : (
          <ul className="flex flex-col">
            {items.map((item) => (
              <ChatRow
                key={item.id}
                item={item}
                isNew={newIds.has(item.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

/**
 * Spacer companion for pages that include `<LiveMoneyChat />` and want
 * the page's main content area to reserve room for the panel instead
 * of getting partially covered. Drop this at the top level of the
 * page's wrapper to push the content left when the panel is open.
 *
 * On screens narrower than the lg breakpoint the panel auto-collapses
 * (via media-query CSS), so the spacer stays 0-wide on phones/tablets.
 */
export function LiveMoneyChatSpacer() {
  return (
    <div
      aria-hidden
      // The spacer matches the panel width on lg+ screens where the
      // panel is likely to be open. We deliberately don't try to
      // track the open/closed state — the gap when minimized just
      // gives the main content a tiny bit of breathing room from the
      // collapsed chip on the right edge.
      className="pointer-events-none hidden lg:block"
      style={{ width: PANEL_WIDTH_PX, flexShrink: 0 }}
    />
  );
}

function ChatRow({
  item,
  isNew,
}: {
  item: LiveMoneyMovementItem;
  isNew: boolean;
}) {
  const fallback = (item.username ?? "?").slice(0, 2).toUpperCase();
  const isDeposit = item.kind === "deposit";
  const amountClass = isDeposit
    ? "text-emerald-600 dark:text-emerald-400"
    : "text-rose-600 dark:text-rose-400";
  const KindIcon = isDeposit ? ArrowDownCircle : ArrowUpCircle;
  const kindIconClass = isDeposit ? "text-emerald-500" : "text-rose-500";
  const rowTint = isDeposit ? "hover:bg-emerald-500/5" : "hover:bg-rose-500/5";

  return (
    <li
      className={cn(
        "group flex items-center gap-2 border-b px-3 py-2 transition-colors",
        rowTint,
        isNew &&
          "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-2 motion-safe:duration-300",
      )}
    >
      <div className="relative shrink-0">
        <Avatar className="size-7">
          {item.image ? (
            <AvatarImage src={item.image} alt={item.username} />
          ) : null}
          <AvatarFallback className="text-[10px]">{fallback}</AvatarFallback>
        </Avatar>
        <span
          className={cn(
            "absolute -bottom-0.5 -right-0.5 flex size-3.5 items-center justify-center rounded-full bg-card ring-2 ring-card",
          )}
          aria-hidden
        >
          <KindIcon className={cn("size-3", kindIconClass)} />
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <Link
            href={`/users/${item.userId}`}
            className="truncate text-xs font-medium hover:underline"
          >
            {item.username}
          </Link>
          <span
            className={cn(
              "shrink-0 font-mono text-xs font-bold tabular-nums",
              amountClass,
            )}
          >
            {isDeposit ? "+" : "-"}
            {formatCurrency(item.amount)}
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span className="truncate">{formatRelative(item.createdAt)}</span>
          {item.cryptoAsset && (
            <span className="shrink-0 rounded border border-border/70 bg-muted/40 px-1 py-0 font-mono uppercase tracking-wider">
              {item.cryptoAsset}
            </span>
          )}
          {!isDeposit && item.method && (
            <span className="shrink-0 rounded border border-rose-500/30 bg-rose-500/10 px-1 py-0 uppercase tracking-wider text-rose-600 dark:text-rose-400">
              {item.method}
            </span>
          )}
        </div>
      </div>
    </li>
  );
}

function LivePulse() {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0 text-[9px] font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400"
      aria-label="Live"
    >
      <span className="relative flex size-1">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-75 motion-reduce:hidden" />
        <span className="relative inline-flex size-1 rounded-full bg-emerald-500" />
      </span>
      Live
    </span>
  );
}

function ChatSkeleton() {
  return (
    <ul className="flex flex-col" aria-hidden>
      {Array.from({ length: 6 }).map((_, i) => (
        <li
          key={i}
          className="flex items-center gap-2 border-b px-3 py-2"
        >
          <Skeleton className="size-7 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex items-center justify-between gap-2">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-3 w-12" />
            </div>
            <Skeleton className="h-2 w-12" />
          </div>
        </li>
      ))}
    </ul>
  );
}
