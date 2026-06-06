"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import {
  Check,
  ExternalLink,
  Info,
  Loader2,
  MessageSquare,
  Pencil,
  Save,
  Trash2,
  Tv,
  Twitter,
  X,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import {
  removeCreatorSocial,
  upsertCreatorSocial,
} from "./creator-tab-actions";

/**
 * In-place editor for a creator's social links, rendered inside the
 * `creators/[id]` **Creator** tab.
 *
 * Owner spec lists four links: **Twitter / Kick / Discord ID / Reward page**.
 *   • Twitter, Kick, Discord ID are real `creator_socials` platforms → fully
 *     editable here (save / clear), writing the admin DB via the
 *     `upsertCreatorSocial` / `removeCreatorSocial` server actions.
 *   • **Reward page** has NO storage today (no `social_platform` enum value
 *     and no column for a reward URL) — per the no-fabrication rule it is
 *     shown as a clearly-labelled, NON-editable "not storable yet" row with
 *     the current value if one ever becomes available, never a guessed URL.
 *
 * Each editable row toggles between a read view (handle + open link) and an
 * edit view (input + save/cancel). Saves run in a transition; the server
 * action revalidates the route so the parent re-reads — we also keep a local
 * optimistic value so the row reflects the change instantly.
 *
 * Client component — receives only serializable props (no function props
 * across the RSC boundary); the server actions are imported directly.
 */

type EditablePlatform = "twitter" | "kick" | "discord";

type SocialValue = {
  platform: string;
  username: string;
};

type RowConfig = {
  platform: EditablePlatform;
  label: string;
  icon: LucideIcon;
  iconClass: string;
  placeholder: string;
  /** Build the public profile URL from a handle, or null (no public link). */
  url: ((handle: string) => string) | null;
  /** Helper text under the input. */
  hint: string;
};

const ROWS: RowConfig[] = [
  {
    platform: "twitter",
    label: "Twitter / X",
    icon: Twitter,
    iconClass: "text-sky-500",
    placeholder: "handle (without @)",
    url: (h) => `https://x.com/${encodeURIComponent(h.replace(/^@/, ""))}`,
    hint: "Public X handle. Drives the Twitter tab + banner button.",
  },
  {
    platform: "kick",
    label: "Kick",
    icon: Tv,
    iconClass: "text-green-500",
    placeholder: "channel slug",
    url: (h) => `https://kick.com/${encodeURIComponent(h.replace(/^@/, ""))}`,
    hint: "Kick channel slug. Drives the Kick tab + banner button.",
  },
  {
    platform: "discord",
    label: "Discord ID",
    icon: MessageSquare,
    iconClass: "text-indigo-500",
    placeholder: "Discord ID or username",
    // A Discord ID/username isn't a navigable public profile URL.
    url: null,
    hint: "Discord ID / username (no public profile link).",
  },
];

export function SocialLinksEditor({
  userId,
  initialSocials,
}: {
  userId: string;
  /** Current handles by platform (only the platforms we edit are read). */
  initialSocials: SocialValue[];
}) {
  // Local map platform → current handle ("" = not set). Seeded from the
  // server read; updated optimistically on save/clear so the row reflects the
  // change immediately (the action also revalidates the route).
  const initialMap: Record<string, string> = {};
  for (const s of initialSocials) initialMap[s.platform] = s.username ?? "";
  const [values, setValues] = useState<Record<string, string>>(initialMap);

  return (
    <div className="divide-y rounded-xl border">
      {ROWS.map((row) => (
        <SocialRow
          key={row.platform}
          userId={userId}
          config={row}
          value={values[row.platform] ?? ""}
          onChange={(v) =>
            setValues((prev) => ({ ...prev, [row.platform]: v }))
          }
        />
      ))}

      {/* Reward page — intentionally NOT editable: there is no admin-DB column
          for a reward-page URL today, so we show the field as a labelled,
          disabled "not storable yet" row instead of fabricating storage. */}
      <RewardPageRow />
    </div>
  );
}

