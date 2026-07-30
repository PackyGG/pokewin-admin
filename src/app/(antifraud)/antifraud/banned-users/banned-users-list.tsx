"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Ban, Loader2, RotateCcw, UsersRound } from "lucide-react";

import { HostLink } from "@/components/host-link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatRelative } from "@/lib/utils/format";
import type { AntifraudBannedUser } from "@/lib/antifraud/profiles-api";
import { AccountBanAction } from "./account-ban-action";

/**
 * Banned accounts list with scroll pagination. Page 1 is rendered on the
 * server; every following page is appended when the sentinel below the list
 * enters the viewport (`/api/antifraud/banned-users`). Ordering is newest ban
 * first, so appended pages never reshuffle what is already on screen.
 */
export function BannedUsersList({
  initialUsers,
  initialPage,
  totalPages,
  total,
  search,
}: {
  initialUsers: AntifraudBannedUser[];
  initialPage: number;
  totalPages: number;
  total: number;
  search?: string;
}) {
  const [users, setUsers] = useState(initialUsers);
  const [page, setPage] = useState(initialPage);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const hasMore = page < totalPages;

  useEffect(() => {
    setUsers(initialUsers);
    setPage(initialPage);
    setFailed(false);
  }, [initialUsers, initialPage]);

  const loadMore = useCallback(async () => {
    if (loading) return;
    setLoading(true);
    setFailed(false);
    const next = page + 1;
    try {
      const query = new URLSearchParams({ page: String(next) });
      if (search) query.set("search", search);
      const response = await fetch(`/api/antifraud/banned-users?${query}`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error("request_failed");
      const payload = (await response.json()) as {
        data: AntifraudBannedUser[];
      };
      setUsers((current) => {
        const seen = new Set(current.map((user) => user.userId));
        return [
          ...current,
          ...payload.data.filter((user) => !seen.has(user.userId)),
        ];
      });
      setPage(next);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [loading, page, search]);

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !hasMore || failed || typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMore();
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, failed, loadMore]);

  return (
    <section className="overflow-hidden rounded-xl border border-border/60 bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-4 py-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Ban className="size-4 text-rose-500" />
          Banned accounts
        </h2>
        <span className="text-[10px] font-semibold uppercase tracking-wide tabular-nums text-muted-foreground">
          {users.length} of {total}
        </span>
      </div>
      {users.length === 0 ? (
        <div className="px-4 py-14 text-center">
          <UsersRound className="mx-auto mb-3 size-6 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            No banned accounts match this search.
          </p>
        </div>
      ) : (
        <div className="divide-y divide-border/60">
          {users.map((user) => (
            <div
              key={user.userId}
              className="grid gap-3 px-4 py-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center"
            >
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <HostLink
                    href={`/users/${encodeURIComponent(user.userId)}`}
                    className="truncate font-medium hover:underline"
                  >
                    {user.username ?? user.userId}
                  </HostLink>
                  <Badge variant="destructive">Banned</Badge>
                  {user.countryCode && <Badge variant="outline">{user.countryCode}</Badge>}
                </div>
                <p className="truncate text-xs text-muted-foreground">{user.email ?? "Email unknown"}</p>
                <p className="text-xs">{user.banReason ?? "Historical ban reason unknown"}</p>
                <p className="text-[11px] text-muted-foreground">
                  {user.bannedAt ? `Banned ${formatRelative(user.bannedAt)}` : "Ban time unknown"}
                </p>
              </div>
              <AccountBanAction
                userId={user.userId}
                account={user.username ?? user.userId}
                action="unban"
              />
            </div>
          ))}
        </div>
      )}
      {hasMore && (
        <div
          ref={sentinelRef}
          className="flex items-center justify-center gap-2 border-t border-border/60 px-4 py-4 text-xs text-muted-foreground"
        >
          {failed ? (
            <>
              <span>More banned accounts could not be loaded.</span>
              <Button size="sm" variant="outline" onClick={() => void loadMore()}>
                <RotateCcw className="size-3.5" />
                Retry
              </Button>
            </>
          ) : (
            <>
              <Loader2 className="size-3.5 motion-safe:animate-spin" />
              Loading more banned accounts…
            </>
          )}
        </div>
      )}
      {!hasMore && users.length > 0 && (
        <div className="border-t border-border/60 px-4 py-3 text-center text-[11px] text-muted-foreground">
          End of list — {total} banned {total === 1 ? "account" : "accounts"}.
        </div>
      )}
    </section>
  );
}
