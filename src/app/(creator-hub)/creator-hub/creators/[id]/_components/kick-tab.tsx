import {
  BadgeCheck,
  CalendarClock,
  Clock,
  Eye,
  Film,
  Info,
  KeyRound,
  Link2Off,
  MapPin,
  Radio,
  Tv,
  Users,
} from "lucide-react";

import { SectionHeading, KpiTile } from "@/components/modern-panels";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { FadeIn } from "@/components/fade-in";
import { LinkButton } from "./link-button";
import { safeQueryOrNull } from "@/lib/errors/safe-query";
import { formatDate, formatNumber, formatRelative } from "@/lib/utils/format";

import { getKickTabData, type KickTabData } from "../_queries/kick-data";
import { KickRefetchButton } from "./kick-refetch-button";

/**
 * Creator Hub — `creators/[id]` **Kick** tab.
 *
 * Shows the creator's Kick channel:
 *   • Channel profile — pfp, username, followers, bio, country, verified, and
 *     live status — served from the ADMIN-DB cache (fetch-once + manual
 *     Refetch).
 *   • Past streams list — date, duration, title, category, VOD replay views —
 *     served from the DB within a TTL + manual Refetch.
 *   • A Refetch button forces a refresh (the ONLY forced-refresh path; the
 *     service is anti-mash throttled — no loop / no poll / no per-render
 *     fetch).
 *
 * Empty states (never an error/crash):
 *   • No Kick handle linked → clean "No account linked" state with a CTA to
 *     add the handle on the Creator tab.
 *   • Kick API key not configured (and nothing cached) → a "no key" hint
 *     pointing at Hub Settings.
 *
 * LAZY + self-contained: the ONLY caller of `getKickTabData`, so the cache
 * read (+ at most one conditional fetch) happens solely when the Kick tab is
 * opened (never preloaded). Reads the ADMIN DB only; MAIN/prod is untouched.
 */
export async function KickTab({ userId }: { userId: string }) {
  // 15s budget — a cold conditional fetch (profile + streams) plus the cache
  // reads complete well within this; a stuck upstream degrades to the
  // "taking too long" banner rather than hanging the tab.
  const { data } = await safeQueryOrNull(
    () => getKickTabData(userId),
    "creator-hub.creators.kick",
    15_000,
  );

  if (!data) {
    return (
      <FadeIn className="space-y-5">
        <KickHeading userId={userId} canRefetch={false} />
        <DegradedBanner />
      </FadeIn>
    );
  }

  // No linked Kick handle → clean "No account linked" empty state.
  if (!data.handle) {
    return (
      <FadeIn className="space-y-5">
        <KickHeading userId={userId} canRefetch={false} />
        <NoAccountLinked userId={userId} />
      </FadeIn>
    );
  }

  // Handle linked but the API key is missing AND nothing was ever cached.
  const hasAnyData = data.profile != null || data.streams.length > 0;
  if (data.noKeyConfigured && !hasAnyData) {
    return (
      <FadeIn className="space-y-5">
        <KickHeading userId={userId} canRefetch handle={data.handle} />
        <NoKeyConfigured handle={data.handle} />
      </FadeIn>
    );
  }

  return (
    <FadeIn className="space-y-5 sm:space-y-6">
      <KickHeading userId={userId} canRefetch handle={data.handle} />
      {(data.profileStaleError || data.streamsStaleError) && <StaleBanner />}
      <ProfileCard data={data} />
      <StreamsSection data={data} />
    </FadeIn>
  );
}

// ── Heading (with Refetch action) ────────────────────────────────────

function KickHeading({
  userId,
  canRefetch,
  handle,
}: {
  userId: string;
  canRefetch: boolean;
  handle?: string;
}) {
  return (
    <SectionHeading
      icon={Tv}
      title="Kick"
      action={
        canRefetch ? (
          <div className="flex items-center gap-2">
            {handle && (
              <LinkButton href={`https://kick.com/${handle}`}>
                <Tv className="size-3.5 text-green-500" />
                <span className="truncate">@{handle}</span>
              </LinkButton>
            )}
            <KickRefetchButton userId={userId} />
          </div>
        ) : undefined
      }
    />
  );
}

// ── Channel profile ──────────────────────────────────────────────────

