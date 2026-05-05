"use client";

import * as React from "react";
import { Gift, Package, Swords, Sparkles } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  usePackyWsLivePulls,
  usePackyWsStatus,
  type Pull,
  type ConnectionStatus,
} from "@/lib/packy-ws";
import { formatCurrency, formatRelative } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

const MAX_PULLS = 50;

// Rarity → accent color. The packy.gg catalog uses a handful of canonical
// rarity labels; we normalize to lowercase and fall back to "common"
// styling for anything unknown so a new rarity tier doesn't blow up the UI.
// House-POV: the rarer the card, the more it hurts the house when a user
// hits it — so high-tier cards lean rose while bulk commons are muted.
type RarityClass = "mythic" | "legendary" | "secret" | "ultra" | "rare" | "uncommon" | "common";

const RARITY_STYLES: Record<RarityClass, {
  chip: string;
  border: string;
  glow: string;
  rose: boolean;
}> = {
  mythic: {
    chip: "bg-rose-500/15 text-rose-500 dark:text-rose-400 ring-1 ring-rose-500/40",
    border: "border-rose-500/40",
    glow: "shadow-[0_0_20px_-8px_rgba(244,63,94,0.7)]",
    rose: true,
  },
  legendary: {
    chip: "bg-rose-500/15 text-rose-500 dark:text-rose-400 ring-1 ring-rose-500/30",
    border: "border-rose-500/30",
    glow: "shadow-[0_0_16px_-8px_rgba(244,63,94,0.55)]",
    rose: true,
  },
  secret: {
    chip: "bg-purple-500/15 text-purple-500 dark:text-purple-400 ring-1 ring-purple-500/30",
    border: "border-purple-500/30",
    glow: "shadow-[0_0_16px_-8px_rgba(168,85,247,0.55)]",
    rose: true,
  },
  ultra: {
    chip: "bg-amber-500/15 text-amber-600 dark:text-amber-400 ring-1 ring-amber-500/30",
    border: "border-amber-500/30",
    glow: "shadow-[0_0_16px_-8px_rgba(245,158,11,0.55)]",
    rose: true,
  },
  rare: {
    chip: "bg-blue-500/15 text-blue-600 dark:text-blue-400 ring-1 ring-blue-500/30",
    border: "border-blue-500/25",
    glow: "shadow-[0_0_14px_-8px_rgba(59,130,246,0.45)]",
    rose: true,
  },
  uncommon: {
    chip: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 ring-1 ring-emerald-500/30",
    border: "border-border/60",
    glow: "",
    rose: false,
  },
  common: {
    chip: "bg-muted text-muted-foreground ring-1 ring-border/60",
    border: "border-border/60",
    glow: "",
    rose: false,
  },
};

function classifyRarity(raw: string | null | undefined): RarityClass {
  if (!raw) return "common";
  const r = raw.toLowerCase();
  if (r.includes("mythic")) return "mythic";
  if (r.includes("legendary")) return "legendary";
  if (r.includes("secret")) return "secret";
  if (r.includes("ultra")) return "ultra";
  if (r.includes("rare")) return "rare";
  if (r.includes("uncommon")) return "uncommon";
  return "common";
}

const SOURCE_META: Record<
  Pull["card"]["source"],
  { icon: LucideIcon; label: string; tint: string }
> = {
  pack: {
    icon: Package,
    label: "Pack",
    tint: "text-blue-500",
  },
  battle: {
    icon: Swords,
    label: "Battle",
    tint: "text-emerald-500",
  },
  reward: {
    icon: Gift,
    label: "Reward",
    tint: "text-purple-500",
  },
};

