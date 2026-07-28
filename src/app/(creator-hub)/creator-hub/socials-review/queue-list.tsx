"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  Check,
  ExternalLink,
  Instagram,
  Loader2,
  MessageCircle,
  Music2,
  Twitch,
  X,
  Youtube,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useHostHref } from "@/lib/use-app-host";
import type { AdminCreatorSocial, CreatorSocialStatus } from "@/lib/backend-api";

import { bulkReviewCreatorSocials } from "./actions";
import { RejectReasonPicker, SocialReviewActions } from "./review-actions";

/**
 * Client body of the Socials Review queue.
 *
 * Receives the server-fetched page of rows (serializable props only) and owns
 * the OPTIMISTIC layer: an approved/rejected row disappears immediately
 * (local hidden-set — the server refresh then drops it for real) and is
 * restored with an error toast if the action fails. Also owns row selection +
 * the bulk approve/reject bar (pending tab only).
 */

// Platform → icon + tint, mirroring the Hub roster card's PLATFORM_META
// (lucide has no brand icons for X/Kick/Discord — same stand-ins as there).
const PLATFORM_META: Record<
  string,
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

const STATUS_TONES: Record<CreatorSocialStatus, string> = {
  pending: "bg-amber-500/10 text-amber-600 dark:text-amber-300",
  approved: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
  rejected: "bg-red-500/10 text-red-600 dark:text-red-300",
};

// Hub-standard en-US date style (matches profitability lists), not the
// viewer-locale `toLocaleString()` the old page used.
const DATE_TIME_FMT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function initials(name: string | null): string {
  const clean = (name ?? "").trim();
  if (!clean) return "?";
  return clean.slice(0, 2).toUpperCase();
}

