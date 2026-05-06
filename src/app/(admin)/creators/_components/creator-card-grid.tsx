"use client";

import Link from "next/link";
import {
  Crown,
  Calendar,
  Coins,
  Tag,
  Dices,
  Twitch,
  Youtube,
  Instagram,
  MessageCircle,
  Music2,
  type LucideIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { formatCurrency, formatDate, formatNumber } from "@/lib/utils/format";
import type {
  CreatorListItem,
  CreatorDealStatus,
  CreatorSocialPlatform,
} from "@/lib/backend-api";

import { CreatorRowActions } from "./creator-row-actions";
import type { CreatorSocialSummary } from "../_queries/socials-by-user";

const DEAL_STATUS_STYLE: Record<CreatorDealStatus, string> = {
  scheduled:
    "border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400",
  active:
    "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  completed: "border-muted bg-muted/50 text-muted-foreground",
  terminated:
    "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400",
};

// Platform → icon + brand-ish color. Brand colors are deliberately muted
// (`/15` bg, `/80` text) to fit the admin's neutral palette instead of
// shouting like the real Twitch/YouTube buttons.
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
    // lucide doesn't have a Kick icon; reuse Twitch shape, different color
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

export type CreatorWithSocials = CreatorListItem & {
  socials: CreatorSocialSummary[];
  /** user.affiliate_code — null if the creator doesn't own a code yet. */
  code: string | null;
  /** balances.total_wagered — lifetime wager in USD. */
  totalWagered: number;
};

/**
 * Card-grid for /creators replacing the old wide-table layout. Each
 * creator gets a self-contained card with their identity, current deal
 * progress (if any), live indicator, social handles, and the row-action
 * menu — no horizontal scrolling, no truncated columns.
 *
 * Grid: 1 / 2 / 3 cols depending on viewport so cards stay readable
 * (~340px floor) at every width.
 */
export function CreatorCardGrid({
  creators,
}: {
  creators: CreatorWithSocials[];
}) {
  if (creators.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center rounded-xl border bg-muted/20 text-sm text-muted-foreground">
        No creators found.
      </div>
    );
  }
  return (
    <div className="grid gap-3 grid-cols-1 sm:gap-4 md:grid-cols-2 xl:grid-cols-3">
      {creators.map((creator) => (
        <CreatorCard key={creator.id} creator={creator} />
      ))}
    </div>
  );
}

function CreatorCard({ creator }: { creator: CreatorWithSocials }) {
  const display =
    creator.username ?? creator.email ?? creator.id.slice(0, 8);
  const live = creator.active_session_id !== null;
  const deal = creator.current_deal;
  const initials = display.slice(0, 2).toUpperCase();

  return (
    <div className="group relative overflow-hidden rounded-xl border bg-gradient-to-br from-card via-card to-card/70 p-4 transition-colors hover:border-pink-500/30 sm:p-5">
      {/* corner glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute -right-12 -top-12 size-32 rounded-full bg-pink-500/[0.08] blur-2xl"
      />

      <div className="relative space-y-4">
        {/* IDENTITY ROW */}
        <div className="flex items-start gap-3">
          <Link
            href={`/creators/${creator.id}`}
            className="shrink-0"
            aria-label={`Open ${display}`}
          >
            <Avatar className="size-11 ring-2 ring-background">
              {creator.image && <AvatarImage src={creator.image} alt="" />}
              <AvatarFallback className="bg-pink-500/15 text-xs font-semibold text-pink-700 dark:text-pink-300">
                {initials}
              </AvatarFallback>
            </Avatar>
          </Link>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <Link
                href={`/creators/${creator.id}`}
                className="truncate text-sm font-semibold leading-tight hover:underline sm:text-base"
              >
                {display}
              </Link>
              {live && (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                  <span className="relative flex size-1.5">
                    <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-75" />
                    <span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
                  </span>
                  Live
                </span>
              )}
            </div>
            <p className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-muted-foreground">
              <Calendar className="size-2.5 shrink-0" />
              Since {formatDate(new Date(creator.created_at))}
              <span aria-hidden>·</span>
              <span className="font-mono">
                {formatNumber(creator.total_deals_count)} deals
              </span>
            </p>
          </div>
          <div className="shrink-0">
            <CreatorRowActions
              userId={creator.id}
              hasActiveSession={live}
              hasActiveDeal={
                deal?.status === "active" || deal?.status === "scheduled"
              }
            />
          </div>
        </div>

        {/* DEAL ROW */}
        <DealSummary deal={deal} />

        {/* CODE + LIFETIME WAGER */}
        <CodeAndWagerRow
          code={creator.code}
          totalWagered={creator.totalWagered}
        />

        {/* SOCIALS ROW */}
        <SocialsRow socials={creator.socials} />
      </div>
    </div>
  );
}

