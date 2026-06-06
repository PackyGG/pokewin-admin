import { Suspense } from "react";
import {
  AtSign,
  BadgeCheck,
  ExternalLink,
  Heart,
  Info,
  Link2,
  MessageCircle,
  Megaphone,
  Repeat2,
  Twitter,
  Users,
  UsersRound,
  Eye,
  FileText,
  KeyRound,
} from "lucide-react";

import { SectionHeading, KpiTile } from "@/components/modern-panels";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { FadeIn } from "@/components/fade-in";
import { safeQueryOrNull } from "@/lib/errors/safe-query";
import { formatNumber, formatRelative } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

import {
  getTwitterTabData,
  TWITTER_BRAND_KEYWORDS,
  type TwitterTabData,
} from "../_queries/twitter-tab-data";
import { TwitterRefetchButton } from "./twitter-refetch-button";

/**
 * Creator Hub — `creators/[id]` **Twitter** tab.
 *
 * Owner spec: show the creator's X profile (pfp, username, followers, bio),
 * their latest tweets (text, time, engagement), and the **7-day brand-mention
 * count** (how many of the last-7d tweets mention us — keywords
 * packydotgg / @packydotgg / packygg / packy.gg). A manual **Refetch** button
 * is the only forced-refresh path; everything else is served from the
 * ADMIN-DB cache within a TTL (no auto-poll, no per-render fetch).
 *
 * STATES (no fabrication):
 *   • no Twitter handle linked  → "No account linked" empty state + a hint to
 *     add it on the Creator tab.
 *   • RapidAPI key not set      → a "Twitter API key not configured" state
 *     pointing to Settings (the key is server-only; never shown).
 *   • data                      → profile card + KPI strip + mention banner +
 *     latest tweets.
 *
 * HOUSE-POV NOTE: Twitter metrics (followers / engagement) are neutral social
 * stats, NOT house money flows, so they use neutral/blue/sky accents — the
 * emerald/rose money convention does not apply to them.
 *
 * LAZY: this component is the ONLY caller of `getTwitterTabData`, so the X
 * read runs solely when the Twitter tab is opened (never preloaded). The
 * profile is fetch-once and the tweets/mentions are TTL-throttled, so opening
 * the tab does not spam the API. The display name / handle / avatar read from
 * the integration's `core` + `avatar` normalizer (the live twitter241 shape
 * nests them there), not legacy-only.
 *
 * PARSER NOTE: the shared integration (`@/lib/creator-hub` twitter.ts) already
 * normalizes the live twitter241 `/user` shape — it reads `display_name` from
 * `legacy.name ?? core.name` and `avatar_url` from
 * `legacy.profile_image_url_https ?? avatar.image_url`. No local parser fix was
 * needed for this tab; we consume the integration's typed `TwitterProfile`.
 */
export function TwitterTab({ userId }: { userId: string }) {
  return (
    <Suspense fallback={<TwitterTabSkeleton />}>
      <TwitterTabContent userId={userId} />
    </Suspense>
  );
}

async function TwitterTabContent({ userId }: { userId: string }) {
  // 15s budget — the cold path is at most a handle read + a few throttle-gated
  // integration calls (each timeout-wrapped internally); a slow upstream
  // degrades to the cached/empty value rather than hanging the tab.
  const { data } = await safeQueryOrNull(
    () => getTwitterTabData(userId),
    "creator-hub.creators.twitter",
    15_000,
  );

  // A hard failure (timeout / unexpected throw) → treat as no data; the tab
  // never blanks. We can't distinguish "not linked" here, so show a neutral
  // unavailable state.
  if (!data) {
    return (
      <FadeIn className="space-y-5">
        <TwitterHeading />
        <UnavailableState />
      </FadeIn>
    );
  }

  if (!data.linked) {
    return (
      <FadeIn className="space-y-5">
        <TwitterHeading />
        <NoAccountLinked />
      </FadeIn>
    );
  }

  if (data.noKey) {
    return (
      <FadeIn className="space-y-5">
        <TwitterHeading handle={data.handle} />
        <NoKeyConfiguredState />
      </FadeIn>
    );
  }

  return (
    <FadeIn className="space-y-5 sm:space-y-6">
      <TwitterHeading
        handle={data.handle}
        userId={userId}
        lastFetchedAt={data.lastFetchedAt}
      />

      {data.staleError && <StaleNotice message={data.staleError} />}

      <ProfileCard data={data} />

      <MentionBanner
        count={data.mentionCount}
        windowDays={data.mentionWindowDays}
        handle={data.handle}
      />

      <LatestTweets data={data} />
    </FadeIn>
  );
}

// ── Header ────────────────────────────────────────────────────────────