function parsePrice(raw: string): number {
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Live Pulls feed — subscribes to the `live.pull.history` event from
 * the packy.gg WS and renders a scrolling card-pull timeline. New rows
 * fade + slide in from the top (same animation vocab as RecentActivity)
 * and rare hits get a subtle colored border + glow so they stand out in
 * a busy stream.
 *
 * Empty state shows a pulsing dot + "Waiting for live pulls…" copy —
 * matches the visual vocabulary of the existing dashboard live feed.
 */
export function LivePulls() {
  const pulls = usePackyWsLivePulls(MAX_PULLS);
  const status = usePackyWsStatus();
  // Trigger a re-render every 30s so the "formatRelative" labels don't
  // go stale. Same cadence RecentActivity uses.
  const [, setNow] = React.useState(0);
  React.useEffect(() => {
    const id = setInterval(() => setNow((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  // Track the set of newly-arrived ids for a short window so we can
  // animate them in. Keyed the same way the hook dedupes.
  const [newKeys, setNewKeys] = React.useState<Set<string>>(() => new Set());
  const prevKeysRef = React.useRef<Set<string>>(new Set());
  React.useEffect(() => {
    const current = new Set(pulls.map((p) => `${p.card.id}|${p.timestamp}`));
    const fresh: string[] = [];
    for (const k of current) {
      if (!prevKeysRef.current.has(k)) fresh.push(k);
    }
    prevKeysRef.current = current;
    if (fresh.length === 0) return;
    setNewKeys((old) => {
      const next = new Set(old);
      for (const k of fresh) next.add(k);
      return next;
    });
    const timer = setTimeout(() => {
      setNewKeys((old) => {
        if (old.size === 0) return old;
        const next = new Set(old);
        for (const k of fresh) next.delete(k);
        return next;
      });
    }, 600);
    return () => clearTimeout(timer);
  }, [pulls]);

  return (
    <div className="relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-card/80">
      <div
        aria-hidden
        className="pointer-events-none absolute -right-24 -top-24 size-60 rounded-full bg-purple-500/10 blur-3xl"
      />
      <div className="relative flex items-center justify-between gap-2 border-b border-border/60 px-3 py-3 sm:px-5">
        <div className="flex min-w-0 items-center gap-2">
          <div className="shrink-0 rounded-md bg-primary/10 p-1.5">
            <Sparkles className="size-4 text-primary" />
          </div>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold leading-none">
              Live Pulls
            </h3>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
              Newest card pulls across packs, battles &amp; rewards
            </p>
          </div>
        </div>
        <StatusChip status={status} />
      </div>
      <div className="relative max-h-[40rem] overflow-y-auto">
        {pulls.length === 0 ? (
          <EmptyState />
        ) : (
          <ul className="divide-y divide-border/60">
            {pulls.map((p) => {
              const key = `${p.card.id}|${p.timestamp}`;
              return (
                <PullRow
                  key={key}
                  pull={p}
                  isNew={newKeys.has(key)}
                />
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function PullRow({ pull: p, isNew }: { pull: Pull; isNew: boolean }) {
  const rarity = classifyRarity(p.card.rarity);
  const style = RARITY_STYLES[rarity];
  const source = SOURCE_META[p.card.source] ?? SOURCE_META.pack;
  const SourceIcon = source.icon;
  const price = parsePrice(p.card.price);

  return (
    <li
      className={cn(
        "flex items-center gap-3 px-3 py-3 transition-colors hover:bg-muted/30 sm:px-5",
        isNew &&
          "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-2 motion-safe:duration-300 motion-reduce:animate-in motion-reduce:fade-in motion-reduce:duration-200",
      )}
    >
      {/* Card thumbnail — rare cards get an accent border + glow. Falls
          back to a muted square with the source icon when the image
          isn't available (or while it's still loading). */}
      <div
        className={cn(
          "relative flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-muted",
          style.border,
          style.glow,
        )}
      >
        {p.card.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={p.card.image_url}
            alt={p.card.name}
            className="size-full object-cover"
            referrerPolicy="no-referrer"
            loading="lazy"
          />
        ) : (
          <SourceIcon className="size-5 text-muted-foreground" />
        )}
      </div>

      {/* Card name + metadata. Name is the dominant line; rarity chip
          + pack name + time sit underneath as secondary metadata. The
          metadata row uses `flex-wrap` so a long pack name doesn't
          collide with the relative-time label on phones. */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold text-foreground">
            {p.card.name}
          </span>
          <span
            className={cn(
              "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
              style.chip,
            )}
          >
            {p.card.rarity || "common"}
          </span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <SourceIcon className={cn("size-3 shrink-0", source.tint)} />
            {source.label}
          </span>
          <span className="text-muted-foreground/50">·</span>
          <span className="min-w-0 truncate">{p.card.pack_name}</span>
          <span className="text-muted-foreground/50">·</span>
          <span className="shrink-0">{formatRelative(p.timestamp)}</span>
        </div>
      </div>

      {/* Price chip — neutral styling. A pull is a display event, not
          a ledger event. The actual wager was already booked when the
          user paid to open the pack / enter the battle, and any payout
          lands as a separate transaction in the ledger feed. Coloring
          this chip red/green would double-count the same money.
          Muted for $0 items, same muted tone (slightly stronger) for
          priced items — no directional signal. */}
      <div
        className={cn(
          "shrink-0 rounded-lg px-2.5 py-1 text-right text-sm font-bold tabular-nums",
          price > 0
            ? "bg-muted/70 text-foreground ring-1 ring-border"
            : "bg-muted text-muted-foreground/60",
        )}
      >
        {price > 0 ? formatCurrency(price) : "—"}
      </div>
    </li>
  );
}

function StatusChip({ status }: { status: ConnectionStatus }) {
  const meta = (() => {
    switch (status) {
      case "open":
        return {
          label: "Live",
          dot: "bg-emerald-500",
          text: "text-emerald-600 dark:text-emerald-400",
          border: "border-emerald-500/30 bg-emerald-500/10",
          animate: true,
        };
      case "connecting":
        return {
          label: "Connecting",
          dot: "bg-amber-500",
          text: "text-amber-600 dark:text-amber-400",
          border: "border-amber-500/30 bg-amber-500/10",
          animate: true,
        };
      case "reconnecting":
        return {
          label: "Reconnecting",
          dot: "bg-amber-500",
          text: "text-amber-600 dark:text-amber-400",
          border: "border-amber-500/30 bg-amber-500/10",
          animate: true,
        };
      case "closed":
        return {
          label: "Offline",
          dot: "bg-zinc-500",
          text: "text-zinc-600 dark:text-zinc-400",
          border: "border-zinc-500/30 bg-zinc-500/10",
          animate: false,
        };
    }
  })();

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
        meta.border,
        meta.text,
      )}
      aria-label={`WebSocket ${meta.label}`}
    >
      <span className="relative flex size-1.5">
        {meta.animate && (
          <span
            aria-hidden
            className={cn(
              "absolute inline-flex size-full animate-ping rounded-full opacity-75 motion-reduce:hidden",
              meta.dot,
            )}
          />
        )}
        <span
          className={cn("relative inline-flex size-1.5 rounded-full", meta.dot)}
        />
      </span>
      {meta.label}
    </span>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-20 text-center">
      <div className="relative flex size-3">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/40 opacity-75 motion-reduce:hidden" />
        <span className="relative inline-flex size-3 rounded-full bg-primary/60" />
      </div>
      <p className="text-sm text-muted-foreground">Waiting for live pulls…</p>
    </div>
  );
}
