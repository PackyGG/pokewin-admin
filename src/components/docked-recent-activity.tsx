"use client";

import * as React from "react";
import Link from "next/link";
import {
  Activity,
  ArrowDownCircle,
  ArrowUpCircle,
  ChevronRight,
  Gift,
  Package,
  Swords,
  UserPlus,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCurrency, formatRelative } from "@/lib/utils/format";
import { Skeleton } from "@/components/ui/skeleton";
import type {
  LiveActivityEventKind,
  LiveActivityItem,
} from "@/lib/queries/dashboard-live";
import { useSseStream } from "@/lib/hooks/use-sse";
import {
  railSlotStyle,
  useRailWidget,
} from "@/components/right-rail-context";
import {
  fetchDockedActivityLive,
  fetchRecentActivityCounts24h,
} from "./docked-recent-activity-actions";

/**
 * Persistent docked Recent Activity widget on the right edge of the
 * admin shell — the middle slot of the right rail, between the Live
 * money feed (top) and the Chat & Mutes dock (bottom). Mirrors the
 * `<LiveMoneyChat />` chrome + interactions so the three docked
 * widgets read as a set.
 *
 * Bootstraps via SSE on `/api/live/activity` (one EventSource per tab,
 * deduped through `useSseStream`'s shared connection layer) and falls
 * back to polling `fetchDockedActivityLive` if SSE can't connect. The
 * rolling-24h counts strip — signups + packs + battles — comes from a
 * separate server action that piggy-backs on the dashboard's existing
 * caches (60s for the pack/battle counts, 5min for signups) so the
 * widget adds no extra DB pressure once warm.
 *
 * House-POV color rule (per CLAUDE.md):
 *   • Deposit / Wager  → 🟢 emerald (house gain)
 *   • Withdrawal / Payout → 🔴 rose  (house loss)
 *   • Signup → 🔵 blue (neutral)
 *
 * Collapse state survives reloads via the shared right-rail context's
 * localStorage persistence. The at-most-2-open rule (enforced inside
 * RightRailProvider) auto-collapses the oldest-opened panel when the
 * user expands a third.
 */

// Shared width with the other two docked widgets so they line up.
const PANEL_WIDTH_PX = 320;
const MAX_ITEMS = 30;
// Polling fallback cadence — only kicks in when SSE gives up.
const POLL_INTERVAL_MS = 3000;
// 24h counts strip refresh — matches the dashboard's 60s auto-refresh
// cadence so the docked numbers stay in lockstep with the page version.
const COUNTS_REFRESH_MS = 60_000;

// Connection status — drives the header status pill. Mirrors the
// LiveMoneyChat treatment so the three docked widgets all surface
// the same kinds of state. "live" is the SSE happy path; "polling"
// kicks in when SSE gave up and the polling fallback is active;
// "reconnecting" / "offline" appear when consecutive polling failures
// stretch the backoff.
type FeedStatus =
  | "connecting"
  | "live"
  | "polling"
  | "reconnecting"
  | "offline";

// Exponential backoff schedule for the polling fallback. Each failure
// extends the delay by an extra step; after OFFLINE_AFTER_FAILURES
// consecutive failures the pill flips to "offline" so the admin sees
// it. Polling never STOPS — the cadence just stretches.
const BACKOFF_DELAYS_MS = [0, 3_000, 9_000, 21_000, 30_000];
const OFFLINE_AFTER_FAILURES = 5;

type CountStrip = {
  signups24h: number;
  packsOpened24h: number;
  battlesPlayed24h: number;
};

// ---------------------------------------------------------------------------
// House-perspective color system (mirrors RecentActivity in the dashboard
// page so the docked widget + the historical in-page card use the same
// visual vocabulary). Green = house gains, red = house loses, blue = neutral.
// ---------------------------------------------------------------------------

type KindStyle = {
  icon: LucideIcon;
  iconClass: string;
  chipBg: string;
  amountClass: string;
  amountSign: "+" | "-" | "";
  rowTint: string;
};

