"use client";

import { useMemo } from "react";
import Link from "next/link";
import {
  Coins,
  MessageCircle,
  Music2,
  Instagram,
  Twitch,
  Users2,
  UserPlus,
  Wallet,
  Youtube,
  type LucideIcon,
} from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatCompactUsd, formatNumber } from "@/lib/utils/format";
import type { CreatorSocialPlatform } from "@/lib/backend-api";

import type { RosterCreator } from "../_queries/list-roster-creators";
import { useRosterSearch, matchesRosterSearch } from "./roster-search-context";
import { useRosterView } from "./roster-view-context";

/**
 * Creator Hub roster — card grid + compact table renderer.
 *
 * Receives the fully enriched + server-sorted rows, applies the instant
 * client-side search filter, then renders either a card grid (default) or a
 * compact list — both link each creator into `/creator-hub/creators/[id]`.
 *
 * House-POV colors (CLAUDE.md):
 *   • cohort WAGER  → house gain → emerald
 *   • GGR / PnL     → emerald when the house is up, rose when down
 *   • DEAL VALUE    → a house cost ceiling → rose
 *   • counts (signups / FTDs) → neutral foreground
 *
 * Server-safe inputs: `creators` is plain data (no function props). The
 * search + view come from client contexts this component consumes.
 */

const PLATFORM_META: Record<
  CreatorSocialPlatform,
  { icon: LucideIcon; color: string; label: string }
> = {
  twitch: {
    icon: Twitch,
    color: "bg-purple-500/15 text-purple-600 dark:text-purple-400",
    label: "Twitch",
  },
  youtube: {
    icon: Youtube,
    color: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
    label: "YouTube",
  },
  kick: {
    icon: Twitch,
    color: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
    label: "Kick",
  },
  x: {
    icon: MessageCircle,
    color: "bg-zinc-500/15 text-zinc-700 dark:text-zinc-300",
    label: "X",
  },
  instagram: {
    icon: Instagram,
    color: "bg-pink-500/15 text-pink-600 dark:text-pink-400",
    label: "Instagram",
  },
  tiktok: {
    icon: Music2,
    color: "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400",
    label: "TikTok",
  },
  discord: {
    icon: MessageCircle,
    color: "bg-indigo-500/15 text-indigo-600 dark:text-indigo-400",
    label: "Discord",
  },
};

function initials(name: string | null): string {
  const clean = (name ?? "").trim();
  if (!clean) return "?";
  return clean.slice(0, 2).toUpperCase();
}

/** Signed house-POV color for a GGR / PnL figure (emerald up, rose down). */
function signedHouseClass(value: number | null): string {
  if (value == null || value === 0) return "text-muted-foreground";
  return value > 0
    ? "text-emerald-600 dark:text-emerald-400"
    : "text-rose-600 dark:text-rose-400";
}

function CreatorHref(id: string): string {
  return `/creator-hub/creators/${id}`;
}

export function RosterGrid({ creators }: { creators: RosterCreator[] }) {
  const { query } = useRosterSearch();
  const { view } = useRosterView();

  const filtered = useMemo(
    () => creators.filter((c) => matchesRosterSearch(c, query)),
    [creators, query],
  );

  if (creators.length === 0) {
    return (
      <EmptyState
        title="No creators yet"
        body="Once you add creators they'll appear here as a searchable roster."
      />
    );
  }

  if (filtered.length === 0) {
    return (
      <EmptyState
        title="No creators match your search"
        body="Try a different username, email, or affiliate code."
      />
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-[11px] text-muted-foreground">
        {filtered.length === creators.length
          ? `${creators.length} creator${creators.length === 1 ? "" : "s"}`
          : `${filtered.length} of ${creators.length} creators`}
      </p>
      {view === "grid" ? (
        <div className="grid grid-cols-1 gap-3 sm:gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((c) => (
            <RosterCard key={c.id} creator={c} />
          ))}
        </div>
      ) : (
        <RosterTable creators={filtered} />
      )}
    </div>
  );
}

