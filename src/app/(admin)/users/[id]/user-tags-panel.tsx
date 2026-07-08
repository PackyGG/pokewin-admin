"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  Crown,
  Tag as TagIcon,
  ShieldAlert,
  ChevronDown,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { formatDateTime } from "@/lib/utils/format";
import { setUserTag, removeUserTag } from "./actions";
import type { UserTagRow, UserTagValue } from "@/lib/queries/user-tags";

const TAG_META: Record<
  UserTagValue,
  { label: string; icon: typeof Crown; color: string }
> = {
  // VIP. Purple reads as "premium".
  vip: {
    label: "VIP",
    icon: Crown,
    color:
      "border-purple-500/30 bg-purple-500/15 text-purple-700 dark:text-purple-300",
  },
  wager_abuser: {
    label: "Wager Abuser",
    icon: ShieldAlert,
    color:
      "border-red-500/30 bg-red-500/15 text-red-700 dark:text-red-300",
  },
};

const ALL_TAGS: UserTagValue[] = ["vip", "wager_abuser"];

/**
 * VIP tag manager.
 *
 * Managed path (admins / `__can_manage_user_tags`): a select/deselect
 * DROPDOWN. The operator opens it, toggles each available tag with a
 * checkbox, and presses Save — which diffs the staged selection against
 * the user's current tags and fires ONLY the delta through the existing
 * `setUserTag` / `removeUserTag` server actions (no new mutations, no new
 * tag types). On success it updates a LOCAL committed set optimistically —
 * no `router.refresh()`. The server actions revalidate the per-user
 * `users-detail-${userId}` cache tag, so the audit log + every server-driven
 * tag view stays consistent WITHOUT the full-route re-render that used to
 * lose the admin's scroll position (see use-toggle-action.ts rationale).
 *
 * Read-only path (viewers without the capability): just the existing tag
 * badges with a who/when tooltip — no dropdown, no Save.
 *
 * Designed to sit in the hero quick-action cluster next to "Add note", so
 * the trigger mirrors the cluster's `variant="outline" size="sm"` buttons.
 */