const KIND_STYLES: Record<LiveActivityEventKind, KindStyle> = {
  deposit: {
    icon: ArrowDownCircle,
    iconClass: "text-emerald-500",
    chipBg: "bg-emerald-500/10",
    amountClass: "text-emerald-600 dark:text-emerald-400",
    amountSign: "+",
    rowTint: "hover:bg-emerald-500/5",
  },
  withdrawal: {
    icon: ArrowUpCircle,
    iconClass: "text-rose-500",
    chipBg: "bg-rose-500/10",
    amountClass: "text-rose-600 dark:text-rose-400",
    amountSign: "-",
    rowTint: "hover:bg-rose-500/5",
  },
  wager: {
    icon: Swords,
    iconClass: "text-emerald-500",
    chipBg: "bg-emerald-500/10",
    amountClass: "text-emerald-600 dark:text-emerald-400",
    amountSign: "+",
    rowTint: "hover:bg-emerald-500/5",
  },
  payout: {
    icon: Gift,
    iconClass: "text-rose-500",
    chipBg: "bg-rose-500/10",
    amountClass: "text-rose-600 dark:text-rose-400",
    amountSign: "-",
    rowTint: "hover:bg-rose-500/5",
  },
  signup: {
    icon: UserPlus,
    iconClass: "text-blue-500",
    chipBg: "bg-blue-500/10",
    amountClass: "text-blue-600 dark:text-blue-400",
    amountSign: "",
    rowTint: "hover:bg-blue-500/5",
  },
};

// Friendly per-type labels — kept aligned with the dashboard's in-page
// RecentActivity component so the docked widget and the historical card
// (when re-introduced for any reason) speak the same vocabulary.
const TYPE_LABELS: Record<string, string> = {
  deposit: "Deposit",
  card_withdrawal: "Withdrawal",
  pack_opening: "Pack",
  battle_bet: "Battle",
  battle_sponsorship: "Battle sponsor",
  battle_refund: "Battle win",
  rain_win: "Rain win",
  race_prize: "Race prize",
  creator_tip: "Creator tip",
  rakeback_claim: "Rakeback",
  affiliate_claim: "Affiliate",
  deposit_bonus: "Bonus",
  admin_balance_adjustment: "Adjustment",
  balance_reward_claim: "Reward",
  waitlist_prize: "Waitlist",
  gift_card_redeemed: "Gift card",
  promo_code_redeemed: "Promo",
  voucher_redeemed: "Voucher",
  signup: "Signup",
};