function ProfileCard({ data }: { data: KickTabData }) {
  const p = data.profile;
  const geoParts = [data.city, data.state, data.country].filter(Boolean);
  const geo = geoParts.length > 0 ? geoParts.join(", ") : null;

  if (!p) {
    // Handle linked, key present, but the channel isn't in the cache yet and
    // the conditional fetch returned nothing (e.g. unknown slug / first miss).
    return (
      <Card size="sm" className="p-6 text-center text-sm text-muted-foreground">
        No Kick channel data for{" "}
        <span className="font-mono text-foreground">@{data.handle}</span> yet.
        Click Refetch to pull it from Kick.
      </Card>
    );
  }

  const name = p.displayName ?? p.username;
  const initials = (name ?? "?").slice(0, 2).toUpperCase();
  const kickUrl = `https://kick.com/${p.username}`;

  return (
    <Card size="sm" className="overflow-hidden p-0">
      <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-start sm:gap-5 sm:p-5">
        {/* Avatar + live ring */}
        <div className="relative shrink-0 self-center sm:self-start">
          <Avatar className="size-20 ring-2 ring-border sm:size-24">
            {p.avatarUrl && <AvatarImage src={p.avatarUrl} alt="" />}
            <AvatarFallback className="text-xl font-semibold">
              {initials}
            </AvatarFallback>
          </Avatar>
          {p.isLive && (
            <span className="absolute -bottom-1 left-1/2 inline-flex -translate-x-1/2 items-center gap-1 rounded-full border border-rose-500/30 bg-rose-500/15 px-2 py-0.5 text-[10px] font-semibold text-rose-600 dark:text-rose-400">
              <Radio className="size-2.5 animate-pulse" />
              LIVE
            </span>
          )}
        </div>

        {/* Identity + meta */}
        <div className="min-w-0 flex-1 space-y-2.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <a
              href={kickUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="truncate text-lg font-bold leading-tight hover:underline sm:text-xl"
              title="Open on Kick"
            >
              {name}
            </a>
            {p.isVerified && (
              <Badge
                variant="outline"
                className="gap-1 border-green-500/30 text-[10px] text-green-600 dark:text-green-400"
                title="Verified on Kick"
              >
                <BadgeCheck className="size-3" />
                Verified
              </Badge>
            )}
            {!p.isLive && (
              <Badge variant="secondary" className="text-[10px]">
                Offline
              </Badge>
            )}
          </div>

          {/* @slug + geo */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1 font-mono">
              <Tv className="size-3 text-green-500" />@{p.username}
            </span>
            {geo && (
              <span className="inline-flex items-center gap-1">
                <MapPin className="size-3" />
                {geo}
              </span>
            )}
            {p.lastFetchedAt && (
              <span className="inline-flex items-center gap-1">
                <Clock className="size-3" />
                Updated {formatRelative(p.lastFetchedAt)}
              </span>
            )}
          </div>

          {/* Bio */}
          {p.bio ? (
            <p className="whitespace-pre-line text-sm text-foreground/80">
              {p.bio}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">No bio set.</p>
          )}
        </div>
      </div>

      {/* KPI strip — followers + live status. House style: these are audience
          metrics (not money), so they use neutral blue/cyan accents; live is
          a status, shown rose only as a "live now" emphasis. */}
      <div className="grid grid-cols-2 gap-2.5 border-t bg-muted/20 p-3 sm:grid-cols-3 sm:gap-3 sm:p-4">
        <KpiTile
          label="Followers"
          value={p.followerCount != null ? formatNumber(p.followerCount) : "—"}
          icon={Users}
          accent="blue"
        />
        <KpiTile
          label="Status"
          value={p.isLive ? "Live now" : "Offline"}
          icon={Radio}
          accent={p.isLive ? "rose" : "cyan"}
        />
        <KpiTile
          label="Past streams"
          value={formatNumber(data.streams.length)}
          sub={
            data.streamsLastFetchedAt
              ? `Updated ${formatRelative(data.streamsLastFetchedAt)}`
              : "Cached"
          }
          icon={Film}
          accent="purple"
        />
      </div>
    </Card>
  );
}

// ── Past streams ─────────────────────────────────────────────────────

function StreamsSection({ data }: { data: KickTabData }) {
  return (
    <div className="space-y-3">
      <SectionHeading icon={CalendarClock} title="Past streams" />
      {data.streams.length === 0 ? (
        <Card
          size="sm"
          className="p-6 text-center text-sm text-muted-foreground"
        >
          No past streams cached for{" "}
          <span className="font-mono text-foreground">@{data.handle}</span> yet.
          Use Refetch to pull the latest VODs from Kick.
        </Card>
      ) : (
        <Card size="sm" className="overflow-hidden p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-[150px]">Date</TableHead>
                  <TableHead className="min-w-[220px]">Title</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead className="text-right">Duration</TableHead>
                  <TableHead className="text-right">VOD views</TableHead>
                  <TableHead className="text-right">VOD</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.streams.map((s) => (
                  <StreamRow key={s.kickStreamId} stream={s} />
                ))}
              </TableBody>
            </Table>
          </div>
        </Card>
      )}
    </div>
  );
}

function StreamRow({
  stream,
}: {
  stream: KickTabData["streams"][number];
}) {
  return (
    <TableRow>
      {/* Date */}
      <TableCell className="whitespace-nowrap">
        {stream.startedAt ? (
          <div className="flex flex-col">
            <span className="text-sm font-medium">
              {formatDate(stream.startedAt)}
            </span>
            <span className="text-[11px] text-muted-foreground">
              {formatRelative(stream.startedAt)}
            </span>
          </div>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>

      {/* Title */}
      <TableCell>
        <span className="line-clamp-2 text-sm" title={stream.title ?? undefined}>
          {stream.title ?? (
            <span className="text-muted-foreground">Untitled stream</span>
          )}
        </span>
      </TableCell>

      {/* Category */}
      <TableCell>
        {stream.category ? (
          <Badge variant="secondary" className="text-[10px]">
            {stream.category}
          </Badge>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </TableCell>

      {/* Duration */}
      <TableCell className="text-right tabular-nums">
        {stream.durationSeconds != null ? (
          <span className="inline-flex items-center justify-end gap-1 text-sm">
            <Clock className="size-3 text-muted-foreground" />
            {formatDuration(stream.durationSeconds)}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>

      {/* VOD replay views */}
      <TableCell className="text-right tabular-nums">
        {stream.vodViews != null ? (
          <span className="inline-flex items-center justify-end gap-1 text-sm">
            <Eye className="size-3 text-muted-foreground" />
            {formatNumber(stream.vodViews)}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>

      {/* VOD link */}
      <TableCell className="text-right">
        {stream.vodUrl ? (
          <LinkButton href={stream.vodUrl} className="ml-auto">
            <Film className="size-3.5" />
            Watch
          </LinkButton>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </TableCell>
    </TableRow>
  );
}

// ── Empty / degraded states ──────────────────────────────────────────

function NoAccountLinked({ userId }: { userId: string }) {
  return (
    <Card
      size="sm"
      className="flex flex-col items-center gap-3 p-8 text-center sm:p-10"
    >
      <div className="flex size-12 items-center justify-center rounded-2xl bg-muted">
        <Link2Off className="size-6 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <div className="text-sm font-semibold">No account linked</div>
        <p className="mx-auto max-w-sm text-xs text-muted-foreground">
          This creator has no Kick channel linked yet. Add their Kick handle on
          the Creator tab to see channel stats and past streams here.
        </p>
      </div>
      <LinkButton href={`/creator-hub/creators/${userId}?tab=creator`}>
        <Tv className="size-3.5 text-green-500" />
        Add Kick handle
      </LinkButton>
    </Card>
  );
}

function NoKeyConfigured({ handle }: { handle: string }) {
  return (
    <Card size="sm" className="p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-amber-500/10">
          <KeyRound className="size-4 text-amber-500" />
        </div>
        <div className="min-w-0 space-y-1">
          <div className="text-sm font-semibold text-amber-600 dark:text-amber-400">
            Kick API key not configured
          </div>
          <p className="text-xs text-muted-foreground">
            <span className="font-mono text-foreground">@{handle}</span> is
            linked, but the Kick RapidAPI key isn&apos;t set, so there&apos;s no
            cached data to show. Add the key in Hub Settings, then use Refetch.
          </p>
          <div className="pt-1">
            <LinkButton href="/creator-hub/settings">
              <KeyRound className="size-3.5" />
              Open Hub Settings
            </LinkButton>
          </div>
        </div>
      </div>
    </Card>
  );
}

function DegradedBanner() {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
      <Info className="mt-0.5 size-4 shrink-0 text-amber-500" />
      <div>
        <div className="font-medium text-amber-500">
          Kick data is taking too long to load
        </div>
        <div className="mt-0.5 text-muted-foreground">
          The Kick channel read timed out. Refresh to retry — the rest of the
          page is unaffected.
        </div>
      </div>
    </div>
  );
}

function StaleBanner() {
  return (
    <div className="flex items-start gap-2 rounded-md border border-dashed border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-muted-foreground">
      <Info className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
      <span>
        Showing the last cached Kick data — the most recent refresh failed.
        Try Refetch again in a moment.
      </span>
    </div>
  );
}

// ── helpers ──────────────────────────────────────────────────────────

/** Format a stream duration in seconds → "Hh Mm" / "Mm" / "Ss". */
function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

// ── Suspense fallback ────────────────────────────────────────────────

export function KickTabSkeleton() {
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <Skeleton className="size-7 rounded-lg" />
          <Skeleton className="h-5 w-20" />
        </div>
        <Skeleton className="h-8 w-24 rounded-lg" />
      </div>
      <Card size="sm" className="p-4 sm:p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-5">
          <Skeleton className="size-20 shrink-0 self-center rounded-full sm:size-24 sm:self-start" />
          <div className="min-w-0 flex-1 space-y-2.5">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-3 w-56" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-3/4" />
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16 w-full rounded-xl" />
          ))}
        </div>
      </Card>
      <Card size="sm" className="space-y-2 p-4">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </Card>
    </div>
  );
}
