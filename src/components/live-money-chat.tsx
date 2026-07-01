"use client";

import * as React from "react";
import { UserMiniDialog } from "@/components/user-mini-dialog";
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
  railSlotStyle,
  useRailWidget,
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
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const COLLAPSED_WIDTH_PX = 56;

const MAX_ITEMS = 30;
// 6s poll cadence — same as the (retired) bottom-row panel. The
// underlying query runs four parallel SELECTs against existing indexed
// columns; no full-table scans.
const POLL_INTERVAL_MS = 6000;

// Connection status — drives the status pill in the panel header so
// an admin can tell at a glance whether the feed is fresh, recovering
// from a blip, or has given up entirely.
type FeedStatus = "connecting" | "live" | "reconnecting" | "offline";

// Exponential backoff schedule for consecutive poll failures. The
// regular cadence is 6s; after the first failure we wait 6s (no
// extra delay), after the 2nd 12s, 3rd 24s, 4th 30s (cap). After 5
// consecutive failures we tag the feed as offline — the admin sees
// it, and the next visibilitychange-resume / explicit retry resets
// the counter. We never stop polling entirely; the cadence just
// stretches so we don't hammer the server during an outage.
const BACKOFF_DELAYS_MS = [0, 6_000, 18_000, 30_000, 30_000];
const OFFLINE_AFTER_FAILURES = 5;

