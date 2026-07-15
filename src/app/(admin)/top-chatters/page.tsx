import { Suspense } from "react";
import Link from "next/link";
import { MessageSquare, Trophy, AlertTriangle } from "lucide-react";

import { requirePageAccess } from "@/lib/dal";
import { safeQuery } from "@/lib/errors/safe-query";
import { FadeIn } from "@/components/fade-in";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { ROLE_COLORS } from "@/lib/constants";
import { formatNumber } from "@/lib/utils/format";
import { getTopChattersToday } from "@/lib/queries/chat";

export const metadata = { title: "Top Chatters" };

/** Small live aggregate over chat_messages, bounded to today's UTC window
 *  and cached 20s server-side (see getTopChattersToday) — this is only a
 *  connection-hang guard, not a real load concern at current chat volume. */
const TOP_CHATTERS_TIMEOUT_MS = 15_000;

const POSITION_COLORS: Record<number, string> = {
  1: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
  2: "bg-zinc-400/15 text-zinc-500 dark:text-zinc-400 border-zinc-400/30",
  3: "bg-amber-700/15 text-amber-700 dark:text-amber-500 border-amber-700/30",
};

/**
 * Players → Top Chatters.
 *
 * Live leaderboard of the most active packy chat senders for the CURRENT
 * UTC calendar day (resets at 00:00 UTC — a fixed calendar day, not a
 * rolling 24h window, per the feature request). Computed live from
 * chat_messages since there is no daily chat-activity snapshot table.
 *
 * Shell-first: the hero paints immediately; the leaderboard fetch lives in
 * its own Suspense leg below (see loading.tsx for the matching skeleton).
 */
export default async function TopChattersPage() {
  await requirePageAccess("/top-chatters");

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={MessageSquare}
          accent="cyan"
          title="Top Chatters"
          subtitle="Most active packy chat senders today"
        />
      </PageHero>

      <Suspense fallback={<TopChattersSkeleton />}>
        <TopChattersSection />
      </Suspense>
    </div>
  );
}

async function TopChattersSection() {
  const EMPTY: Awaited<ReturnType<typeof getTopChattersToday>> = {
    entries: [],
    totalChatters: 0,
  };
  const result = await safeQuery(
    () => getTopChattersToday(),
    EMPTY,
    "top-chatters.today",
    TOP_CHATTERS_TIMEOUT_MS,
  );
  const { entries, totalChatters } = result.data;
  const listFailed = result.error !== null;

  return (
    <FadeIn className="space-y-6">
      <div className="space-y-3">
        <SectionHeading icon={MessageSquare} title="Today's chat leaderboard" />

        {listFailed && (
          <div
            role="status"
            aria-live="polite"
            className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3"
          >
            <AlertTriangle
              aria-hidden
              className="mt-0.5 size-4 shrink-0 text-amber-500"
            />
            <p className="text-xs text-amber-700 dark:text-amber-300">
              Couldn&apos;t load the chat leaderboard — the query timed out
              or failed. Refresh to retry.
            </p>
          </div>
        )}

        <div className="rounded-2xl border bg-card p-4">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold">Active chatters</span>
            <span className="text-xs text-muted-foreground">
              {formatNumber(totalChatters)} sending messages today · resets
              00:00 UTC
            </span>
          </div>

          {entries.length === 0 ? (
            <div className="mt-6 flex flex-col items-center gap-2 rounded-xl border border-dashed py-10 text-muted-foreground">
              <MessageSquare className="size-6" />
              <span className="text-sm">No chat messages sent yet today.</span>
            </div>
          ) : (
            <div className="mt-4 overflow-hidden rounded-md border">
              {entries.map((entry) => {
                const positionColor =
                  POSITION_COLORS[entry.position] ??
                  "bg-muted text-muted-foreground border-border";
                return (
                  <div
                    key={entry.userId}
                    className="flex items-center gap-3 border-b px-3 py-2.5 last:border-b-0"
                  >
                    <div
                      className={cn(
                        "flex size-8 shrink-0 items-center justify-center rounded-full border text-xs font-bold",
                        positionColor,
                      )}
                    >
                      {entry.position <= 3 ? (
                        <Trophy className="size-4" />
                      ) : (
                        `#${entry.position}`
                      )}
                    </div>

                    <Avatar className="size-8 shrink-0">
                      {entry.image && <AvatarImage src={entry.image} />}
                      <AvatarFallback className="text-[11px]">
                        {(entry.username ?? entry.userId).slice(0, 2).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>

                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      <Link
                        href={`/users/${entry.userId}`}
                        className="truncate font-semibold hover:underline"
                      >
                        {entry.username ?? entry.userId.slice(0, 8)}
                      </Link>
                      {entry.role !== "user" && (
                        <Badge
                          variant="outline"
                          className={cn(
                            "h-4 shrink-0 px-1 text-[9px] uppercase",
                            ROLE_COLORS[entry.role],
                          )}
                        >
                          {entry.role}
                        </Badge>
                      )}
                    </div>

                    <span className="shrink-0 tabular-nums text-sm font-medium">
                      {formatNumber(entry.messageCount)}{" "}
                      <span className="text-xs font-normal text-muted-foreground">
                        msgs
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </FadeIn>
  );
}

function TopChattersSkeleton() {
  return (
    <div className="space-y-4">
      <div className="rounded-2xl border bg-card p-4">
        <div className="flex items-center justify-between">
          <Skeleton className="h-4 w-32 rounded" />
          <Skeleton className="h-3 w-48 rounded" />
        </div>
        <div className="mt-4 space-y-3">
          {Array.from({ length: 10 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full rounded" />
          ))}
        </div>
      </div>
    </div>
  );
}
