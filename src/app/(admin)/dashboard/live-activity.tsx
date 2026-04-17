"use client";

import * as React from "react";
import Link from "next/link";
import {
  Activity,
  ArrowDownCircle,
  ArrowUpCircle,
  Banknote,
  Circle,
  Gift,
  Swords,
  UserPlus,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { formatCurrency, formatRelative } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import type {
  LiveActivityEventKind,
  LiveActivityItem,
} from "@/lib/queries/dashboard-live";
import { fetchRecentActivityLive } from "./live-actions";

const MAX_ITEMS = 25;
const POLL_INTERVAL_MS = 3000;

type KindStyle = {
  icon: LucideIcon;
  label: string;
  iconClass: string;
  chipClass: string;
  amountClass: string;
  amountSign: "+" | "-" | "";
};

const KIND_STYLES: Record<LiveActivityEventKind, KindStyle> = {
  deposit: {
    icon: ArrowDownCircle,
    label: "Deposit",
    iconClass: "text-emerald-500",
    chipClass: "bg-emerald-500/10 border-emerald-500/20",
    amountClass: "text-emerald-600 dark:text-emerald-400",
    amountSign: "+",
  },
  withdrawal: {
    icon: ArrowUpCircle,
    label: "Withdrawal",
    iconClass: "text-orange-500",
    chipClass: "bg-orange-500/10 border-orange-500/20",
    amountClass: "text-orange-600 dark:text-orange-400",
    amountSign: "-",
  },
  wager: {
    icon: Swords,
    label: "Wager",
    iconClass: "text-rose-500",
    chipClass: "bg-rose-500/10 border-rose-500/20",
    amountClass: "text-rose-600 dark:text-rose-400",
    amountSign: "-",
  },
  card_sale: {
    icon: Banknote,
    label: "Card Sale",
    iconClass: "text-cyan-500",
    chipClass: "bg-cyan-500/10 border-cyan-500/20",
    amountClass: "text-cyan-600 dark:text-cyan-400",
    amountSign: "+",
  },
  payout: {
    icon: Gift,
    label: "Payout",
    iconClass: "text-purple-500",
    chipClass: "bg-purple-500/10 border-purple-500/20",
    amountClass: "text-purple-600 dark:text-purple-400",
    amountSign: "+",
  },
  signup: {
    icon: UserPlus,
    label: "Signup",
    iconClass: "text-blue-500",
    chipClass: "bg-blue-500/10 border-blue-500/20",
    amountClass: "text-blue-600 dark:text-blue-400",
    amountSign: "",
  },
};

// Friendly labels for the raw ledger types so the row detail reads like
// plain English ("Battle wager") instead of `battle_bet`.
const TYPE_LABELS: Record<string, string> = {
  deposit: "Deposit",
  card_withdrawal: "Card withdrawal",
  pack_opening: "Pack wager",
  battle_bet: "Battle wager",
  battle_sponsorship: "Battle sponsorship",
  card_sale: "Card sold",
  reward_card_sale: "Reward card sold",
  rain_win: "Rain win",
  race_prize: "Race prize",
  creator_tip: "Creator tip",
  signup: "New signup",
};

export function LiveActivity({ initial }: { initial: LiveActivityItem[] }) {
  const [items, setItems] = React.useState<LiveActivityItem[]>(() =>
    initial.slice(0, MAX_ITEMS),
  );
  const [newIds, setNewIds] = React.useState<Set<string>>(() => new Set());
  const cursorRef = React.useRef<string | null>(
    initial.length > 0 ? initial[0].createdAt : null,
  );
  const [, setNow] = React.useState(0);

  React.useEffect(() => {
    const tick = setInterval(() => setNow((n) => n + 1), 30_000);
    return () => clearInterval(tick);
  }, []);

  React.useEffect(() => {
    let alive = true;
    const poll = async () => {
      if (!alive) return;
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        return;
      }
      try {
        const fresh = await fetchRecentActivityLive(cursorRef.current);
        if (!alive || fresh.length === 0) return;
        cursorRef.current = fresh[0].createdAt;
        setItems((prev) => {
          const existing = new Set(prev.map((i) => i.id));
          const toAdd = fresh.filter((i) => !existing.has(i.id));
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
          return [...toAdd, ...prev].slice(0, MAX_ITEMS);
        });
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

  return (
    <div className="relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-card/80">
      <div
        aria-hidden
        className="pointer-events-none absolute -right-12 -top-12 size-40 rounded-full bg-blue-500/10 blur-3xl"
      />
      <div className="relative flex flex-col p-5">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="flex size-7 items-center justify-center rounded-lg bg-blue-500/10">
              <Activity className="size-3.5 text-blue-500" />
            </div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Live Activity
            </h3>
          </div>
          <LivePulse />
        </div>

        <div className="mb-4 flex items-baseline gap-2">
          <span className="text-3xl font-bold tabular-nums text-foreground">
            {items.length}
          </span>
          <span className="text-xs text-muted-foreground">
            recent event{items.length === 1 ? "" : "s"}
          </span>
        </div>

        <div className="max-h-[32rem] overflow-y-auto -mx-5 px-5">
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
  const fallback = (item.username ?? "?").slice(0, 2).toUpperCase();
  const typeLabel = TYPE_LABELS[item.type] ?? style.label;

  return (
    <li
      className={cn(
        "flex items-center gap-3 py-2.5",
        isNew &&
          "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-2 motion-safe:duration-300 motion-reduce:animate-in motion-reduce:fade-in motion-reduce:duration-200",
      )}
    >
      <Avatar className="size-8 shrink-0">
        {item.image ? (
          <AvatarImage src={item.image} alt={item.username} />
        ) : null}
        <AvatarFallback>{fallback}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm">
          <Link
            href={`/users/${item.userId}`}
            className="truncate font-medium hover:underline"
          >
            {item.username}
          </Link>
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium",
              style.chipClass,
            )}
          >
            <Icon className={cn("size-3", style.iconClass)} />
            <span className={style.amountClass}>{typeLabel}</span>
          </span>
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {formatRelative(item.createdAt)}
        </p>
      </div>
      {item.amount != null && item.amount > 0 ? (
        <div
          className={cn(
            "shrink-0 text-right text-sm font-semibold tabular-nums",
            style.amountClass,
          )}
        >
          {style.amountSign}
          {formatCurrency(item.amount)}
        </div>
      ) : null}
    </li>
  );
}

function LivePulse() {
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
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      <Circle className="size-5 animate-pulse text-muted-foreground motion-reduce:animate-none" />
      <p className="text-sm text-muted-foreground">{label}</p>
    </div>
  );
}
