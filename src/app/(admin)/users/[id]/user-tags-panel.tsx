"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Crown,
  Phone,
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
  { label: string; icon: typeof Phone; color: string }
> = {
  // Contacted = first-touch signal. Amber reads as "in progress".
  contacted_vip: {
    label: "Contacted VIP",
    icon: Phone,
    color:
      "border-amber-500/30 bg-amber-500/15 text-amber-700 dark:text-amber-300",
  },
  // Confirmed = verified VIP. Purple reads as "premium".
  confirmed_vip: {
    label: "Confirmed VIP",
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
  fraud_abuser: {
    label: "Fraud Abuser",
    icon: ShieldAlert,
    color:
      "border-rose-600/30 bg-rose-600/15 text-rose-800 dark:text-rose-300",
  },
};

const ALL_TAGS: UserTagValue[] = [
  "contacted_vip",
  "confirmed_vip",
  "wager_abuser",
  "fraud_abuser",
];

/**
 * VIP tag manager.
 *
 * Managed path (admins / `__can_manage_user_tags`): a select/deselect
 * DROPDOWN. The operator opens it, toggles each available tag with a
 * checkbox, and presses Save — which diffs the staged selection against
 * the user's current tags and fires ONLY the delta through the existing
 * `setUserTag` / `removeUserTag` server actions (no new mutations, no new
 * tag types). On success it `router.refresh()`es so the audit log + every
 * server-driven tag view picks up the change.
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
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isSaving, startTransition] = useTransition();

  // The committed, server-known set of tags. Updated optimistically after a
  // successful Save; router.refresh() then re-seeds it from the server.
  const currentSet = useMemo(
    () => new Set(initialTags.map((t) => t.tag)),
    [initialTags],
  );

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
    startTransition(async () => {
      try {
        // Apply the delta through the existing actions. Each returns a
        // result object (never throws for handled failures); we surface the
        // first failure and stop so the staged selection still reflects the
        // operator's intent for a retry.
        for (const tag of toRemove) {
          const result = await removeUserTag(userId, tag);
          if (!result.success) {
            toast.error(result.error);
            return;
          }
        }
        for (const tag of toAdd) {
          const result = await setUserTag(userId, tag);
          if (!result.success) {
            toast.error(result.error);
            return;
          }
        }
        toast.success("Tags updated");
        setOpen(false);
        router.refresh();
      } catch (err) {
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
