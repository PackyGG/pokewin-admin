"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  BadgeCheck,
  Clock,
  ExternalLink,
  Eye,
  Heart,
  MessageCircle,
  Radio,
  RefreshCw,
  Repeat2,
  Tv,
  Twitter,
} from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ux";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatNumber, formatRelative, formatDateTime } from "@/lib/utils/format";

import { getCheckDetail, refetchCheck, type CheckDetailResult } from "../actions";
import type {
  KickCheckDetail,
  TwitterCheckDetail,
} from "../_queries/check-history";
import { compactCount } from "./compact";

/**
 * Per-profile detail modal for the Creator Check tool.
 *
 * Opened from a profile box. LAZY: the full detail (streams / tweets +
 * mentions) is fetched only when the modal opens, via the `getCheckDetail`
 * action (DB-served — no external API hit on open). A manual Refetch button
 * forces ONE fresh pull through the throttled barrel and updates in place.
 *
 * House style: cards + house tokens, dark-mode native. Twitter mention count
 * (people talking about US) is neutral/blue — it's an info signal, not money.
 */
export function CheckDetailModal({
  platform,
  handle,
  open,
  onOpenChange,
}: {
  platform: "kick" | "twitter";
  handle: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kickDetail, setKickDetail] = useState<KickCheckDetail | null>(null);
  const [twitterDetail, setTwitterDetail] =
    useState<TwitterCheckDetail | null>(null);
  const [refetching, startRefetch] = useTransition();

  function applyResult(res: CheckDetailResult) {
    if (!res.success) {
      setError(res.error);
      return;
    }
    setError(null);
    if (res.platform === "kick") {
      setKickDetail(res.detail);
      setTwitterDetail(null);
    } else {
      setTwitterDetail(res.detail);
      setKickDetail(null);
    }
  }

  // Lazy-load on open (once per open). Reset state on close so re-opening a
  // different box never flashes stale data.
  useEffect(() => {
    if (!open) {
      setError(null);
      setKickDetail(null);
      setTwitterDetail(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    getCheckDetail(platform, handle)
      .then((res) => {
        if (cancelled) return;
        applyResult(res);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load detail.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, platform, handle]);

  function handleRefetch() {
    startRefetch(async () => {
      try {
        const res = await refetchCheck(platform, handle);
        if (!res.success) {
          toast.error(res.error);
          return;
        }
        applyResult(res);
        toast.success("Refreshed from the API.");
        router.refresh();
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Failed to refresh.",
        );
      }
    });
  }

  const isKick = platform === "kick";
  const Icon = isKick ? Tv : Twitter;
  const accentChip = isKick
    ? "bg-emerald-500/15 text-emerald-600 ring-emerald-500/30 dark:text-emerald-400"
    : "bg-sky-500/15 text-sky-600 ring-sky-500/30 dark:text-sky-400";
  const profileUrl = isKick
    ? `https://kick.com/${handle}`
    : `https://x.com/${handle}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span
              className={cn(
                "flex size-7 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset",
                accentChip,
              )}
            >
              <Icon className="size-4" />
            </span>
            <span className="truncate">@{handle}</span>
            <a
              href={profileUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-auto inline-flex items-center gap-1 text-xs font-normal text-muted-foreground hover:text-foreground"
            >
              {isKick ? "kick.com" : "x.com"}
              <ExternalLink className="size-3" />
            </a>
          </DialogTitle>
          <DialogDescription>
            {isKick
              ? "Cached Kick profile + latest streams."
              : "Cached Twitter profile, latest tweets, and 7-day mentions of us."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {loading ? (
            <DetailSkeleton />
          ) : error ? (
            <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-3 text-sm text-rose-600 dark:text-rose-400">
              {error}
            </div>
          ) : isKick ? (
            <KickDetailBody detail={kickDetail} />
          ) : (
            <TwitterDetailBody detail={twitterDetail} />
          )}
        </div>

        {/* Refetch — explicit, throttled, manual only (no auto refresh). */}
        <div className="flex items-center justify-between gap-2 border-t pt-3">
          <span className="text-[11px] text-muted-foreground">
            Served from our database · refresh only on demand.
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleRefetch}
            disabled={refetching || loading}
            className="gap-1.5"
          >
            {refetching ? (
              <Spinner size={13} />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            Refetch
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Kick body ──────────────────────────────────────────────────────────────

function KickDetailBody({ detail }: { detail: KickCheckDetail | null }) {
  if (!detail) {
    return <EmptyState platform="kick" />;
  }
  const { summary, streams } = detail;
  return (
    <div className="space-y-4">
      <ProfileHeader
        avatarUrl={summary.avatarUrl}
        displayName={summary.displayName}
        handle={summary.handle}
        isVerified={summary.isVerified}
        bio={summary.bio}
        live={summary.isLive}
      />

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <StatChip
          label="Followers"
          value={
            summary.followerCount != null
              ? formatNumber(summary.followerCount)
              : "—"
          }
        />
        <StatChip label="Streams cached" value={formatNumber(streams.length)} />
        <StatChip
          label="Last checked"
          value={
            summary.lastFetchedAt ? formatRelative(summary.lastFetchedAt) : "—"
          }
        />
      </div>

      {/* Latest streams (VODs) */}
      <div>
        <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <Radio className="size-3.5" />
          Latest streams
        </h3>
        {streams.length === 0 ? (
          <p className="rounded-lg border bg-card/50 px-3 py-3 text-xs text-muted-foreground">
            No streams cached for this channel.
          </p>
        ) : (
          <ul className="space-y-2">
            {streams.slice(0, 8).map((s) => (
              <li
                key={s.kickStreamId}
                className="rounded-lg border bg-card/50 px-3 py-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0 truncate text-sm font-medium">
                    {s.title || "Untitled stream"}
                  </span>
                  {s.vodUrl && (
                    <a
                      href={s.vodUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                    >
                      VOD
                      <ExternalLink className="size-3" />
                    </a>
                  )}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                  {s.startedAt && (
                    <span className="inline-flex items-center gap-1">
                      <Clock className="size-3" />
                      {formatDateTime(s.startedAt)}
                    </span>
                  )}
                  {s.durationSeconds != null && (
                    <span>{formatDuration(s.durationSeconds)}</span>
                  )}
                  {s.category && (
                    <Badge
                      variant="outline"
                      className="h-4 px-1.5 text-[10px] font-normal"
                    >
                      {s.category}
                    </Badge>
                  )}
                  {s.vodViews != null && (
                    <span className="inline-flex items-center gap-1">
                      <Eye className="size-3" />
                      {compactCount(s.vodViews)}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ─── Twitter body ─────────────────────────────────────────────────────────

function TwitterDetailBody({ detail }: { detail: TwitterCheckDetail | null }) {
  if (!detail) {
    return <EmptyState platform="twitter" />;
  }
  const { summary, tweets } = detail;
  return (
    <div className="space-y-4">
      <ProfileHeader
        avatarUrl={summary.avatarUrl}
        displayName={summary.displayName}
        handle={summary.handle}
        isVerified={summary.isVerified}
        bio={summary.bio}
      />

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatChip
          label="Followers"
          value={
            summary.followerCount != null
              ? formatNumber(summary.followerCount)
              : "—"
          }
        />
        <StatChip
          label="Following"
          value={
            summary.followingCount != null
              ? formatNumber(summary.followingCount)
              : "—"
          }
        />
        <StatChip
          label="Tweets"
          value={
            summary.tweetCount != null ? compactCount(summary.tweetCount) : "—"
          }
        />
        {/* Mentions of US — neutral info signal (blue), not a money figure. */}
        <StatChip
          label="Mentions · 7d"
          value={formatNumber(summary.mentionCount7d)}
          accent={summary.mentionCount7d > 0 ? "blue" : undefined}
        />
      </div>

      {/* Latest tweets */}
      <div>
        <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <MessageCircle className="size-3.5" />
          Latest tweets
        </h3>
        {tweets.length === 0 ? (
          <p className="rounded-lg border bg-card/50 px-3 py-3 text-xs text-muted-foreground">
            No tweets cached for this handle.
          </p>
        ) : (
          <ul className="space-y-2">
            {tweets.slice(0, 8).map((t) => (
              <li
                key={t.tweetId}
                className={cn(
                  "rounded-lg border px-3 py-2",
                  t.mentionsUs
                    ? "border-blue-500/30 bg-blue-500/10"
                    : "bg-card/50",
                )}
              >
                <p className="whitespace-pre-wrap break-words text-sm">
                  {t.text || "(no text)"}
                </p>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                  {t.postedAt && (
                    <span className="inline-flex items-center gap-1">
                      <Clock className="size-3" />
                      {formatRelative(t.postedAt)}
                    </span>
                  )}
                  {t.likeCount != null && (
                    <span className="inline-flex items-center gap-1">
                      <Heart className="size-3" />
                      {compactCount(t.likeCount)}
                    </span>
                  )}
                  {t.retweetCount != null && (
                    <span className="inline-flex items-center gap-1">
                      <Repeat2 className="size-3" />
                      {compactCount(t.retweetCount)}
                    </span>
                  )}
                  {t.replyCount != null && (
                    <span className="inline-flex items-center gap-1">
                      <MessageCircle className="size-3" />
                      {compactCount(t.replyCount)}
                    </span>
                  )}
                  {t.viewCount != null && (
                    <span className="inline-flex items-center gap-1">
                      <Eye className="size-3" />
                      {compactCount(t.viewCount)}
                    </span>
                  )}
                  {t.mentionsUs && (
                    <Badge
                      variant="outline"
                      className="h-4 border-blue-500/30 px-1.5 text-[10px] font-normal text-blue-600 dark:text-blue-400"
                    >
                      mentions us
                    </Badge>
                  )}
                  {t.url && (
                    <a
                      href={t.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 hover:text-foreground"
                    >
                      open
                      <ExternalLink className="size-3" />
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ─── Shared pieces ────────────────────────────────────────────────────────

function ProfileHeader({
  avatarUrl,
  displayName,
  handle,
  isVerified,
  bio,
  live,
}: {
  avatarUrl: string | null;
  displayName: string | null;
  handle: string;
  isVerified: boolean | null;
  bio: string | null;
  live?: boolean;
}) {
  return (
    <div className="flex items-start gap-3">
      <ProfileAvatar avatarUrl={avatarUrl} handle={handle} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="truncate text-sm font-semibold">
            {displayName || handle}
          </span>
          {isVerified && (
            <BadgeCheck className="size-4 shrink-0 text-sky-500" aria-label="Verified" />
          )}
          {live && (
            <Badge
              variant="outline"
              className="h-4 gap-1 border-rose-500/40 px-1.5 text-[10px] font-medium text-rose-600 dark:text-rose-400"
            >
              <span className="size-1.5 animate-pulse rounded-full bg-rose-500" />
              LIVE
            </Badge>
          )}
        </div>
        <p className="truncate text-xs text-muted-foreground">@{handle}</p>
        {bio && (
          <p className="mt-1 line-clamp-3 text-xs text-muted-foreground">
            {bio}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * External avatar from the platform CDN. We use a plain <img> (not next/image)
 * because Kick/Twitter CDNs aren't in next.config remotePatterns and that
 * config is a shared hotspot we must not edit here. Falls back to a monogram
 * tile if the image is missing or fails to load.
 */
function ProfileAvatar({
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
      <span className="flex size-12 shrink-0 items-center justify-center rounded-full border bg-muted text-base font-semibold text-muted-foreground">
        {letter}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={avatarUrl}
      alt={`${handle} avatar`}
      width={48}
      height={48}
      loading="lazy"
      onError={() => setFailed(true)}
      className="size-12 shrink-0 rounded-full border object-cover"
    />
  );
}

function StatChip({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: "blue";
}) {
  return (
    <div className="rounded-lg border bg-card/50 px-2.5 py-2">
      <p className="truncate text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p
        className={cn(
          "mt-0.5 truncate text-sm font-bold tabular-nums",
          accent === "blue" && "text-blue-600 dark:text-blue-400",
        )}
      >
        {value}
      </p>
    </div>
  );
}

function EmptyState({ platform }: { platform: "kick" | "twitter" }) {
  return (
    <div className="rounded-lg border bg-card/50 px-3 py-6 text-center text-sm text-muted-foreground">
      No cached {platform === "kick" ? "Kick" : "Twitter"} data for this handle.
      Try a Refetch.
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <Skeleton className="size-12 rounded-full" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-full" />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-12 rounded-lg" />
        ))}
      </div>
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-14 rounded-lg" />
        ))}
      </div>
    </div>
  );
}

// ─── Local helpers ──────────────────────────────────────────────────────────

/** Seconds → "1h 23m" / "45m" / "30s". */
function formatDuration(totalSeconds: number): string {
  if (totalSeconds <= 0) return "0s";
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}