// Code + lifetime wager — two compact tiles side by side. Code chip is
// monospaced and tap-to-copy-friendly via title attr; wager number is
// emerald (the user's wager IS the house's gross gaming revenue, so
// from the house POV this is positive — emerald per CLAUDE.md).
function CodeAndWagerRow({
  code,
  totalWagered,
}: {
  code: string | null;
  totalWagered: number;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <div className="rounded-lg border bg-background/50 px-3 py-2">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          <Tag className="size-3" />
          Code
        </div>
        {code ? (
          <p
            className="mt-0.5 truncate font-mono text-sm font-semibold"
            title={code}
          >
            {code}
          </p>
        ) : (
          <p className="mt-0.5 text-sm italic text-muted-foreground">
            none
          </p>
        )}
      </div>
      <div className="rounded-lg border bg-background/50 px-3 py-2">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          <Dices className="size-3" />
          Total Wager
        </div>
        <p
          className="mt-0.5 truncate text-sm font-semibold tabular-nums text-emerald-600 dark:text-emerald-400"
          title={`${totalWagered} USD lifetime`}
        >
          {totalWagered > 0 ? formatCurrency(totalWagered) : "—"}
        </p>
      </div>
    </div>
  );
}

function DealSummary({
  deal,
}: {
  deal: CreatorListItem["current_deal"];
}) {
  if (!deal) {
    return (
      <div className="flex items-center justify-between rounded-lg border border-dashed border-border/60 bg-muted/20 px-3 py-2">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Coins className="size-3.5" />
          <span>No active deal</span>
        </div>
      </div>
    );
  }

  const fillsPct =
    deal.fills_allowed > 0
      ? Math.min(100, (deal.fills_used / deal.fills_allowed) * 100)
      : 0;
  const perFill = parseFloat(deal.per_fill_amount_usd) || 0;
  const totalCap = perFill * deal.fills_allowed;
  const totalUsed = perFill * deal.fills_used;

  return (
    <div className="space-y-2 rounded-lg border bg-background/50 px-3 py-2.5">
      {/* Header line: status + week range + total cap */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Badge
          variant="outline"
          className={cn("h-5 px-1.5 text-[10px]", DEAL_STATUS_STYLE[deal.status])}
        >
          {deal.status}
        </Badge>
        <span className="text-[11px] text-muted-foreground">
          {formatDate(new Date(deal.week_start_utc))} →{" "}
          {formatDate(new Date(deal.week_end_utc))}
        </span>
        <span className="ml-auto text-xs font-mono font-medium tabular-nums">
          ${totalUsed.toFixed(0)} / ${totalCap.toFixed(0)}
        </span>
      </div>
      {/* Progress: fills bar */}
      <div className="space-y-1">
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-pink-500 transition-all"
            style={{ width: `${fillsPct}%` }}
          />
        </div>
        <p className="text-[10px] text-muted-foreground">
          <span className="font-mono">
            {deal.fills_used}/{deal.fills_allowed}
          </span>{" "}
          fills used · ${perFill.toFixed(0)} per fill
        </p>
      </div>
    </div>
  );
}

function SocialsRow({ socials }: { socials: CreatorSocialSummary[] }) {
  if (socials.length === 0) {
    return (
      <p className="text-[11px] italic text-muted-foreground">
        No verified socials yet
      </p>
    );
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {socials.map((s) => {
        const meta = PLATFORM_META[s.platform];
        const Icon = meta.icon;
        const label = `${meta.label} · @${s.username}`;
        const inner = (
          <>
            <Icon className="size-3" />
            <span className="truncate max-w-[120px]">{s.username}</span>
          </>
        );
        return s.url ? (
          <a
            key={s.id}
            href={s.url}
            target="_blank"
            rel="noreferrer"
            title={label}
            className={cn(
              "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium transition-opacity hover:opacity-80",
              meta.color,
            )}
          >
            {inner}
          </a>
        ) : (
          <span
            key={s.id}
            title={label}
            className={cn(
              "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium",
              meta.color,
            )}
          >
            {inner}
          </span>
        );
      })}
    </div>
  );
}

// Re-export Crown for the old fallback if anyone imports from this file
export { Crown };
