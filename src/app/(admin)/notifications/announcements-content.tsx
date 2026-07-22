"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, Megaphone, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/empty-state";
import { formatDateTime } from "@/lib/utils/format";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { createAnnouncementAction, revokeAnnouncementAction } from "./actions";
import type {
  Announcement,
  AnnouncementAudienceRole,
  AnnouncementCreateCategory,
} from "@/lib/backend-api/announcements";

const AUDIENCE_OPTIONS: { value: AnnouncementAudienceRole; label: string }[] = [
  { value: "user", label: "Users" },
  { value: "support", label: "Support staff" },
  { value: "admin", label: "Admins" },
  { value: "creator", label: "Creators" },
];

function audienceLabel(roles: AnnouncementAudienceRole[] | null): string {
  if (!roles || roles.length === 0) return "Everyone";
  return roles
    .map((r) => AUDIENCE_OPTIONS.find((o) => o.value === r)?.label ?? r)
    .join(", ");
}

function announcementStatus(a: Announcement): {
  label: string;
  className: string;
} {
  if (a.revoked_at) {
    return {
      label: "Revoked",
      className: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400",
    };
  }
  const now = Date.now();
  const starts = new Date(a.starts_at).getTime();
  const ends = a.ends_at ? new Date(a.ends_at).getTime() : null;
  if (starts > now) {
    return {
      label: "Scheduled",
      className: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
    };
  }
  if (ends != null && ends <= now) {
    return {
      label: "Ended",
      className: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400",
    };
  }
  return {
    label: "Active",
    className: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  };
}

export function AnnouncementsContent({
  announcements,
  total,
  page,
  perPage,
  loadError,
  canManage,
}: {
  announcements: Announcement[];
  total: number;
  page: number;
  perPage: number;
  loadError: string | null;
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
  const colCount = canManage ? 6 : 5;

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

      <div className="rounded-md border overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead>Audience</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Status</TableHead>
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
              return (
                <TableRow key={a.id}>
                  <TableCell className="max-w-[320px]">
                    <p className="truncate font-medium">{a.title}</p>
                    {a.body && (
                      <p className="truncate text-xs text-muted-foreground">
                        {a.body}
                      </p>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">
                    {audienceLabel(a.audience_roles)}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="capitalize">
                      {a.category}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={status.className}>
                      {status.label}
                    </Badge>
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

function CreateAnnouncementDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [category, setCategory] = useState<AnnouncementCreateCategory>("news");
  const [everyoneAudience, setEveryoneAudience] = useState(true);
  const [audienceRoles, setAudienceRoles] = useState<Set<AnnouncementAudienceRole>>(
    () => new Set(),
  );
  const [endsAt, setEndsAt] = useState("");
  const [isPending, startTransition] = useTransition();

  function reset() {
    setTitle("");
    setBody("");
    setAdvancedOpen(false);
    setCategory("news");
    setEveryoneAudience(true);
    setAudienceRoles(new Set());
    setEndsAt("");
  }

  function handleOpenChange(v: boolean) {
    onOpenChange(v);
    if (!v) reset();
  }

  function toggleRole(role: AnnouncementAudienceRole) {
    setAudienceRoles((prev) => {
      const next = new Set(prev);
      if (next.has(role)) next.delete(role);
      else next.add(role);
      return next;
    });
  }

  function handleSubmit() {
    if (!title.trim()) {
      toast.error("Title is required");
      return;
    }
    if (!everyoneAudience && audienceRoles.size === 0) {
      toast.error("Pick at least one audience role, or choose Everyone");
      return;
    }
    startTransition(async () => {
      const result = await createAnnouncementAction({
        title: title.trim(),
        body: body.trim() || null,
        category,
        audienceRoles: everyoneAudience ? null : [...audienceRoles],
        endsAt: endsAt ? new Date(endsAt).toISOString() : null,
      });
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success("Announcement published");
      handleOpenChange(false);
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New announcement</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Title</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Scheduled maintenance tonight"
              disabled={isPending}
              autoFocus
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              Message (optional)
            </Label>
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={3}
              placeholder="More detail shown when a user opens it"
              disabled={isPending}
            />
          </div>
          <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2">
            <span className="text-sm font-medium">Sends to</span>
            <span className="text-sm text-muted-foreground">
              {everyoneAudience ? "Everyone" : audienceLabel([...audienceRoles])}
            </span>
          </div>

          <button
            type="button"
            onClick={() => setAdvancedOpen((v) => !v)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {advancedOpen ? (
              <ChevronDown className="size-3" />
            ) : (
              <ChevronRight className="size-3" />
            )}
            Advanced options
          </button>

          {advancedOpen && (
            <div className="space-y-3 rounded-md border p-3">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Audience</Label>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={everyoneAudience}
                    onCheckedChange={(v) => setEveryoneAudience(Boolean(v))}
                  />
                  Everyone
                </label>
                {!everyoneAudience && (
                  <div className="ml-6 space-y-1">
                    {AUDIENCE_OPTIONS.map((o) => (
                      <label
                        key={o.value}
                        className="flex items-center gap-2 text-sm"
                      >
                        <Checkbox
                          checked={audienceRoles.has(o.value)}
                          onCheckedChange={() => toggleRole(o.value)}
                        />
                        {o.label}
                      </label>
                    ))}
                  </div>
                )}
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Category</Label>
                <Select
                  value={category}
                  onValueChange={(v) => setCategory(v as AnnouncementCreateCategory)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="news">News</SelectItem>
                    <SelectItem value="system">System</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">
                  Ends at (optional)
                </Label>
                <Input
                  type="datetime-local"
                  value={endsAt}
                  onChange={(e) => setEndsAt(e.target.value)}
                  disabled={isPending}
                />
                <p className="text-[11px] text-muted-foreground">
                  Leave empty to run until manually revoked.
                </p>
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => handleOpenChange(false)}
            disabled={isPending}
            className="w-full sm:w-auto"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isPending || !title.trim()}
            className="w-full sm:w-auto"
          >
            {isPending ? "Publishing..." : "Publish"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
