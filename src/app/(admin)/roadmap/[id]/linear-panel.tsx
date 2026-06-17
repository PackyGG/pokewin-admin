"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, RefreshCw, X, ExternalLink, GitBranch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ux";
import { cn } from "@/lib/utils";
import type { RoadmapLinearLink } from "../types";
import { detachLinearIssue, refreshLinearStatus } from "../actions";
import { LinearAttachDialog } from "./linear-attach-dialog";
import { LinearCreateDialog } from "./linear-create-dialog";

// Status chip color keyed on Linear's stable state TYPE (not the free-text
// state name / hex color, so it stays on the house Tailwind palette).
const STATE_STYLE: Record<string, string> = {
  triage: "bg-slate-500/15 text-slate-600 dark:text-slate-300 border-slate-500/30",
  backlog: "bg-slate-500/15 text-slate-600 dark:text-slate-300 border-slate-500/30",
  unstarted: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  started: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
  completed:
    "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  canceled: "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30",
};

function stateStyle(type: string | null): string {
  return (
    (type && STATE_STYLE[type]) ??
    "bg-muted text-muted-foreground border-border"
  );
}

export function LinearPanel({
  itemId,
  links,
  canCreateLinear,
}: {
  itemId: string;
  links: RoadmapLinearLink[];
  canCreateLinear: boolean;
}) {
  const router = useRouter();
  const [attachOpen, setAttachOpen] = React.useState(false);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [detachingId, setDetachingId] = React.useState<string | null>(null);

  async function refresh() {
    setRefreshing(true);
    try {
      const r = await refreshLinearStatus(itemId);
      if (!r.success) {
        toast.error(r.error);
        return;
      }
      toast.success("Status refreshed");
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to refresh");
    } finally {
      setRefreshing(false);
    }
  }

  async function detach(id: string) {
    setDetachingId(id);
    try {
      const r = await detachLinearIssue(id);
      if (!r.success) {
        toast.error(r.error);
        return;
      }
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to detach");
    } finally {
      setDetachingId(null);
    }
  }

  return (
    <div className="rounded-2xl border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-center justify-end gap-2">
        {links.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            onClick={refresh}
            disabled={refreshing}
          >
            <RefreshCw
              className={cn("size-3.5", refreshing && "motion-safe:animate-spin")}
            />
            Refresh status
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={() => setAttachOpen(true)}>
          <Plus className="size-4" />
          Attach issue
        </Button>
        {canCreateLinear && (
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <GitBranch className="size-4" />
            Create Linear task
          </Button>
        )}
      </div>

      {links.length > 0 ? (
        <ul className="divide-y divide-border/60">
          {links.map((l) => (
            <li key={l.id} className="group flex items-center gap-3 py-2.5">
              <a
                href={l.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex min-w-0 flex-1 items-center gap-3 hover:underline"
              >
                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                  {l.identifier}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm">
                  {l.title}
                </span>
                <ExternalLink
                  className="size-3.5 shrink-0 text-muted-foreground"
                  aria-hidden
                />
              </a>
              {l.assigneeName && (
                <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                  {l.assigneeName}
                </span>
              )}
              {l.stateName && (
                <span
                  className={cn(
                    "shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium",
                    stateStyle(l.stateType),
                  )}
                >
                  {l.stateName}
                </span>
              )}
              <Button
                size="icon"
                variant="ghost"
                onClick={() => detach(l.id)}
                disabled={detachingId !== null}
                aria-label={`Detach ${l.identifier}`}
                className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-rose-500 group-hover:opacity-100"
              >
                {detachingId === l.id ? (
                  <Spinner size={14} />
                ) : (
                  <X className="size-4" />
                )}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          No Linear tasks linked yet. Attach an existing issue
          {canCreateLinear ? " or create a new one" : ""}.
        </p>
      )}

      <LinearAttachDialog
        itemId={itemId}
        open={attachOpen}
        onOpenChange={setAttachOpen}
      />
      {canCreateLinear && (
        <LinearCreateDialog
          itemId={itemId}
          open={createOpen}
          onOpenChange={setCreateOpen}
        />
      )}
    </div>
  );
}