// ─── Card ──────────────────────────────────────────────────────────

function RosterCard({ creator: c }: { creator: RosterCreator }) {
  return (
    <Link
      href={CreatorHref(c.id)}
      className={cn(
        "group relative flex flex-col gap-3 overflow-hidden rounded-2xl border bg-card p-4 outline-none transition-colors",
        "hover:border-border/80 hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      {/* Identity row */}
      <div className="flex items-start gap-3">
        <Avatar className="size-11 shrink-0">
          {c.image && <AvatarImage src={c.image} alt="" />}
          <AvatarFallback className="bg-pink-500/15 text-sm font-semibold text-pink-700 dark:text-pink-300">
            {initials(c.username)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold">
              {c.username ?? "Unknown"}
            </span>
            {c.isLive && <LiveBadge />}
          </div>
          {c.code ? (
            <span className="mt-0.5 inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
              {c.code}
            </span>
          ) : (
            <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
              No code yet
            </span>
          )}
        </div>
        <DealStatusBadge status={c.dealStatus} />
      </div>

      {/* Socials */}
      {c.socials.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {c.socials.map((s) => {
            const meta = PLATFORM_META[s.platform];
            const Icon = meta?.icon ?? MessageCircle;
            return (
              <span
                key={s.id}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium",
                  meta?.color ?? "bg-muted text-muted-foreground",
                )}
                title={`${meta?.label ?? s.platform}: ${s.username}`}
              >
                <Icon className="size-3" />
                <span className="max-w-[90px] truncate">{s.username}</span>
              </span>
            );
          })}
        </div>
      )}

      {/* Stat grid */}
      <div className="grid grid-cols-2 gap-2">
        <StatCell
          icon={UserPlus}
          label="Sign-ups"
          value={formatNumber(c.signups)}
        />
        <StatCell
          icon={Wallet}
          label="FTDs"
          value={formatNumber(c.ftds)}
        />
        <StatCell
          icon={Coins}
          label="Wager"
          value={formatCompactUsd(c.windowedWagerUsd)}
          // Cohort wager = house gain → emerald.
          valueClass="text-emerald-600 dark:text-emerald-400"
        />
        <StatCell
          icon={Users2}
          label="GGR"
          value={c.windowedGgrUsd != null ? formatCompactUsd(c.windowedGgrUsd) : "—"}
          valueClass={signedHouseClass(c.windowedGgrUsd)}
        />
      </div>

      {/* Footer: lifetime PnL + deal value */}
      <div className="mt-auto flex items-center justify-between gap-2 border-t pt-2.5 text-[11px]">
        <span className="flex items-center gap-1 text-muted-foreground">
          PnL
          <span className={cn("font-semibold tabular-nums", signedHouseClass(c.lifetimePnlUsd))}>
            {c.lifetimePnlUsd != null ? formatCompactUsd(c.lifetimePnlUsd) : "—"}
          </span>
        </span>
        <span className="flex items-center gap-1 text-muted-foreground">
          Deal
          <span className="font-semibold tabular-nums text-rose-600 dark:text-rose-400">
            {c.dealValue ? formatCompactUsd(c.dealValue.dealValueUsd) : "—"}
          </span>
        </span>
      </div>
    </Link>
  );
}

function StatCell({
  icon: Icon,
  label,
  value,
  valueClass,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="rounded-lg border bg-background/40 px-2.5 py-1.5">
      <div className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        <Icon className="size-3" />
        {label}
      </div>
      <p className={cn("mt-0.5 text-sm font-bold tabular-nums", valueClass)}>
        {value}
      </p>
    </div>
  );
}

// ─── Table ─────────────────────────────────────────────────────────

