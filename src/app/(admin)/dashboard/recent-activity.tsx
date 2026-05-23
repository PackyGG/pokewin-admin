"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowDownCircle,
  ArrowUpCircle,
  Circle,
  Gift,
  Package,
  Swords,
  UserPlus,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { AnimatedNumber } from "@/components/animated-number";
import { formatCurrency, formatRelative } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { BorrowBadge } from "@/components/borrow-badge";
import type {
  LiveActivityEventKind,
  LiveActivityItem,
} from "@/lib/queries/dashboard-live";
import { useSseStream } from "@/lib/hooks/use-sse";
import { fetchRecentActivityLive } from "./live-actions";

const MAX_ITEMS = 50;
// Fallback polling cadence — only used if SSE can't connect (very old
// browsers, or repeated connection failures).
const POLL_INTERVAL_MS = 3000;

// ---------------------------------------------------------------------------
// House-perspective color system (see CLAUDE.md — "Financial Perspective
// Coloring"). Green = house gains, red = house loses, blue = neutral.
// ---------------------------------------------------------------------------

type KindStyle = {
  icon: LucideIcon;
  label: string;
  iconClass: string;
  chipBg: string;
  amountClass: string;
  amountSign: "+" | "-" | "";
};

const KIND_STYLES: Record<LiveActivityEventKind, KindStyle> = {
  // User gave the house money — good for us.
  deposit: {
    icon: ArrowDownCircle,
    label: "Deposit",
    iconClass: "text-emerald-500",
    chipBg: "bg-emerald-500/10 ring-1 ring-emerald-500/20",
    amountClass: "text-emerald-600 dark:text-emerald-400",
    amountSign: "+",
  },
  // We paid a user out — bad for us.
  withdrawal: {
    icon: ArrowUpCircle,
    label: "Withdrawal",
    iconClass: "text-rose-500",
    chipBg: "bg-rose-500/10 ring-1 ring-rose-500/20",
    amountClass: "text-rose-600 dark:text-rose-400",
    amountSign: "-",
  },
  // User spent money on a bet — good for us (their capital is now our
  // pool; the outcome is priced in by GGR).
  wager: {
    icon: Swords,
    label: "Wager",
    iconClass: "text-emerald-500",
    chipBg: "bg-emerald-500/10 ring-1 ring-emerald-500/20",
    amountClass: "text-emerald-600 dark:text-emerald-400",
    amountSign: "+",
  },
  // Rain wins, race prizes, creator tips — all money leaving the platform.
  payout: {
    icon: Gift,
    label: "Payout",
    iconClass: "text-rose-500",
    chipBg: "bg-rose-500/10 ring-1 ring-rose-500/20",
    amountClass: "text-rose-600 dark:text-rose-400",
    amountSign: "-",
  },
  // Neutral event.
  signup: {
    icon: UserPlus,
    label: "New signup",
    iconClass: "text-blue-500",
    chipBg: "bg-blue-500/10 ring-1 ring-blue-500/20",
    amountClass: "text-blue-600 dark:text-blue-400",
    amountSign: "",
  },
};

// Friendly labels for raw ledger types. Overrides the kind label when we
// want to be more specific ("Battle wager" vs generic "Wager").
const TYPE_LABELS: Record<string, string> = {
  deposit: "Deposit",
  card_withdrawal: "Card withdrawal",
  pack_opening: "Pack wager",
  battle_bet: "Battle wager",
  battle_sponsorship: "Battle sponsorship",
  battle_refund: "Battle win",
  rain_win: "Rain win",
  race_prize: "Race prize",
  creator_tip: "Creator tip",
  rakeback_claim: "Rakeback claim",
  affiliate_claim: "Affiliate payout",
  deposit_bonus: "Deposit bonus",
  admin_balance_adjustment: "Admin adjustment",
  balance_reward_claim: "Balance reward",
  waitlist_prize: "Waitlist prize",
  gift_card_redeemed: "Gift card redeemed",
  promo_code_redeemed: "Promo code",
  voucher_redeemed: "Voucher redeemed",
  signup: "New signup",
};

