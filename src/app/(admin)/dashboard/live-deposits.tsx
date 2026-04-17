"use client";

import * as React from "react";
import Link from "next/link";
import { Wallet, Circle } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { AnimatedNumber } from "@/components/animated-number";
import { formatCurrency, formatRelative } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import type { LiveDepositItem } from "@/lib/queries/dashboard-live";
import { fetchRecentDepositsLive } from "./live-actions";

const MAX_ITEMS = 20;
const POLL_INTERVAL_MS = 3000;

export function LiveDeposits({
  initial,
  initialTotal24h,
}: {
  initial: LiveDepositItem[];
  initialTotal24h: number;
}) {
  const [items, setItems] = React.useState<LiveDepositItem[]>(() =>
    initial.slice(0, MAX_ITEMS),
  );
  const [total24h, setTotal24h] = React.useState<number>(initialTotal24h);
  // The id set is used to flag newly-arrived rows for the slide-in animation.
  // Initial rows are rendered statically — only rows that appear after mount
  // get the entry animation so the first paint doesn't flash.
  const [newIds, setNewIds] = React.useState<Set<string>>(() => new Set());
  const cursorRef = React.useRef<string | null>(
    initial.length > 0 ? initial[0].createdAt : null,
  );
  // Re-render every 30s so relative timestamps ("12s ago") stay fresh even
  // when no new items arrive.
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
        const res = await fetchRecentDepositsLive(cursorRef.current);
        if (!alive) return;
        setTotal24h(res.total24h);
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
      <div
        aria-hidden
        className="pointer-events-none absolute -right-12 -top-12 size-40 rounded-full bg-emerald-500/10 blur-3xl"
      />
      <div className="relative flex flex-col p-5">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="flex size-7 items-center justify-center rounded-lg bg-emerald-500/10">
              <Wallet className="size-3.5 text-emerald-500" />
            </div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Live Deposits
            </h3>
          </div>
          <LivePulse />
        </div>

        <div className="mb-1">
          <AnimatedNumber
            value={total24h}
            format="currency"
            className="text-3xl font-bold text-emerald-600 dark:text-emerald-400"
          />
        </div>
        <p className="mb-4 text-xs text-muted-foreground">Last 24h deposited</p>

        <div className="max-h-[32rem] overflow-y-auto -mx-5 px-5">
          {items.length === 0 ? (
            <EmptyState label="Waiting for deposits..." />
          ) : (
            <ul className="divide-y divide-border/60">
              {items.map((item) => (
                <DepositRow
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

function DepositRow({
  item,
  isNew,
}: {
  item: LiveDepositItem;
  isNew: boolean;
}) {
  const fallback = (item.username ?? "?").slice(0, 2).toUpperCase();
  return (
    <li
      className={cn(
        "group flex items-center gap-3 py-3",
        isNew &&
          "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-2 motion-safe:duration-300 motion-reduce:animate-in motion-reduce:fade-in motion-reduce:duration-200",
      )}
    >
      <Avatar className="size-9 shrink-0">
        {item.image ? (
          <AvatarImage src={item.image} alt={item.username} />
        ) : null}
        <AvatarFallback>{fallback}</AvatarFallback>
      </Avatar>
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
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {formatRelative(item.createdAt)}
          {item.bonusAmount != null && item.bonusAmount > 0 ? (
            <span className="ml-1 text-emerald-600/80 dark:text-emerald-400/80">
              +{formatCurrency(item.bonusAmount)} bonus
            </span>
          ) : null}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <div className="text-base font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
          +{formatCurrency(item.amount)}
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

function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      <Circle className="size-5 animate-pulse text-muted-foreground motion-reduce:animate-none" />
      <p className="text-sm text-muted-foreground">{label}</p>
    </div>
  );
}