function TwitterHeading({
  handle,
  userId,
  lastFetchedAt,
}: {
  handle?: string;
  userId?: string;
  lastFetchedAt?: string | null;
}) {
  return (
    <SectionHeading
      icon={Twitter}
      title="Twitter / X"
      action={
        handle && userId ? (
          <div className="flex items-center gap-2">
            {lastFetchedAt && (
              <span className="hidden text-[11px] text-muted-foreground sm:inline">
                Updated {formatRelative(lastFetchedAt)}
              </span>
            )}
            <TwitterRefetchButton userId={userId} handle={handle} />
          </div>
        ) : undefined
      }
    />
  );
}

// ── Profile card + KPI strip ──────────────────────────────────────────

function ProfileCard({ data }: { data: Extract<TwitterTabData, { linked: true }> }) {
  const { profile, handle } = data;
  const displayName = profile?.displayName ?? `@${handle}`;
  const profileUrl = `https://x.com/${encodeURIComponent(handle)}`;
  const initials = (displayName || handle).slice(0, 2).toUpperCase();

  return (
    <div className="space-y-4">
      <Card size="sm" className="p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <Avatar className="size-14 shrink-0">
            {profile?.avatarUrl && <AvatarImage src={profile.avatarUrl} alt="" />}
            <AvatarFallback className="text-sm font-semibold">
              {initials}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate text-base font-semibold leading-tight">
                {displayName}
              </span>
              {profile?.isVerified && (
                <BadgeCheck className="size-4 shrink-0 text-sky-500" />
              )}
            </div>
            <a
              href={profileUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-0.5 inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline"
              title="Open X profile"
            >
              <AtSign className="size-3.5" />
              <span className="truncate font-mono">{handle}</span>
              <ExternalLink className="size-3 shrink-0" />
            </a>
            {profile?.bio && (
              <p className="mt-2 whitespace-pre-line text-sm text-foreground/90">
                {profile.bio}
              </p>
            )}
            {!profile && (
              <p className="mt-2 text-xs text-muted-foreground">
                Profile not fetched yet — use Refetch to pull it from X.
              </p>
            )}
          </div>
        </div>
      </Card>

      {/* KPI strip — neutral social stats (NOT money), so blue/sky/cyan. */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile
          label="Followers"
          value={profile?.followerCount != null ? formatNumber(profile.followerCount) : "—"}
          icon={Users}
          accent="blue"
        />
        <KpiTile
          label="Following"
          value={profile?.followingCount != null ? formatNumber(profile.followingCount) : "—"}
          icon={UsersRound}
          accent="cyan"
        />
        <KpiTile
          label="Tweets"
          value={profile?.tweetCount != null ? formatNumber(profile.tweetCount) : "—"}
          icon={FileText}
          accent="purple"
        />
        <KpiTile
          label={`Mentions · ${data.mentionWindowDays}d`}
          value={formatNumber(data.mentionCount)}
          sub="of us"
          icon={Megaphone}
          accent={data.mentionCount > 0 ? "emerald" : "blue"}
        />
      </div>
    </div>
  );
}

// ── 7-day brand-mention banner ────────────────────────────────────────

function MentionBanner({
  count,
  windowDays,
  handle,
}: {
  count: number;
  windowDays: number;
  handle: string;
}) {
  const mentioned = count > 0;
  // Brand awareness from a creator is GOOD for the house → emerald when they
  // mentioned us; neutral blue when they didn't (an info state, not a loss).
  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-xl border p-4 sm:flex-row sm:items-center sm:justify-between",
        mentioned
          ? "border-emerald-500/30 bg-emerald-500/5"
          : "border-border bg-muted/30",
      )}
    >
      <div className="flex items-start gap-3">
        <div
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-lg",
            mentioned ? "bg-emerald-500/15" : "bg-muted",
          )}
        >
          <Megaphone
            className={cn(
              "size-4",
              mentioned ? "text-emerald-500" : "text-muted-foreground",
            )}
          />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold">
            {mentioned ? (
              <>
                Mentioned us{" "}
                <span className="text-emerald-600 dark:text-emerald-400">
                  {count}
                </span>{" "}
                {count === 1 ? "time" : "times"} in the last {windowDays} days
              </>
            ) : (
              <>No brand mentions in the last {windowDays} days</>
            )}
          </div>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Scans @{handle}&apos;s recent tweets for:{" "}
            <span className="font-mono">
              {TWITTER_BRAND_KEYWORDS.join(", ")}
            </span>
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Latest tweets ─────────────────────────────────────────────────────

function LatestTweets({ data }: { data: Extract<TwitterTabData, { linked: true }> }) {
  const { tweets } = data;

  return (
    <div className="space-y-3">
      <SectionHeading icon={MessageCircle} title="Latest tweets" />
      {tweets.length === 0 ? (
        <Card size="sm" className="p-6 text-center text-sm text-muted-foreground">
          No tweets cached yet. Use Refetch to pull the latest from X.
        </Card>
      ) : (
        <div className="space-y-2.5">
          {tweets.map((t) => (
            <TweetRow key={t.tweetId} tweet={t} />
          ))}
        </div>
      )}
    </div>
  );
}

