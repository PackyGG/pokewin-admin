"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  CheckCheck,
  ExternalLink,
  Info,
  Megaphone,
  Plus,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/empty-state";
import { formatDateTime, formatNumber } from "@/lib/utils/format";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { shortUrlLabel } from "@/lib/announcement-payload";
import { revokeAnnouncementAction } from "./actions";
import { announcementStatus } from "./announcement-status";
import {
  CreateAnnouncementDialog,
  audienceLabel,
} from "./create-announcement-dialog";
import type { Announcement } from "@/lib/backend-api/announcements";

export function AnnouncementsContent({
  announcements,
  total,
  page,
  perPage,
  loadError,
  readCounts,
  readCountsUnavailable,
  canManage,
}: {
  announcements: Announcement[];
  total: number;
  page: number;
  perPage: number;
  loadError: string | null;
  readCounts: Record<string, number>;
  readCountsUnavailable: boolean;
  canManage: boolean;
}) {
  const router = useRouter();
  const [rows, setRows] = useState(announcements);
  const [createOpen, setCreateOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [revokingId, setRevokingId] = useState<string | null>(null);

  // Re-sync to the server-fetched list on navigation (paging) — mirrors the
  // optimistic-local-copy pattern used across the admin (e.g. geo-blocking).
  useEffect(() => {
    setRows(announcements);
  }, [announcements]);

  function handleRevoke(a: Announcement) {
    if (
      !confirm(
        `Revoke "${a.title}"? Users will stop seeing it immediately.`,
      )
    ) {
      return;
    }
    setRevokingId(a.id);
    startTransition(async () => {
      const result = await revokeAnnouncementAction(a.id);
      setRevokingId(null);
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success("Announcement revoked");
      setRows((rs) =>
        rs.map((r) =>
          r.id === a.id ? { ...r, revoked_at: new Date().toISOString() } : r,
        ),
      );
      router.refresh();
    });
  }

  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const colCount = canManage ? 7 : 6;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {total} announcement{total === 1 ? "" : "s"} total
        </p>
        {canManage && (
          <Button size="sm" className="gap-1.5" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            New announcement
          </Button>
        )}
      </div>

      <div className="flex items-start gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <Info className="mt-0.5 size-3.5 shrink-0" />
        <p>
          <span className="font-medium text-foreground">Marked read</span> is
          recorded by the site. It is not a guaranteed impression, time viewed,
          or link click.
        </p>
      </div>

      <div className="rounded-md border overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead>Audience</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Marked read</TableHead>
              <TableHead>Created</TableHead>
              {canManage && <TableHead className="w-[100px]" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={colCount} className="p-0">
                  <EmptyState
                    icon={Megaphone}
                    title={
                      loadError
                        ? "Couldn't load announcements"
                        : "No announcements yet"
                    }
                    description={
                      loadError
                        ? "The request failed or timed out — refresh to retry."
                        : "Create one to broadcast a message to all users."
                    }
                    compact
                  />
                </TableCell>
              </TableRow>
            )}
            {rows.map((a) => {
              const status = announcementStatus(a);
              const imageUrl = a.payload?.image_url;
              const url = a.payload?.url;
              const ctaLabel = a.payload?.cta_label;
              return (
                <TableRow key={a.id}>
                  <TableCell className="max-w-[380px]">
                    <div className="flex items-start gap-2">
                      {imageUrl && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={imageUrl}
                          alt=""
                          className="size-9 shrink-0 rounded border object-contain"
                        />
                      )}
                      <div className="min-w-0">
                        <p className="truncate font-medium">{a.title}</p>
                        {a.body && (
                          <p className="truncate text-xs text-muted-foreground">
                            {a.body}
                          </p>
                        )}
                        {(url || ctaLabel) && (
                          <div className="mt-1 flex flex-wrap items-center gap-1.5">
                            {ctaLabel && (
                              <Badge
                                variant="outline"
                                className="px-1.5 py-0 text-[10px]"
                              >
                                {ctaLabel}
                              </Badge>
                            )}
                            {url && (
                              <a
                                href={url}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                                title={url}
                              >
                                <ExternalLink className="size-3" />
                                {shortUrlLabel(url)}
                              </a>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-sm">
                    {audienceLabel(a.audience_roles)}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col items-start gap-1">
                      <Badge variant="outline" className="capitalize">
                        {a.category}
                      </Badge>
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {a.type}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={status.className}>
                      {status.label}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {readCountsUnavailable ? (
                      <span
                        className="text-xs text-muted-foreground"
                        title="Read counts could not be loaded. Refresh to retry."
                      >
                        Unavailable
                      </span>
                    ) : (
                      <span
                        className="inline-flex items-center justify-end gap-1.5 text-sm font-medium tabular-nums"
                        title="Users for whom the site recorded this announcement as read"
                      >
                        <CheckCheck className="size-3.5 text-emerald-600 dark:text-emerald-400" />
                        {formatNumber(readCounts[a.id] ?? 0)}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {formatDateTime(a.created_at)}
                  </TableCell>
                  {canManage && (
                    <TableCell>
                      {!a.revoked_at && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 gap-1 text-muted-foreground hover:text-rose-600"
                          disabled={isPending && revokingId === a.id}
                          onClick={() => handleRevoke(a)}
                        >
                          <Trash2 className="size-3" />
                          Revoke
                        </Button>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <DataTablePagination
        page={page}
        totalPages={totalPages}
        total={total}
        perPage={perPage}
        degraded={loadError != null}
      />

      {canManage && (
        <CreateAnnouncementDialog open={createOpen} onOpenChange={setCreateOpen} />
      )}
    </div>
  );
}