function RosterTable({ creators }: { creators: RosterCreator[] }) {
  return (
    <div className="overflow-x-auto rounded-2xl border">
      <table className="w-full min-w-[760px] text-sm">
        <thead>
          <tr className="border-b bg-muted/40 text-left text-[11px] uppercase tracking-wider text-muted-foreground">
            <th className="px-3 py-2 font-semibold">Creator</th>
            <th className="px-3 py-2 font-semibold">Code</th>
            <th className="px-3 py-2 text-right font-semibold">Sign-ups</th>
            <th className="px-3 py-2 text-right font-semibold">FTDs</th>
            <th className="px-3 py-2 text-right font-semibold">Wager</th>
            <th className="px-3 py-2 text-right font-semibold">GGR</th>
            <th className="px-3 py-2 text-right font-semibold">PnL</th>
            <th className="px-3 py-2 text-right font-semibold">Deal</th>
          </tr>
        </thead>
        <tbody>
          {creators.map((c) => (
            <tr
              key={c.id}
              className="border-b last:border-0 transition-colors hover:bg-accent/30"
            >
              <td className="px-3 py-2">
                <Link
                  href={CreatorHref(c.id)}
                  className="flex items-center gap-2.5 outline-none focus-visible:underline"
                >
                  <Avatar className="size-7 shrink-0">
                    {c.image && <AvatarImage src={c.image} alt="" />}
                    <AvatarFallback className="bg-pink-500/15 text-[10px] font-semibold text-pink-700 dark:text-pink-300">
                      {initials(c.username)}
                    </AvatarFallback>
                  </Avatar>
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate font-medium">
                      {c.username ?? "Unknown"}
                    </span>
                    {c.isLive && <LiveDot />}
                  </span>
                </Link>
              </td>
              <td className="px-3 py-2">
                {c.code ? (
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {c.code}
                  </span>
                ) : (
                  <span className="text-[11px] text-muted-foreground/60">—</span>
                )}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {formatNumber(c.signups)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {formatNumber(c.ftds)}
              </td>
              {/* Cohort wager = house gain → emerald. */}
              <td className="px-3 py-2 text-right font-medium tabular-nums text-emerald-600 dark:text-emerald-400">
                {formatCompactUsd(c.windowedWagerUsd)}
              </td>
              <td
                className={cn(
                  "px-3 py-2 text-right font-medium tabular-nums",
                  signedHouseClass(c.windowedGgrUsd),
                )}
              >
                {c.windowedGgrUsd != null ? formatCompactUsd(c.windowedGgrUsd) : "—"}
              </td>
              <td
                className={cn(
                  "px-3 py-2 text-right font-medium tabular-nums",
                  signedHouseClass(c.lifetimePnlUsd),
                )}
              >
                {c.lifetimePnlUsd != null ? formatCompactUsd(c.lifetimePnlUsd) : "—"}
              </td>
              {/* Deal value = house cost ceiling → rose. */}
              <td className="px-3 py-2 text-right font-medium tabular-nums text-rose-600 dark:text-rose-400">
                {c.dealValue ? formatCompactUsd(c.dealValue.dealValueUsd) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Bits ──────────────────────────────────────────────────────────

function DealStatusBadge({ status }: { status: RosterCreator["dealStatus"] }) {
  if (status == null) return null;
  const map: Record<string, string> = {
    active:
      "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    scheduled:
      "border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400",
    completed: "border-muted bg-muted/50 text-muted-foreground",
    terminated:
      "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400",
  };
  return (
    <Badge
      variant="outline"
      className={cn("shrink-0 capitalize", map[status] ?? "")}
    >
      {status}
    </Badge>
  );
}

function LiveBadge() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
      <LiveDot />
      LIVE
    </span>
  );
}

function LiveDot() {
  return (
    <span
      aria-hidden
      className="inline-block size-2 shrink-0 rounded-full bg-emerald-500 shadow-[0_0_0_3px_rgba(52,211,153,0.25)] motion-safe:animate-pulse"
    />
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex min-h-[220px] flex-col items-center justify-center gap-2 rounded-2xl border border-dashed py-12 text-center">
      <Users2 className="size-6 text-muted-foreground/60" />
      <p className="text-sm font-semibold">{title}</p>
      <p className="max-w-xs text-xs text-muted-foreground">{body}</p>
    </div>
  );
}