function TweetRow({ tweet }: { tweet: Extract<TwitterTabData, { linked: true }>["tweets"][number] }) {
  return (
    <Card size="sm" className="p-3.5 sm:p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="whitespace-pre-line break-words text-sm leading-relaxed text-foreground/90">
            {tweet.text || <span className="italic text-muted-foreground">(no text)</span>}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
            {tweet.postedAt && (
              <span title={tweet.postedAt}>{formatRelative(tweet.postedAt)}</span>
            )}
            <EngagementStat icon={Heart} value={tweet.likeCount} label="likes" />
            <EngagementStat icon={Repeat2} value={tweet.retweetCount} label="retweets" />
            <EngagementStat icon={MessageCircle} value={tweet.replyCount} label="replies" />
            <EngagementStat icon={Eye} value={tweet.viewCount} label="views" />
            {tweet.mentionsUs && (
              <Badge
                variant="outline"
                className="border-emerald-500/30 bg-emerald-500/10 text-[9px] text-emerald-600 dark:text-emerald-400"
              >
                <Megaphone className="mr-1 size-2.5" />
                Mentions us
              </Badge>
            )}
          </div>
        </div>
        {tweet.url && (
          <a
            href={tweet.url}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 text-muted-foreground hover:text-foreground"
            title="Open tweet on X"
            aria-label="Open tweet on X"
          >
            <ExternalLink className="size-4" />
          </a>
        )}
      </div>
    </Card>
  );
}

function EngagementStat({
  icon: Icon,
  value,
  label,
}: {
  icon: React.ElementType;
  value: number | null;
  label: string;
}) {
  if (value == null) return null;
  return (
    <span className="inline-flex items-center gap-1" title={`${formatNumber(value)} ${label}`}>
      <Icon className="size-3" />
      {formatNumber(value)}
    </span>
  );
}

// ── Empty / error states ──────────────────────────────────────────────

function NoAccountLinked() {
  return (
    <Card size="sm" className="flex flex-col items-center gap-3 p-8 text-center">
      <div className="flex size-12 items-center justify-center rounded-2xl bg-muted">
        <Twitter className="size-6 text-muted-foreground" />
      </div>
      <div>
        <div className="text-sm font-semibold">No account linked</div>
        <p className="mt-1 max-w-sm text-xs text-muted-foreground">
          This creator has no Twitter / X handle linked. Add one on the{" "}
          <span className="inline-flex items-center gap-1 font-medium text-foreground">
            <Link2 className="size-3" />
            Creator
          </span>{" "}
          tab to pull their profile, latest tweets, and brand mentions here.
        </p>
      </div>
    </Card>
  );
}

function NoKeyConfiguredState() {
  return (
    <Card
      size="sm"
      className="flex flex-col items-center gap-3 border-amber-500/30 bg-amber-500/5 p-8 text-center"
    >
      <div className="flex size-12 items-center justify-center rounded-2xl bg-amber-500/15">
        <KeyRound className="size-6 text-amber-500" />
      </div>
      <div>
        <div className="text-sm font-semibold text-amber-600 dark:text-amber-400">
          Twitter API key not configured
        </div>
        <p className="mt-1 max-w-sm text-xs text-muted-foreground">
          The Twitter (RapidAPI) key isn&apos;t set, so live data can&apos;t be
          fetched. Add it in{" "}
          <span className="font-medium text-foreground">
            Creator Hub → Settings
          </span>
          . The key is stored server-side and never shown.
        </p>
      </div>
    </Card>
  );
}

function UnavailableState() {
  return (
    <Card size="sm" className="flex items-start gap-3 p-4 text-sm">
      <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div>
        <div className="font-medium">Twitter data unavailable</div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          The Twitter read timed out or failed. Try the Refetch button, or
          reload the tab.
        </p>
      </div>
    </Card>
  );
}

function StaleNotice({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-muted-foreground">
      <Info className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
      <span>
        Showing cached data — last refresh didn&apos;t fully complete
        {message ? `: ${message}` : "."}
      </span>
    </div>
  );
}

// ── Suspense fallback ─────────────────────────────────────────────────

function TwitterTabSkeleton() {
  return (
    <div className="space-y-5 sm:space-y-6">
      <Skeleton className="h-6 w-32" />
      <Card size="sm" className="p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <Skeleton className="size-14 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-5 w-44" />
            <Skeleton className="h-3.5 w-28" />
            <Skeleton className="h-3 w-full max-w-md" />
            <Skeleton className="h-3 w-3/4 max-w-sm" />
          </div>
        </div>
      </Card>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-[88px] rounded-2xl" />
        ))}
      </div>
      <Skeleton className="h-16 w-full rounded-xl" />
      <div className="space-y-3">
        <Skeleton className="h-6 w-32" />
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-24 w-full rounded-xl" />
        ))}
      </div>
    </div>
  );
}