function SocialRow({
  userId,
  config,
  value,
  onChange,
}: {
  userId: string;
  config: RowConfig;
  value: string;
  onChange: (next: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [isPending, startTransition] = useTransition();

  const Icon = config.icon;
  const hasValue = value.trim().length > 0;
  const href =
    hasValue && config.url ? config.url(value.replace(/^@/, "")) : null;

  function beginEdit() {
    setDraft(value);
    setEditing(true);
  }

  function cancel() {
    setDraft(value);
    setEditing(false);
  }

  function save() {
    const next = draft.trim().replace(/^@/, "");
    if (!next) {
      toast.error("Enter a handle, or use Clear to remove it.");
      return;
    }
    startTransition(async () => {
      try {
        await upsertCreatorSocial(userId, config.platform, next);
        onChange(next);
        setEditing(false);
        toast.success(`${config.label} saved`);
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : `Could not save ${config.label}`,
        );
      }
    });
  }

  function clear() {
    startTransition(async () => {
      try {
        await removeCreatorSocial(userId, config.platform);
        onChange("");
        setDraft("");
        setEditing(false);
        toast.success(`${config.label} cleared`);
      } catch (err) {
        toast.error(
          err instanceof Error
            ? err.message
            : `Could not clear ${config.label}`,
        );
      }
    });
  }

  return (
    <div className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:gap-3">
      {/* Label cell */}
      <div className="flex w-full items-center gap-2 sm:w-44 sm:shrink-0">
        <div
          className={cn(
            "flex size-7 items-center justify-center rounded-lg bg-muted",
          )}
        >
          <Icon className={cn("size-4", config.iconClass)} />
        </div>
        <span className="text-sm font-medium">{config.label}</span>
      </div>

      {/* Value / editor cell */}
      <div className="min-w-0 flex-1">
        {editing ? (
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <Input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={config.placeholder}
                autoFocus
                disabled={isPending}
                onKeyDown={(e) => {
                  if (e.key === "Enter") save();
                  if (e.key === "Escape") cancel();
                }}
                className="h-8"
              />
              <Button
                type="button"
                size="icon"
                variant="default"
                className="size-8 shrink-0"
                onClick={save}
                disabled={isPending}
                aria-label="Save"
              >
                {isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Save className="size-4" />
                )}
              </Button>
              <Button
                type="button"
                size="icon"
                variant="outline"
                className="size-8 shrink-0"
                onClick={cancel}
                disabled={isPending}
                aria-label="Cancel"
              >
                <X className="size-4" />
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">{config.hint}</p>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            {hasValue ? (
              <>
                {href ? (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-w-0 items-center gap-1.5 truncate text-sm font-medium hover:underline"
                    title={`Open ${config.label}`}
                  >
                    <span className="truncate">@{value.replace(/^@/, "")}</span>
                    <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
                  </a>
                ) : (
                  <span className="min-w-0 truncate font-mono text-sm">
                    {value}
                  </span>
                )}
              </>
            ) : (
              <span className="text-sm text-muted-foreground">Not linked</span>
            )}
          </div>
        )}
      </div>

      {/* Actions cell (read view only) */}
      {!editing && (
        <div className="flex items-center gap-1.5 sm:shrink-0">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={beginEdit}
            disabled={isPending}
          >
            <Pencil className="mr-1.5 size-3.5" />
            {hasValue ? "Edit" : "Add"}
          </Button>
          {hasValue && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-8 text-muted-foreground hover:text-destructive"
              onClick={clear}
              disabled={isPending}
              aria-label={`Clear ${config.label}`}
            >
              {isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Trash2 className="size-4" />
              )}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Reward-page row — read-only. There is no admin-DB storage for a reward-page
 * URL today, so this row is informational: it documents the intended field
 * and explains it isn't wired yet, rather than offering a save that would have
 * nowhere to persist.
 */
function RewardPageRow() {
  return (
    <div className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:gap-3">
      <div className="flex w-full items-center gap-2 sm:w-44 sm:shrink-0">
        <div className="flex size-7 items-center justify-center rounded-lg bg-muted">
          <Check className="size-4 text-amber-500" />
        </div>
        <span className="text-sm font-medium">Reward page</span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5">
          <Info className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
          <p className="text-[11px] leading-snug text-muted-foreground">
            Reward-page link isn&apos;t storable yet — there&apos;s no admin-DB
            column for it. Editing will be enabled once the field is added (no
            value is fabricated).
          </p>
        </div>
      </div>
      <div className="sm:w-[7.5rem] sm:shrink-0" />
    </div>
  );
}