export function RecentActivity({
  signups24h,
  packsOpened24h,
  battlesPlayed24h,
}: {
  /** Rolling-24h counts for the stats strip at the top of the card.
   *  Refreshed by the dashboard's 60s router.refresh(). */
  signups24h: number;
  packsOpened24h: number;
  battlesPlayed24h: number;
}) {
  // The feed self-bootstraps from the SSE `init` snapshot (up to 30 rows
  // delivered the moment the stream connects), so it no longer needs a
  // server-rendered `initial` prop. Dropping that prop decouples the feed
  // from the dashboard's 60s router.refresh(), which used to re-run
  // getLiveActivity(50) only to re-seed a prop the lazy useState
  // initializer ignored after first render. The polling fallback below
  // bootstraps with a null cursor when SSE is unavailable.
  const [items, setItems] = React.useState<LiveActivityItem[]>([]);
  const [newIds, setNewIds] = React.useState<Set<string>>(() => new Set());
  const cursorRef = React.useRef<string | null>(null);
  // When SSE proves unavailable we flip to the old polling path. Default
  // stays on SSE for every modern browser.
  const [useFallback, setUseFallback] = React.useState<boolean>(
    () => typeof window !== "undefined" && typeof EventSource === "undefined",
  );
  const [, setNow] = React.useState(0);

  React.useEffect(() => {
    const tick = setInterval(() => setNow((n) => n + 1), 30_000);
    return () => clearInterval(tick);
  }, []);

  // Shared merge helper — mutates the items list with a set of fresh rows,
  // deduping by id, capping at MAX_ITEMS, and triggering the "new" flash
  // animation for 600ms.
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
      // Newest-first order: reverse the `toAdd` batch so a single SSE
      // tick that delivers several rows keeps the freshest one on top.
      const withNew = [...[...toAdd].reverse(), ...prev];
      return withNew.slice(0, MAX_ITEMS);
    });
  }, []);

  // SSE path — default for every modern browser.
  useSseStream<LiveActivityItem>(
    "/api/live/activity",
    {
      onInit: (rows) => {
        // The server emits an initial snapshot of up to 30 rows (newest-
        // first). The parent already rendered `initial` SSR, so we just
        // dedupe and advance the cursor to the freshest row we know about.
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
      onGiveUp: () => setUseFallback(true),
    },
    { enabled: !useFallback },
  );

  // Polling fallback — only active when SSE is unavailable / gave up.
  // With a null cursor the first call returns the newest snapshot, so
  // this also bootstraps the feed when SSE never connected. Runs once
  // immediately, then on the interval.
  React.useEffect(() => {
    if (!useFallback) return;
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
        const fresh = await fetchRecentActivityLive(cursorRef.current);
        if (!alive || fresh.length === 0) return;
        cursorRef.current = fresh[0].createdAt;
        merge(fresh);
      } catch {
        // Silent — polling will recover on the next tick.
      }
    };
    poll();
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [useFallback, merge]);

  return (
    <div className="relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-card/80">
      <div
        aria-hidden
        className="pointer-events-none absolute -right-24 -top-24 size-60 rounded-full bg-blue-500/10 blur-3xl"
      />
      {/* Rolling-24h stats strip — signups + packs + battles. Each
          cell mirrors the Live Deposits card header: icon chip +
          uppercase label, count below. Blue chips tie into this
          card's blue theme. Counts are volume, not money, so the
          numbers stay neutral — no emerald/rose (a green count would
          misread as a house gain). */}
      <div className="relative grid grid-cols-3 divide-x divide-border/60 border-b border-border/60">
        <ActivityStat icon={UserPlus} label="Signups" value={signups24h} />
        <ActivityStat
          icon={Package}
          label="Packs opened"
          value={packsOpened24h}
        />
        <ActivityStat icon={Swords} label="Battles" value={battlesPlayed24h} />
      </div>
      <div className="relative max-h-[40rem] overflow-y-auto">
        {items.length === 0 ? (
          <EmptyState label="Waiting for activity..." />
        ) : (
          <ul className="divide-y divide-border/60">
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
  const typeLabel = TYPE_LABELS[item.type] ?? style.label;
  const hasAmount = item.amount != null && item.amount > 0;

  return (
    <li
      className={cn(
        "flex items-center gap-3 px-3 py-3 transition-colors hover:bg-muted/30 sm:px-5",
        isNew &&
          "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-2 motion-safe:duration-300 motion-reduce:animate-in motion-reduce:fade-in motion-reduce:duration-200",
      )}
    >
      {/* Event-type chip. */}
      <div
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-lg",
          style.chipBg,
        )}
      >
        <Icon className={cn("size-4", style.iconClass)} />
      </div>

      {/* Username + caption stack on the left — username is the dominant
          line, type + time live as muted metadata underneath. */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Link
            href={`/users/${item.userId}`}
            className="block truncate text-sm font-semibold text-foreground hover:underline"
          >
            {item.username}
          </Link>
          {/* Borrow signal sits next to the username so it's visible
              even on a busy feed without scanning the metadata line.
              Renders nothing for non-borrowed events. */}
          <BorrowBadge
            percent={item.borrowPercentage}
            amountUsd={item.borrowedAmountUsd}
            size="sm"
          />
        </div>
        <p className="truncate text-xs text-muted-foreground">
          <span className={style.amountClass}>{typeLabel}</span>
          <span className="mx-1.5 text-muted-foreground/60">·</span>
          {formatRelative(item.createdAt)}
        </p>
      </div>

      {/* Amount on the right, bold and colored by house-POV. Absent rows
          (e.g. signups) get an em-dash placeholder so the column still
          aligns. */}
      <div
        className={cn(
          "shrink-0 text-right text-sm font-bold tabular-nums",
          hasAmount ? style.amountClass : "text-muted-foreground/60",
        )}
      >
        {hasAmount ? (
          <>
            {style.amountSign}
            {formatCurrency(item.amount!)}
          </>
        ) : (
          "—"
        )}
      </div>
    </li>
  );
}

// One cell of the rolling-24h stats strip. Title row (icon chip +
// uppercase label) on top, count below — the same vocabulary as the
// Live Deposits card header so the two cards read as a set.
function ActivityStat({
  icon: Icon,
  label,
  value,
}: {
  icon: LucideIcon;
  label: string;
  value: number;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2 p-4">
      <div className="flex items-center gap-2">
        <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-blue-500/10">
          <Icon className="size-3.5 text-blue-500" />
        </div>
        <span className="truncate text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
      </div>
      <AnimatedNumber
        value={value}
        format="number"
        className="text-2xl font-bold tabular-nums"
      />
    </div>
  );
}

export function RecentActivityLivePulse() {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-blue-500/30 bg-blue-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-blue-600 dark:text-blue-400"
      aria-label="Live"
    >
      <span className="relative flex size-1.5">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-blue-500 opacity-75 motion-reduce:hidden" />
        <span className="relative inline-flex size-1.5 rounded-full bg-blue-500" />
      </span>
      Live
    </span>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-20 text-center">
      <Circle className="size-5 animate-pulse text-muted-foreground motion-reduce:animate-none" />
      <p className="text-sm text-muted-foreground">{label}</p>
    </div>
  );
}
