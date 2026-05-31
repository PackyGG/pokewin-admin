"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  Plus,
  VolumeX,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateTime, formatRelative } from "@/lib/utils/format";
import type { MuteItem } from "@/lib/queries/chat";
import {
  fetchMutesPanel,
  muteUser,
  unmuteUser,
} from "@/app/(admin)/chat/actions";

const PAGE_SIZE = 20;

/**
 * Mutes tab: paginated list of active + past mutes with an "Unmute" action
 * on active rows and a "Mute user" dialog for creating new mutes by user id.
 * Uses local pagination (not URL state) so the panel coexists with whatever
 * the host page has in the query string.
 */
export function ChatPanelMutes({ role }: { role: string }) {
  const canMute = role === "admin" || role === "support";
  const [mutes, setMutes] = useState<MuteItem[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [isPending, startTransition] = useTransition();

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchMutesPanel({ page, perPage: PAGE_SIZE })
      .then((res) => {
        if (!alive) return;
        setMutes(res.data);
        setTotalPages(res.totalPages);
        setTotal(res.total);
      })
      .catch(() => {
        if (alive) toast.error("Failed to load mutes");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [page, refreshKey]);

  function handleUnmute(muteId: string) {
    startTransition(async () => {
      try {
        await unmuteUser(muteId);
        toast.success("User unmuted");
        refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed");
      }
    });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-2">
        <p className="text-xs text-muted-foreground">
          {loading ? "Loading..." : `${total} mute${total !== 1 ? "s" : ""}`}
        </p>
        {canMute && <MuteByIdDialog onDone={refresh} />}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <MutesSkeleton />
        ) : mutes.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">
            No mutes recorded yet.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {mutes.map((m) => {
              const active = !m.unmutedAt;
              const expired =
                active && m.expiresAt && new Date(m.expiresAt) < new Date();
              return (
                <li
                  key={m.id}
                  className="flex items-start gap-3 px-4 py-3 text-sm"
                >
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-bold text-muted-foreground">
                    {(m.username ?? "?")[0].toUpperCase()}
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/users/${m.userId}`}
                        className="font-medium hover:underline"
                      >
                        {m.username ?? m.userId.slice(0, 8)}
                      </Link>
                      {m.unmutedAt ? (
                        <Badge
                          variant="outline"
                          className="border-emerald-500/30 bg-emerald-500/15 text-emerald-400"
                        >
                          Unmuted
                        </Badge>
                      ) : expired ? (
                        <Badge
                          variant="outline"
                          className="border-amber-500/30 bg-amber-500/15 text-amber-400"
                        >
                          Expired
                        </Badge>
                      ) : (
                        <Badge
                          variant="outline"
                          className="border-rose-500/30 bg-rose-500/15 text-rose-400"
                        >
                          Active
                        </Badge>
                      )}
                      <span
                        className="text-xs text-muted-foreground"
                        title={formatDateTime(m.createdAt)}
                      >
                        {formatRelative(m.createdAt)}
                      </span>
                    </div>
                    <p className="break-words text-xs text-muted-foreground">
                      {m.reason ?? "No reason given"}
                    </p>
                    <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                      <span>
                        By:{" "}
                        <span className="text-foreground/80">
                          {m.mutedByUsername ?? "—"}
                        </span>
                      </span>
                      <span>
                        Expires:{" "}
                        <span className="text-foreground/80">
                          {m.expiresAt ? formatDateTime(m.expiresAt) : "Permanent"}
                        </span>
                      </span>
                    </div>
                  </div>
                  {canMute && active && !expired && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleUnmute(m.id)}
                      disabled={isPending}
                      className="shrink-0"
                    >
                      Unmute
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {!loading && totalPages > 1 && (
        <div className="flex shrink-0 items-center justify-between border-t border-border px-4 py-2 text-xs text-muted-foreground">
          <span>
            Page {page} of {totalPages}
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              className="size-7"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              aria-label="Previous page"
            >
              <ChevronLeft className="size-3.5" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="size-7"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              aria-label="Next page"
            >
              <ChevronRight className="size-3.5" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function MutesSkeleton() {
  return (
    <ul className="divide-y divide-border">
      {Array.from({ length: 6 }).map((_, i) => (
        <li key={i} className="flex items-start gap-3 px-4 py-3">
          <Skeleton className="size-8 shrink-0 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-3 w-48" />
            <Skeleton className="h-3 w-24" />
          </div>
        </li>
      ))}
    </ul>
  );
}

function MuteByIdDialog({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [userId, setUserId] = useState("");
  const [reason, setReason] = useState("");
  const [expires, setExpires] = useState("");
  const [pending, start] = useTransition();
  const router = useRouter();

  function handle() {
    if (!userId.trim()) {
      toast.error("Please enter a user ID");
      return;
    }
    // `<input type="datetime-local">` returns "YYYY-MM-DDTHH:mm" with
    // no seconds and no timezone. The server action's
    // `z.string().datetime()` schema needs strict ISO-8601 (with Z or
    // +HH:MM offset), so a non-empty expires would otherwise be
    // rejected at the schema layer and the mute would silently fail.
    // Run it through `new Date(...).toISOString()` to normalize.
    let expiresAt: string | null = null;
    if (expires) {
      const d = new Date(expires);
      if (Number.isNaN(d.getTime())) {
        toast.error("Invalid expires date");
        return;
      }
      expiresAt = d.toISOString();
    }
    start(async () => {
      try {
        await muteUser({
          userId: userId.trim(),
          reason,
          expiresAt,
        });
        toast.success(
          expiresAt
            ? `Muted until ${new Date(expiresAt).toLocaleString()}`
            : "User muted (permanent)",
        );
        setOpen(false);
        setUserId("");
        setReason("");
        setExpires("");
        onDone();
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button size="sm" variant="outline" className="h-8 gap-1.5">
            <Plus className="size-3.5" />
            Mute user
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <VolumeX className="size-4" />
            Mute User
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>User ID</Label>
            <Input
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              placeholder="User ID"
            />
          </div>
          <div className="space-y-1">
            <Label>Reason</Label>
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Optional reason"
            />
          </div>
          <div className="space-y-1">
            <Label>Expires at (optional)</Label>
            <Input
              type="datetime-local"
              value={expires}
              onChange={(e) => setExpires(e.target.value)}
            />
          </div>
          <Button onClick={handle} disabled={pending} className="w-full">
            {pending ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                Muting…
              </>
            ) : (
              "Mute"
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