export function LiveMoneyChat() {
  // Open/close state lives in the shared right-rail context so the
  // other docked widgets (recent activity, chat) can reflow when the
  // live feed is collapsed — their `top` / `bottom` anchors are
  // derived from each widget's open state via `railSlotStyle`.
  const { open, setOpen, allOpen, mounted } = useRailWidget("live");
  // Clicking a username in a row opens a compact preview dialog in
  // the middle of the screen — admins can peek balance + recent
  // activity without leaving the dashboard. `null` = closed.
  const [activeUserId, setActiveUserId] = React.useState<string | null>(null);
  const [items, setItems] = React.useState<LiveMoneyMovementItem[]>([]);
  const [total24hDeposits, setTotal24hDeposits] = React.useState(0);
  const [total24hWithdrawals, setTotal24hWithdrawals] = React.useState(0);
  const [bootstrapped, setBootstrapped] = React.useState(false);
  const [newIds, setNewIds] = React.useState<Set<string>>(() => new Set());
  // Connection status — drives the header status pill. Starts as
  // "connecting" until the bootstrap fetch resolves; flips to
  // "reconnecting" on a single failure and "offline" after
  // OFFLINE_AFTER_FAILURES consecutive failures.
  const [status, setStatus] = React.useState<FeedStatus>("connecting");
  const cursorRef = React.useRef<string | null>(null);
  // Last-seen watermark for the cheap server-side pre-check. Tracked
  // separately from `cursorRef` so it advances on every poll (even when
  // no new rows landed) — when the watermark stays put, the server
  // skips the heavy 4-query row batch and only re-issues cached totals.
  // Bootstrap leaves this null so the first poll still runs the heavy
  // query; subsequent polls always pass the latest cursor as the
  // watermark and rely on the server's strict-gt check.
  const watermarkRef = React.useRef<string | null>(null);
  // Consecutive-failure counter for exponential backoff.
  const failuresRef = React.useRef<number>(0);
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
        // Bootstrap: no watermark → server runs the heavy query and
        // returns the newest snapshot. Seed both the row cursor and
        // the watermark from the same timestamp so the next poll can
        // short-circuit on the watermark when nothing new has landed.
        const res = await fetchRecentMoneyMovements(null);
        if (!alive) return;
        setTotal24hDeposits(res.total24hDeposits);
        setTotal24hWithdrawals(res.total24hWithdrawals);
        const snap = res.items.slice(0, MAX_ITEMS);
        setItems(snap);
        cursorRef.current = snap.length > 0 ? snap[0].createdAt : null;
        watermarkRef.current = cursorRef.current;
        failuresRef.current = 0;
        setStatus("live");
      } catch {
        // Polling loop will retry — flip to reconnecting so the
        // header status pill reflects the failed bootstrap.
        if (alive) setStatus("reconnecting");
      } finally {
        if (alive) setBootstrapped(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Polling loop — pauses while the tab is hidden, retries with
  // exponential backoff on failure, surfaces status via the pill.
  React.useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = (delay: number) => {
      if (!alive) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(poll, delay);
    };

    const poll = async () => {
      if (!alive) return;
      // Tab hidden — don't burn Vercel function calls in the background.
      // visibilitychange handler below resumes polling when the tab
      // becomes visible again.
      if (
        typeof document !== "undefined" &&
        document.visibilityState !== "visible"
      ) {
        schedule(POLL_INTERVAL_MS);
        return;
      }
      try {
        // Pass the row cursor as both the rows filter AND the
        // watermark. On an idle tick the server returns
        // `unchanged: true` after two cheap indexed lookups + a
        // 60s-cached totals read — no row fetch, no joins, no bonus
        // pairing query. The hero totals still refresh on every tick
        // (cache hit) so the UI numbers stay current.
        const res = await fetchRecentMoneyMovements(
          cursorRef.current,
          watermarkRef.current,
        );
        if (!alive) return;
        failuresRef.current = 0;
        setStatus("live");
        setTotal24hDeposits(res.total24hDeposits);
        setTotal24hWithdrawals(res.total24hWithdrawals);
        // Idle short-circuit: server reported no advance since the
        // last watermark. The row state is already correct — skip the
        // setItems work entirely. Totals are still applied above
        // (cached, near-free) so the hero numbers don't go stale.
        if (!res.unchanged && res.items.length > 0) {
          cursorRef.current = res.items[0].createdAt;
          watermarkRef.current = cursorRef.current;
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
        // Bump the failure counter and either flip to reconnecting
        // (transient) or offline (sustained). We never STOP polling
        // — the cadence just stretches so we don't hammer the server
        // during an outage. A visibilitychange-resume or a successful
        // poll resets the counter.
        failuresRef.current += 1;
        if (alive) {
          setStatus(
            failuresRef.current >= OFFLINE_AFTER_FAILURES
              ? "offline"
              : "reconnecting",
          );
        }
      }
      // Re-schedule. Healthy ticks use the regular cadence; failed
      // ticks step through the backoff table.
      const failures = failuresRef.current;
      const delay =
        failures === 0
          ? POLL_INTERVAL_MS
          : BACKOFF_DELAYS_MS[
              Math.min(failures, BACKOFF_DELAYS_MS.length - 1)
            ];
      schedule(delay + POLL_INTERVAL_MS);
    };

    // Kick off the first poll after the regular interval (the
    // bootstrap effect already populated the panel).
    schedule(POLL_INTERVAL_MS);

    // Visibility binding — when the tab becomes visible after a hidden
    // stretch, immediately poll once and reset the failure counter so
    // the user gets a fresh feed on return.
    const onVisibility = () => {
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "visible" &&
        alive
      ) {
        failuresRef.current = 0;
        schedule(0);
      }
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }

    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, []);

  // Collapsed: a thin vertical tab on the right edge. Clicking expands.
  // The tab's height + top offset are resolved by `railSlotStyle` so the
  // three docked widgets (live / recent / chat) stack predictably no
  // matter which combination of them is open or collapsed.
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open live money feed"
        title="Open live money feed"
        style={railSlotStyle("live", allOpen, mounted)}
        className={cn(
          // Live's collapsed tab — `railSlotStyle` provides the `top`
          // anchor and the fixed `height`; this widget just renders the
          // visual chrome. `z-30` sits above normal content but below
          // modals (z-50).
          "fixed right-0 z-30 flex w-14 flex-col items-center justify-center gap-2 rounded-l-lg border border-r-0 bg-card/95 px-2 shadow-md backdrop-blur",
          "hover:bg-card transition-colors",
        )}
      >
        <Wallet className="size-4 text-emerald-500" />
        <span className="relative flex size-1.5">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-75 motion-reduce:hidden" />
          <span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
        </span>
        <span
          className="font-mono text-[10px] font-semibold uppercase leading-none tracking-wider text-muted-foreground"
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
      style={{ width: PANEL_WIDTH_PX, ...railSlotStyle("live", allOpen, mounted) }}
      className={cn(
        // Live's open panel — `railSlotStyle` computes the `top` and
        // `bottom` anchors from the open/collapsed state of the other
        // two widgets. When recent + chat are both collapsed live
        // takes the full rail; with one peer open it shares the rail
        // 50/50; with two peers open the at-most-2 rule means live
        // can't itself be open, so this branch never renders in that
        // configuration. `z-30` sits above normal content but below
        // modals (z-50).
        "fixed right-0 z-30 flex flex-col overflow-hidden rounded-l-2xl border border-r-0 bg-card/95 shadow-xl backdrop-blur",
      )}
    >
      {/* Header — title + live pulse + minimize chevron. The whole
          strip is the click target so admins don't have to hit the
          small chevron icon to collapse the panel; the chevron is
          kept as the affordance cue. */}
      <button
        type="button"
        onClick={() => setOpen(false)}
        aria-label="Minimize live money feed"
        title="Minimize"
        className="flex w-full items-center justify-between gap-2 border-b bg-gradient-to-r from-emerald-500/5 via-card to-rose-500/5 px-3 py-2 text-left transition-colors hover:from-emerald-500/10 hover:to-rose-500/10"
      >
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex size-6 shrink-0 items-center justify-center rounded-md bg-emerald-500/10">
            <Wallet className="size-3.5 text-emerald-500" />
          </div>
          <h3 className="truncate text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Live Money
          </h3>
          <StatusPill status={status} />
        </div>
        {/* Affordance cue — visually mimics the inner button but is
            non-interactive (the outer header button handles the click).
            `pointer-events-none` lets the click pass through to the
            parent button even when the user clicks the chevron. */}
        <span
          aria-hidden
          className="pointer-events-none rounded-md p-1 text-muted-foreground"
        >
          <ChevronRight className="size-3.5" />
        </span>
      </button>

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
                onUsernameClick={setActiveUserId}
              />
            ))}
          </ul>
        )}
      </div>
      {/* Mini preview pop-up — opens in the middle of the screen when
          an admin clicks a username in a row. Centralised here so all
          rows share one dialog instance rather than mounting 30+
          dialogs. */}
      <UserMiniDialog
        userId={activeUserId}
        open={Boolean(activeUserId)}
        onOpenChange={(o) => {
          if (!o) setActiveUserId(null);
        }}
      />
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
  onUsernameClick,
}: {
  item: LiveMoneyMovementItem;
  isNew: boolean;
  /** Called with the row's user id when the admin clicks the
   *  username or the avatar — opens the parent's mini preview
   *  dialog. */
  onUsernameClick: (userId: string) => void;
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
          <button
            type="button"
            onClick={() => onUsernameClick(item.userId)}
            className="truncate text-xs font-medium hover:underline focus-visible:outline-none focus-visible:underline"
            aria-label={`Preview ${item.username}`}
            title={`Preview ${item.username}`}
          >
            {item.username}
          </button>
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

/**
 * Status pill — drives off the polling loop's connection state.
 *   • "live"          → emerald with pulse (steady-state, fresh data).
 *   • "connecting"    → muted with quiet pulse (initial bootstrap).
 *   • "reconnecting"  → amber (transient blip, the next tick should recover).
 *   • "offline"       → rose (sustained failure; still retrying with backoff).
 *
 * Title hover surfaces a longer description so admins know whether to
 * panic, refresh, or wait it out.
 */
function StatusPill({ status }: { status: FeedStatus }) {
  const map = {
    connecting: {
      label: "Connecting",
      title: "Connecting to the live feed…",
      border: "border-muted-foreground/30",
      bg: "bg-muted/40",
      text: "text-muted-foreground",
      dot: "bg-muted-foreground",
      pulse: true,
    },
    live: {
      label: "Live",
      title: "Live feed is current",
      border: "border-emerald-500/30",
      bg: "bg-emerald-500/10",
      text: "text-emerald-600 dark:text-emerald-400",
      dot: "bg-emerald-500",
      pulse: true,
    },
    reconnecting: {
      label: "Reconnecting",
      title: "Last poll failed — retrying with backoff",
      border: "border-amber-500/30",
      bg: "bg-amber-500/10",
      text: "text-amber-600 dark:text-amber-400",
      dot: "bg-amber-500",
      pulse: false,
    },
    offline: {
      label: "Offline",
      title:
        "Several consecutive polls failed. Still retrying every 30s — check Vercel logs if this persists.",
      border: "border-rose-500/30",
      bg: "bg-rose-500/10",
      text: "text-rose-600 dark:text-rose-400",
      dot: "bg-rose-500",
      pulse: false,
    },
  }[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-1.5 py-0 text-[9px] font-semibold uppercase tracking-wider",
        map.border,
        map.bg,
        map.text,
      )}
      aria-label={map.label}
      title={map.title}
    >
      <span className="relative flex size-1">
        {map.pulse && (
          <span
            className={cn(
              "absolute inline-flex size-full animate-ping rounded-full opacity-75 motion-reduce:hidden",
              map.dot,
            )}
          />
        )}
        <span
          className={cn("relative inline-flex size-1 rounded-full", map.dot)}
        />
      </span>
      {map.label}
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
