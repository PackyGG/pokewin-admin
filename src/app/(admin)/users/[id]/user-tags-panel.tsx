"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Crown,
  Phone,
  X,
  Check,
  Tag as TagIcon,
  ShieldAlert,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
 * VIP tag manager — renders the user's current tags inline + a small
 * "manage" affordance that toggles each tag's assignment. Only shown
 * to admins / users with __can_manage_user_tags. For viewers without
 * the capability, only the existing tag badges render (read-only).
 *
 * Tag state is mirrored locally on click so the UI feels instant; we
 * also `router.refresh()` after each action so the audit log / other
 * server-driven views pick up the change.
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
  const [tags, setTags] = useState<UserTagRow[]>(initialTags);
  const [pendingTag, setPendingTag] = useState<UserTagValue | null>(null);
  const [isPending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);

  const tagSet = new Set(tags.map((t) => t.tag));

  function handleToggle(tag: UserTagValue) {
    if (isPending) return;
    const isOn = tagSet.has(tag);
    setPendingTag(tag);
    startTransition(async () => {
      try {
        const result = isOn
          ? await removeUserTag(userId, tag)
          : await setUserTag(userId, tag);
        if (!result.success) {
          toast.error(result.error);
          return;
        }
        // Optimistic local update — the router.refresh below will
        // overwrite from the server when it arrives, but this keeps
        // the badge state in sync with the toggle click immediately.
        setTags((prev) => {
          if (isOn) return prev.filter((t) => t.tag !== tag);
          return [
            ...prev,
            {
              tag,
              setByAdminId: "",
              setByAdminUsername: null,
              createdAt: new Date().toISOString(),
            },
          ];
        });
        toast.success(isOn ? "Tag removed" : "Tag added");
        router.refresh();
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Failed to update tag",
        );
      } finally {
        setPendingTag(null);
      }
    });
  }

  // Read-only path for viewers without the capability — just render
  // the existing tags as badges with a tooltip showing who/when.
  if (!canManage) {
    if (tags.length === 0) return null;
    return (
      <TooltipProvider>
        <div className="flex flex-wrap items-center gap-1.5">
          {tags.map((t) => {
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

  // Managed path — explicit "Tags:" label so admins notice the
  // section, even on profiles where no tag has been set yet. Click a
  // badge to remove it, click the "Tag user" button to open the add-
  // tag tray.
  const noUntagged = !ALL_TAGS.some((t) => !tagSet.has(t));

  return (
    <TooltipProvider>
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border bg-muted/30 px-3 py-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <TagIcon className="size-3.5" />
          Tags:
        </span>

        {/* Currently-set tags — clicking removes them */}
        {tags.length === 0 && (
          <span className="text-xs text-muted-foreground italic">
            None yet
          </span>
        )}
        {tags.map((t) => {
          const meta = TAG_META[t.tag];
          const Icon = meta.icon;
          const isLoading = pendingTag === t.tag;
          return (
            <Tooltip key={t.tag}>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={() => handleToggle(t.tag)}
                    disabled={isPending}
                    className="group"
                  />
                }
              >
                <Badge
                  variant="outline"
                  className={cn(
                    "gap-1 transition-opacity",
                    meta.color,
                    isLoading && "opacity-50",
                    "group-hover:pr-1",
                  )}
                >
                  <Icon className="size-3" />
                  {meta.label}
                  <X className="size-3 opacity-0 transition-opacity group-hover:opacity-100" />
                </Badge>
              </TooltipTrigger>
              <TooltipContent>
                Set by {t.setByAdminUsername ?? "unknown"} ·{" "}
                {formatDateTime(t.createdAt)} — click to remove
              </TooltipContent>
            </Tooltip>
          );
        })}

        {/* "Add tag" trigger — only shows when at least one tag in
            ALL_TAGS isn't already set on this user. */}
        {!noUntagged && (
          <>
            {!open ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setOpen(true)}
                disabled={isPending}
                className="h-7 gap-1 px-2.5 text-xs"
              >
                <TagIcon className="size-3.5" />
                {tags.length === 0 ? "Tag user" : "Add tag"}
              </Button>
            ) : (
              <>
                {ALL_TAGS.filter((t) => !tagSet.has(t)).map((tag) => {
                  const meta = TAG_META[tag];
                  const isLoading = pendingTag === tag;
                  return (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => {
                        handleToggle(tag);
                        setOpen(false);
                      }}
                      disabled={isPending}
                      className={cn(
                        "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium transition-colors",
                        meta.color,
                        isLoading && "opacity-50",
                        "hover:brightness-110",
                      )}
                    >
                      <Check className="size-3" />
                      {meta.label}
                    </button>
                  );
                })}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setOpen(false)}
                  className="h-7 px-1.5 text-muted-foreground"
                >
                  <X className="size-3.5" />
                </Button>
              </>
            )}
          </>
        )}
      </div>
    </TooltipProvider>
  );
}