export function UserTagsPanel({
  userId,
  initialTags,
  canManage,
}: {
  userId: string;
  initialTags: UserTagRow[];
  canManage: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [isSaving, startTransition] = useTransition();

  // Server-truth seed from the prop. When the narrow `users-detail-${userId}`
  // revalidation streams fresh `initialTags` in, we re-sync the committed set
  // to it (effect below) — but a successful Save updates it optimistically
  // FIRST so the badge count flips instantly, no `router.refresh()`.
  const serverSet = useMemo(
    () => new Set(initialTags.map((t) => t.tag)),
    [initialTags],
  );

  // The committed, locally-tracked set of tags. Seeded from the server prop
  // and updated optimistically on a successful Save. Re-synced to the server
  // prop whenever a real revalidation streams a new value in (never while a
  // Save is mid-flight, so an in-progress optimistic update isn't clobbered).
  const [currentSet, setCurrentSet] = useState<Set<UserTagValue>>(serverSet);
  useEffect(() => {
    if (isSaving) return;
    setCurrentSet(serverSet);
  }, [serverSet, isSaving]);

  // Staged selection inside the open dropdown. Seeded from the committed set
  // every time the dropdown opens so a cancelled edit never sticks.
  const [staged, setStaged] = useState<Set<UserTagValue>>(currentSet);

  function handleOpenChange(next: boolean) {
    if (next) {
      // Re-seed the staged selection from the latest committed state.
      setStaged(new Set(currentSet));
    }
    setOpen(next);
  }

  function toggleStaged(tag: UserTagValue) {
    setStaged((prev) => {
      const nextSet = new Set(prev);
      if (nextSet.has(tag)) nextSet.delete(tag);
      else nextSet.add(tag);
      return nextSet;
    });
  }

  // Delta between staged and committed — drives the Save button enabled
  // state + the per-tag add/remove calls.
  const toAdd = ALL_TAGS.filter((t) => staged.has(t) && !currentSet.has(t));
  const toRemove = ALL_TAGS.filter((t) => !staged.has(t) && currentSet.has(t));
  const hasChanges = toAdd.length > 0 || toRemove.length > 0;

  function handleSave() {
    if (isSaving || !hasChanges) return;
    // Snapshot the committed set so a partial failure can roll back to the
    // exact tags that ARE persisted (each successful delta call is applied to
    // the optimistic set as it lands, so we never over- or under-count).
    const committedBefore = new Set(currentSet);
    const optimistic = new Set(currentSet);
    startTransition(async () => {
      try {
        // Apply the delta through the existing actions. Each returns a
        // result object (never throws for handled failures); we surface the
        // first failure and stop so the staged selection still reflects the
        // operator's intent for a retry. We advance the optimistic set per
        // successful call, then commit it — no `router.refresh()`, so the
        // page never re-suspends / loses scroll (the actions bust the
        // per-user cache tag to keep the server in sync).
        for (const tag of toRemove) {
          const result = await removeUserTag(userId, tag);
          if (!result.success) {
            setCurrentSet(new Set(optimistic));
            toast.error(result.error);
            return;
          }
          optimistic.delete(tag);
        }
        for (const tag of toAdd) {
          const result = await setUserTag(userId, tag);
          if (!result.success) {
            setCurrentSet(new Set(optimistic));
            toast.error(result.error);
            return;
          }
          optimistic.add(tag);
        }
        setCurrentSet(new Set(optimistic));
        toast.success("Tags updated");
        setOpen(false);
      } catch (err) {
        // Unexpected throw — roll back to what was persisted before.
        setCurrentSet(committedBefore);
        toast.error(
          err instanceof Error ? err.message : "Failed to update tags",
        );
      }
    });
  }

  // Read-only path for viewers without the capability — just render the
  // existing tags as badges with a tooltip showing who/when.
  if (!canManage) {
    if (initialTags.length === 0) return null;
    return (
      <TooltipProvider>
        <div className="flex flex-wrap items-center gap-1.5">
          {initialTags.map((t) => {
            const meta = TAG_META[t.tag];
            const Icon = meta.icon;
            return (
              <Tooltip key={t.tag}>
                <TooltipTrigger
                  render={
                    <Badge
                      variant="outline"
                      className={cn("gap-1 cursor-help", meta.color)}
                    />
                  }
                >
                  <Icon className="size-3" />
                  {meta.label}
                </TooltipTrigger>
                <TooltipContent>
                  Set by {t.setByAdminUsername ?? "unknown"} ·{" "}
                  {formatDateTime(t.createdAt)}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      </TooltipProvider>
    );
  }

  const activeCount = currentSet.size;

  // Managed path — a select/deselect dropdown + Save button. The trigger
  // mirrors the hero quick-action buttons (outline / sm) and shows how many
  // tags are currently set.
  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5"
            title="Manage VIP / abuse tags"
          />
        }
      >
        <TagIcon className="size-3.5" />
        Tags
        {activeCount > 0 && (
          <span className="ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground tabular-nums">
            {activeCount}
          </span>
        )}
        <ChevronDown className="size-3.5 opacity-70" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60 p-1.5">
        <p className="px-1.5 py-1 text-xs font-medium text-muted-foreground">
          Select tags for this user
        </p>
        <div className="space-y-0.5">
          {ALL_TAGS.map((tag) => {
            const meta = TAG_META[tag];
            const Icon = meta.icon;
            const checked = staged.has(tag);
            return (
              <label
                key={tag}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1.5 transition-colors hover:bg-accent",
                  isSaving && "pointer-events-none opacity-60",
                )}
              >
                <Checkbox
                  checked={checked}
                  onCheckedChange={() => toggleStaged(tag)}
                  disabled={isSaving}
                />
                <Badge
                  variant="outline"
                  className={cn("gap-1 font-medium", meta.color)}
                >
                  <Icon className="size-3" />
                  {meta.label}
                </Badge>
              </label>
            );
          })}
        </div>
        <div className="mt-1.5 flex items-center justify-end gap-1.5 border-t border-border/60 pt-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2.5 text-xs"
            onClick={() => setOpen(false)}
            disabled={isSaving}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-7 px-3 text-xs"
            onClick={handleSave}
            disabled={!hasChanges || isSaving}
          >
            {isSaving ? "Saving…" : "Save"}
          </Button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
