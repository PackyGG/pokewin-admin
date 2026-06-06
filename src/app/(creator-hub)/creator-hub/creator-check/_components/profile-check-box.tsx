"use client";

import { useState } from "react";
import {
  BadgeCheck,
  ExternalLink,
  MessageCircle,
  Radio,
  Tv,
  Twitter,
  Users,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatNumber, formatRelative } from "@/lib/utils/format";

import { CheckDetailModal } from "./check-detail-modal";
import { compactCount } from "./compact";
import type { CheckSummary } from "../_queries/check-history";

/**
 * One profile box on the Creator Check history grid — a saved Kick or Twitter
 * profile we've checked. Summary view (avatar, name, followers, key badges);
 * clicking it opens the lazy detail modal (streams / tweets + mentions).
 *
 * House style: card with platform accent, dark-mode native. The Twitter
 * 7-day mention count (people talking about US) is a neutral/blue info signal,
 * never a money color.
 */
export function ProfileCheckBox({ summary }: { summary: CheckSummary }) {
  const [open, setOpen] = useState(false);

  const isKick = summary.platform === "kick";
  const Icon = isKick ? Tv : Twitter;
  const accent = isKick
    ? "border-emerald-500/20 bg-emerald-500/[0.04]"
    : "border-sky-500/20 bg-sky-500/[0.04]";
  const chip = isKick
    ? "bg-emerald-500/15 text-emerald-600 ring-emerald-500/30 dark:text-emerald-400"
    : "bg-sky-500/15 text-sky-600 ring-sky-500/30 dark:text-sky-400";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "hover-raise group surface-sheen relative w-full overflow-hidden rounded-xl border p-3 text-left transition-colors sm:p-4",
          accent,
          "hover:border-foreground/20",
        )}
        aria-label={`Open ${summary.handle} (${summary.platform}) details`}
      >
        {/* Header: avatar + identity + platform chip */}
        <div className="flex items-start gap-3">
          <BoxAvatar avatarUrl={summary.avatarUrl} handle={summary.handle} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm font-semibold">
                {summary.displayName || summary.handle}
              </span>
              {summary.isVerified && (
                <BadgeCheck
                  className="size-3.5 shrink-0 text-sky-500"
                  aria-label="Verified"
                />
              )}
              {isKick && summary.isLive && (
                <Badge
                  variant="outline"
                  className="h-4 gap-1 border-rose-500/40 px-1.5 text-[10px] font-medium text-rose-600 dark:text-rose-400"
                >
                  <span className="size-1.5 animate-pulse rounded-full bg-rose-500" />
                  LIVE
                </Badge>
              )}
            </div>
            <p className="truncate text-xs text-muted-foreground">
              @{summary.handle}
            </p>
          </div>
          <span
            className={cn(
              "flex size-7 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset",
              chip,
            )}
          >
            <Icon className="size-3.5" />
          </span>
        </div>

        {/* Bio (one line) */}
        {summary.bio && (
          <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">
            {summary.bio}
          </p>
        )}

        {/* Stat row */}
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Users className="size-3" />
            <span className="font-medium tabular-nums text-foreground">
              {summary.followerCount != null
                ? compactCount(summary.followerCount)
                : "—"}
            </span>
            followers
          </span>

          {isKick ? (
            <span className="inline-flex items-center gap-1">
              <Radio className="size-3" />
              <span className="font-medium tabular-nums text-foreground">
                {formatNumber(summary.streamCount)}
              </span>
              streams
            </span>
          ) : (
            <span className="inline-flex items-center gap-1">
              <MessageCircle className="size-3" />
              <span
                className={cn(
                  "font-medium tabular-nums",
                  summary.mentionCount7d > 0
                    ? "text-blue-600 dark:text-blue-400"
                    : "text-foreground",
                )}
              >
                {formatNumber(summary.mentionCount7d)}
              </span>
              mentions · 7d
            </span>
          )}
        </div>

        {/* Footer: last checked + open hint */}
        <div className="mt-2 flex items-center justify-between gap-2 border-t border-border/60 pt-2">
          <span className="truncate text-[10px] text-muted-foreground">
            {summary.lastFetchedAt
              ? `Checked ${formatRelative(summary.lastFetchedAt)}`
              : "Never checked"}
          </span>
          <span className="inline-flex items-center gap-1 text-[10px] font-medium text-muted-foreground group-hover:text-foreground">
            Details
            <ExternalLink className="size-3" />
          </span>
        </div>
      </button>

      <CheckDetailModal
        platform={summary.platform}
        handle={summary.handle}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}

/**
 * Box avatar — external platform CDN image via plain <img> (Kick/Twitter CDNs
 * aren't in next.config remotePatterns, which we must not edit here). Monogram
 * fallback on missing/broken image.
 */
function BoxAvatar({
  avatarUrl,
  handle,
}: {
  avatarUrl: string | null;
  handle: string;
}) {
  const [failed, setFailed] = useState(false);
  const letter = handle.charAt(0).toUpperCase() || "?";
  if (!avatarUrl || failed) {
    return (
      <span className="flex size-10 shrink-0 items-center justify-center rounded-full border bg-muted text-sm font-semibold text-muted-foreground">
        {letter}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={avatarUrl}
      alt={`${handle} avatar`}
      width={40}
      height={40}
      loading="lazy"
      onError={() => setFailed(true)}
      className="size-10 shrink-0 rounded-full border object-cover"
    />
  );
}