export function SocialsQueueList({ rows }: { rows: AdminCreatorSocial[] }) {
  const creatorsBase = useHostHref("/creator-hub/creators");

  // Optimistic removal: hidden ids vanish from the list instantly; a failed
  // action deletes the id again (restore). Server revalidation then makes the
  // successful removals real.
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(new Set());
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [bulkAction, setBulkAction] = useState<"approve" | "reject" | null>(
    null,
  );
  const [bulkRejectOpen, setBulkRejectOpen] = useState(false);
  const [bulkOtherReason, setBulkOtherReason] = useState("");

  const visibleRows = useMemo(
    () => rows.filter((row) => !hiddenIds.has(row.id)),
    [rows, hiddenIds],
  );
  const pendingRows = useMemo(
    () => visibleRows.filter((row) => row.status === "pending"),
    [visibleRows],
  );

  const hide = (id: string) =>
    setHiddenIds((prev) => new Set(prev).add(id));
  const restore = (id: string) =>
    setHiddenIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  const hideMany = (ids: string[]) =>
    setHiddenIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
  const restoreMany = (ids: string[]) =>
    setHiddenIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });

  const toggleSelected = (id: string, checked: boolean) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });

  const allSelected =
    pendingRows.length > 0 &&
    pendingRows.every((row) => selectedIds.has(row.id));

  const toggleAll = (checked: boolean) =>
    setSelectedIds(
      checked ? new Set(pendingRows.map((row) => row.id)) : new Set(),
    );

  const runBulk = async (
    action: "approve" | "reject",
    reason: string | undefined,
  ) => {
    const ids = pendingRows
      .filter((row) => selectedIds.has(row.id))
      .map((row) => row.id);
    if (ids.length === 0) return;
    setBulkAction(action);
    setBulkRejectOpen(false);
    hideMany(ids);
    try {
      const result = await bulkReviewCreatorSocials({ ids, action, reason });
      if (result.failed.length > 0) {
        restoreMany(result.failed.map((f) => f.id));
        toast.error(
          `${result.failed.length} of ${ids.length} failed: ${result.failed[0].message}`,
        );
      }
      if (result.succeeded.length > 0) {
        toast.success(
          `${result.succeeded.length} ${
            action === "approve" ? "approved" : "rejected"
          }`,
        );
      }
      setSelectedIds(new Set(result.failed.map((f) => f.id)));
      setBulkOtherReason("");
    } catch (err) {
      restoreMany(ids);
      toast.error(err instanceof Error ? err.message : "Bulk action failed");
    } finally {
      setBulkAction(null);
    }
  };

  const selectedCount = pendingRows.filter((row) =>
    selectedIds.has(row.id),
  ).length;
  const hasPending = pendingRows.length > 0;

  if (visibleRows.length === 0) {
    // Everything on this page was just actioned optimistically — the server
    // refresh brings the next page of rows (or the real empty state).
    return (
      <p className="mt-6 py-6 text-center text-xs text-muted-foreground">
        All submissions on this page have been reviewed.
      </p>
    );
  }

  return (
    <div>
      {hasPending && (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border bg-muted/30 px-3 py-2">
          <label className="flex cursor-pointer items-center gap-2 text-xs font-medium">
            <Checkbox
              checked={allSelected}
              onCheckedChange={(checked) => toggleAll(checked === true)}
              aria-label="Select all pending submissions on this page"
            />
            Select all
          </label>
          <span className="text-xs tabular-nums text-muted-foreground">
            {selectedCount} selected
          </span>
          {selectedCount > 0 && (
            <div className="ml-auto flex items-center gap-2">
              <Button
                size="sm"
                variant="default"
                disabled={bulkAction != null}
                onClick={() => runBulk("approve", undefined)}
              >
                {bulkAction === "approve" ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Check className="size-3.5" />
                )}
                Approve selected
              </Button>
              <Popover open={bulkRejectOpen} onOpenChange={setBulkRejectOpen}>
                <PopoverTrigger
                  render={
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={bulkAction != null}
                    >
                      {bulkAction === "reject" ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <X className="size-3.5" />
                      )}
                      Reject selected
                    </Button>
                  }
                />
                <PopoverContent align="end" className="w-64 p-2">
                  <RejectReasonPicker
                    otherReason={bulkOtherReason}
                    onOtherReasonChange={setBulkOtherReason}
                    onPick={(reason) => runBulk("reject", reason)}
                  />
                </PopoverContent>
              </Popover>
            </div>
          )}
        </div>
      )}

      <ul className={cn("divide-y", hasPending ? "mt-2" : "mt-4")}>
        {visibleRows.map((row) => {
          const meta = PLATFORM_META[row.platform];
          const PlatformIcon = meta?.icon ?? MessageCircle;
          const creatorName = row.creator_username ?? row.user_id;
          const isPending = row.status === "pending";
          return (
            <li
              key={row.id}
              className="flex flex-col gap-3 py-4 md:flex-row md:items-center md:justify-between"
            >
              <div className="flex min-w-0 items-start gap-3">
                {isPending && (
                  <Checkbox
                    className="mt-2.5"
                    checked={selectedIds.has(row.id)}
                    onCheckedChange={(checked) =>
                      toggleSelected(row.id, checked === true)
                    }
                    aria-label={`Select submission by ${creatorName}`}
                  />
                )}
                <Avatar className="size-9 shrink-0">
                  {row.creator_image ? (
                    <AvatarImage src={row.creator_image} alt={creatorName} />
                  ) : null}
                  <AvatarFallback className="text-xs font-semibold">
                    {initials(creatorName)}
                  </AvatarFallback>
                </Avatar>
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`${creatorsBase}/${row.user_id}`}
                      className="max-w-48 truncate text-sm font-semibold hover:underline"
                      title={creatorName}
                    >
                      {creatorName}
                    </Link>
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold",
                        meta?.color ?? "bg-muted text-muted-foreground",
                      )}
                    >
                      <PlatformIcon className="size-3" aria-hidden />
                      {meta?.label ?? row.platform}
                    </span>
                    <Badge
                      variant="outline"
                      className={cn("text-[10px]", STATUS_TONES[row.status])}
                    >
                      {row.status}
                    </Badge>
                  </div>
                  <div className="flex min-w-0 items-center gap-3 text-xs text-muted-foreground">
                    <span
                      className="max-w-56 truncate font-medium"
                      title={row.username}
                    >
                      {row.username}
                    </span>
                    {row.url ? (
                      // SECURITY (SECURITY_AUDIT.md LOW): only linkify http(s)
                      // URLs — a stored `javascript:` / `data:` URL in an href
                      // would execute on click. Anything else renders as text.
                      /^https?:\/\//i.test(row.url) ? (
                        <a
                          href={row.url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="inline-flex shrink-0 items-center gap-1 font-medium hover:underline"
                          title={row.url}
                        >
                          Open
                          <ExternalLink className="size-3" aria-hidden />
                        </a>
                      ) : (
                        <span className="max-w-48 truncate" title={row.url}>
                          {row.url}
                        </span>
                      )
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                    <span>
                      Submitted {DATE_TIME_FMT.format(new Date(row.submitted_at))}
                    </span>
                    {row.reviewed_at ? (
                      <span>
                        · Reviewed {DATE_TIME_FMT.format(new Date(row.reviewed_at))}
                      </span>
                    ) : null}
                    {row.rejection_reason ? (
                      <span
                        className="max-w-72 truncate text-red-500"
                        title={row.rejection_reason}
                      >
                        · Reason: {row.rejection_reason}
                      </span>
                    ) : null}
                  </div>
                </div>
              </div>

              {isPending ? (
                <SocialReviewActions
                  socialId={row.id}
                  onRemove={hide}
                  onRestore={restore}
                />
              ) : (
                <span className="text-xs italic text-muted-foreground">
                  Already reviewed
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