export function DockedRecentActivity() {
  const { open, setOpen, allOpen, mounted } = useRailWidget("recent");

  // ── 24h counts strip ─────────────────────────────────────────────────
  // Server action result: signups + packs + battles in the last 24h.
  // null = not yet bootstrapped (renders a skeleton).
  const [counts, setCounts] = React.useState<CountStrip | null>(null);

  // Bootstrap + refresh on a 60s tick (matches the dashboard's
  // AutoRefresh cadence; the underlying caches dedupe so this is cheap).
  // Pauses while the tab is hidden (visibilitychange resumes).
  React.useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (!alive) return;
      if (
        typeof document !== "undefined" &&
        document.visibilityState !== "visible"
      ) {
        // Reschedule for later — don't poll while hidden.
        if (timer) clearTimeout(timer);
        timer = setTimeout(tick, COUNTS_REFRESH_MS);
        return;
      }
      try {
        const res = await fetchRecentActivityCounts24h();
        if (alive) setCounts(res);
      } catch {
        // Silent — the live event list above already surfaces the
        // status pill; a single failing counts refresh is too minor
        // to flip the pill on its own.
      }
      if (timer) clearTimeout(timer);
      if (alive) timer = setTimeout(tick, COUNTS_REFRESH_MS);
    };
    tick();
    const onVisibility = () => {
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "visible" &&
        alive
      ) {
        // Immediate refresh on tab return.
        tick();
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

  // ── Live event list (SSE + polling fallback) ─────────────────────────
  const [items, setItems] = React.useState<LiveActivityItem[]>([]);
  const [newIds, setNewIds] = React.useState<Set<string>>(() => new Set());
  const cursorRef = React.useRef<string | null>(null);
  const [useFallback, setUseFallback] = React.useState<boolean>(
    () => typeof window !== "undefined" && typeof EventSource === "undefined",
  );
  // Connection status — surfaces SSE health vs polling fallback vs
  // backoff state. The SSE path itself (via use-sse.ts) handles
  // exponential backoff and visibility binding internally; this
  // status state just reflects what's happening.
  const [status, setStatus] = React.useState<FeedStatus>("connecting");
  const pollFailuresRef = React.useRef<number>(0);
  // Re-render every 30s so relative timestamps stay fresh.
  const [, setNow] = React.useState(0);
  React.useEffect(() => {
    const tick = setInterval(() => setNow((n) => n + 1), 30_000);
    return () => clearInterval(tick);
  }, []);

  // Shared merge helper — dedupes by id, caps at MAX_ITEMS, flashes new
  // rows for 600ms via the `newIds` set.
  const merge = React.useCallback((incoming: LiveActivityItem[]) => {
    if (incoming.length === 0) return;
    setItems((prev) => {
      const existing = new Set(prev.map((i) => i.id));
      const toAdd = incoming.filter((i) => !existing.has(i.id));
      if (toAdd.length === 0) return prev;
      setNewIds((old) => {
        const next = new Set(old);
        for (const f of toAdd) next.add(f.id);
        return next;
      });
      window.setTimeout(() => {
        setNewIds((old) => {
          if (old.size === 0) return old;
          const next = new Set(old);
          for (const f of toAdd) next.delete(f.id);
          return next;
        });
      }, 600);
      // Newest-first: reverse the incoming batch so a single SSE tick
      // delivering several rows keeps the freshest one on top.
      const withNew = [...[...toAdd].reverse(), ...prev];
      return withNew.slice(0, MAX_ITEMS);
    });
  }, []);

  // SSE — default for modern browsers. Mirrors the dashboard
  // RecentActivity's stream handling exactly so the two share the
  // deduped connection (`useSseStream` reuses one EventSource per URL).
  // Status is set inline: onInit marks the feed live; onGiveUp flips
  // to the polling fallback (status will be set there).
  useSseStream<LiveActivityItem>(
    "/api/live/activity",
    {
      onInit: (rows) => {
        setStatus("live");
        if (rows.length === 0) return;
        const newest = rows[0].createdAt;
        if (
          cursorRef.current == null ||
          new Date(newest).getTime() > new Date(cursorRef.current).getTime()
        ) {
          cursorRef.current = newest;
        }
        merge(rows);
      },
      onRow: (row) => {
        cursorRef.current = row.createdAt;
        merge([row]);
      },
      onReconnect: () => setStatus("reconnecting"),
      onGiveUp: () => setUseFallback(true),
    },
    { enabled: !useFallback },
  );

  // Polling fallback — kicks in if SSE gave up. Bootstraps with a null
  // cursor (newest snapshot), then strict-gt afterward. Implements
  // exponential backoff on consecutive failures so an outage doesn't
  // pile up Vercel function calls, plus visibilitychange pause/resume
  // so background tabs don't waste cycles.
  React.useEffect(() => {
    if (!useFallback) return;
    setStatus("polling");
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = (delay: number) => {
      if (!alive) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(poll, delay);
    };

    const poll = async () => {
      if (!alive) return;
      if (
        typeof document !== "undefined" &&
        document.visibilityState !== "visible"
      ) {
        schedule(POLL_INTERVAL_MS);
        return;
      }
      try {
        const fresh = await fetchDockedActivityLive(cursorRef.current);
        if (!alive) return;
        pollFailuresRef.current = 0;
        setStatus("polling");
        if (fresh.length > 0) {
          cursorRef.current = fresh[0].createdAt;
          merge(fresh);
        }
      } catch {
        pollFailuresRef.current += 1;
        if (alive) {
          setStatus(
            pollFailuresRef.current >= OFFLINE_AFTER_FAILURES
              ? "offline"
              : "reconnecting",
          );
        }
      }
      const failures = pollFailuresRef.current;
      const delay =
        failures === 0
          ? POLL_INTERVAL_MS
          : BACKOFF_DELAYS_MS[
              Math.min(failures, BACKOFF_DELAYS_MS.length - 1)
            ];
      schedule(delay + POLL_INTERVAL_MS);
    };

    // First poll immediately (the SSE bootstrap may already have
    // populated some items; the polling path catches up from there).
    schedule(0);

    const onVisibility = () => {
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "visible" &&
        alive
      ) {
        pollFailuresRef.current = 0;
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
  }, [useFallback, merge]);

  // ── Collapsed tab ────────────────────────────────────────────────────
  // The slot's `top` + `height` come from `railSlotStyle`; this widget
  // just renders the visual chrome. Label is "Recent" (not "Activity")
  // so it parallels the other two tabs' short single-word labels ("Live",
  // "Chat") and the rotated text fits inside the fixed tab height
  // without overflow.
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open recent activity feed"
        title="Open recent activity feed"
        style={railSlotStyle("recent", allOpen, mounted)}
        className={cn(
          "fixed right-0 z-30 flex w-14 flex-col items-center justify-center gap-2 rounded-l-lg border border-r-0 bg-card/95 px-2 shadow-md backdrop-blur",
          "hover:bg-card transition-colors",
        )}
      >
        <Activity className="size-4 text-blue-500" />
        <span className="relative flex size-1.5">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-blue-500 opacity-75 motion-reduce:hidden" />
          <span className="relative inline-flex size-1.5 rounded-full bg-blue-500" />
        </span>
        <span
          className="font-mono text-[10px] font-semibold uppercase leading-none tracking-wider text-muted-foreground"
          style={{ writingMode: "vertical-rl" }}
        >
          Recent
        </span>
      </button>
    );
  }

  return (
    <aside
      aria-label="Recent activity feed"
      style={{ width: PANEL_WIDTH_PX, ...railSlotStyle("recent", allOpen, mounted) }}
      className={cn(
        // Middle slot of the right rail. Anchors come from
        // `railSlotStyle` — the `top` + `bottom` reflow when either
        // Live (above) or Chat (below) collapses. `z-30` sits above
        // normal content but below modals (z-50).
        "fixed right-0 z-30 flex flex-col overflow-hidden rounded-l-2xl border border-r-0 bg-card/95 shadow-xl backdrop-blur",
      )}
    >
      {/* Header — title + live pulse + minimize chevron. Mirrors the
          LiveMoneyChat header (whole strip is the click target; chevron
          is just the affordance cue). Blue gradient instead of
          emerald/rose so the three docked widgets are visually
          distinguishable at a glance. */}
      <button
        type="button"
        onClick={() => setOpen(false)}
        aria-label="Minimize recent activity feed"
        title="Minimize"
        className="flex w-full items-center justify-between gap-2 border-b bg-gradient-to-r from-blue-500/5 via-card to-cyan-500/5 px-3 py-2 text-left transition-colors hover:from-blue-500/10 hover:to-cyan-500/10"
      >
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex size-6 shrink-0 items-center justify-center rounded-md bg-blue-500/10">
            <Activity className="size-3.5 text-blue-500" />
          </div>
          <h3 className="truncate text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Activity
          </h3>
          <StatusPill status={status} />
        </div>
        <span
          aria-hidden
          className="pointer-events-none rounded-md p-1 text-muted-foreground"
        >
          <ChevronRight className="size-3.5" />
        </span>
      </button>

      {/* Rolling-24h counts strip — signups + packs + battles. Compact
          (3 cells, mono numbers) so the panel doesn't lose too much of
          its event-list real estate to the strip. Numbers stay neutral
          (volume, not money) per the house-POV rule. */}
      <div className="grid grid-cols-3 gap-1 border-b px-3 py-2 text-xs">
        <CountCell
          icon={UserPlus}
          label="Signups"
          value={counts?.signups24h ?? null}
        />
        <CountCell
          icon={Package}
          label="Packs"
          value={counts?.packsOpened24h ?? null}
        />
        <CountCell
          icon={Swords}
          label="Battles"
          value={counts?.battlesPlayed24h ?? null}
        />
      </div>

      {/* Scrolling event list. */}
      <div className="flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 py-8 text-center">
            <Activity className="size-6 text-muted-foreground/40" />
            <p className="text-xs font-medium text-muted-foreground">
              Waiting for activity
            </p>
            <p className="text-[10px] text-muted-foreground/70">
              Deposits, wagers, payouts and signups will appear here.
            </p>
          </div>
        ) : (
          <ul className="flex flex-col">
            {items.map((item) => (
              <ActivityRow
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

function CountCell({
  icon: Icon,
  label,
  value,
}: {
  icon: LucideIcon;
  label: string;
  value: number | null;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex items-center gap-1">
        <Icon className="size-3 shrink-0 text-blue-500" />
        <span className="truncate text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
      </div>
      {value == null ? (
        <Skeleton className="h-4 w-8" />
      ) : (
        <span className="font-mono text-sm font-bold tabular-nums">
          {value}
        </span>
      )}
    </div>
  );
}

function ActivityRow({
  item,
  isNew,
}: {
  item: LiveActivityItem;
  isNew: boolean;
}) {
  const style = KIND_STYLES[item.kind];
  const Icon = style.icon;
  const typeLabel = TYPE_LABELS[item.type] ?? item.type;
  const hasAmount = item.amount != null && item.amount > 0;

  return (
    <li
      className={cn(
        "group flex items-center gap-2 border-b px-3 py-2 transition-colors",
        style.rowTint,
        isNew &&
          "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-2 motion-safe:duration-300",
      )}
    >
      <div
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-lg",
          style.chipBg,
        )}
        aria-hidden
      >
        <Icon className={cn("size-3.5", style.iconClass)} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <Link
            href={`/users/${item.userId}`}
            className="truncate text-xs font-medium hover:underline focus-visible:underline focus-visible:outline-none"
            title={`Open ${item.username}`}
          >
            {item.username}
          </Link>
          {hasAmount ? (
            <span
              className={cn(
                "shrink-0 font-mono text-xs font-bold tabular-nums",
                style.amountClass,
              )}
            >
              {style.amountSign}
              {formatCurrency(item.amount!)}
            </span>
          ) : (
            <span className="shrink-0 text-xs text-muted-foreground/60">
              —
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span className={cn("truncate", style.amountClass)}>{typeLabel}</span>
          <span className="text-muted-foreground/60">·</span>
          <span className="truncate">{formatRelative(item.createdAt)}</span>
        </div>
      </div>
    </li>
  );
}

/**
 * Status pill — reflects the SSE / polling fallback / backoff state.
 *   • "connecting"   — bootstrap before the first init frame arrives.
 *   • "live"         — SSE has emitted at least one init (steady state).
 *   • "polling"      — SSE gave up, polling fallback is active and healthy.
 *   • "reconnecting" — SSE forced a reconnect, OR consecutive poll fails.
 *   • "offline"      — sustained polling failure; still retrying every 30s.
 *
 * The default identity color of this widget is blue (matches the chrome),
 * which we keep for both "live" and "polling" since the user-visible
 * outcome is the same (data still flows). Amber + rose stand out so a
 * blip is visible without overwhelming the chrome.
 */
function StatusPill({ status }: { status: FeedStatus }) {
  const map = {
    connecting: {
      label: "Connecting",
      title: "Connecting to the live activity feed…",
      border: "border-muted-foreground/30",
      bg: "bg-muted/40",
      text: "text-muted-foreground",
      dot: "bg-muted-foreground",
      pulse: true,
    },
    live: {
      label: "Live",
      title: "Live feed is current (server push)",
      border: "border-blue-500/30",
      bg: "bg-blue-500/10",
      text: "text-blue-600 dark:text-blue-400",
      dot: "bg-blue-500",
      pulse: true,
    },
    polling: {
      label: "Live",
      title: "Live feed is current (polling fallback)",
      border: "border-blue-500/30",
      bg: "bg-blue-500/10",
      text: "text-blue-600 dark:text-blue-400",
      dot: "bg-blue-500",
      pulse: true,
    },
    reconnecting: {
      label: "Reconnecting",
      title: "Connection blip — retrying with backoff",
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
