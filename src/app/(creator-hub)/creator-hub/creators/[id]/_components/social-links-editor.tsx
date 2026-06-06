"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import {
  Check,
  ExternalLink,
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
  removeCreatorDiscordChannel,
  removeCreatorRewardPage,
  removeCreatorSocial,
  upsertCreatorDiscordChannel,
  upsertCreatorRewardPage,
  upsertCreatorSocial,
} from "./creator-tab-actions";

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
  url: ((handle: string) => string) | null;
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
    url: null,
    hint: "Discord ID / username (no public profile link).",
  },
];

export function SocialLinksEditor({
  userId,
  initialSocials,
  initialDiscordChannelUrl = null,
  initialRewardPageUrl = null,
}: {
  userId: string;
  initialSocials: SocialValue[];
  initialDiscordChannelUrl?: string | null;
  initialRewardPageUrl?: string | null;
}) {
  const initialMap: Record<string, string> = {};
  for (const s of initialSocials) initialMap[s.platform] = s.username ?? "";

  const [values, setValues] = useState<Record<string, string>>(initialMap);
  const [discordChannelUrl, setDiscordChannelUrl] = useState(
    initialDiscordChannelUrl ?? "",
  );
  const [rewardPageUrl, setRewardPageUrl] = useState(
    initialRewardPageUrl ?? "",
  );

  return (
    <div className="divide-y rounded-xl border">
      {ROWS.map((row) => (
        <SocialRow
          key={row.platform}
          userId={userId}
          config={row}
          value={values[row.platform] ?? ""}
          discordChannelUrl={
            row.platform === "discord" ? discordChannelUrl : undefined
          }
          onDiscordChannelChange={
            row.platform === "discord" ? setDiscordChannelUrl : undefined
          }
          onChange={(v) =>
            setValues((prev) => ({ ...prev, [row.platform]: v }))
          }
        />
      ))}

      <UrlRow
        label="Discord channel"
        icon={MessageSquare}
        iconClass="text-indigo-500"
        value={discordChannelUrl}
        placeholder="https://discord.com/channels/…"
        hint="Deep-link to the creator's Discord channel. Powers the banner button."
        onSave={async (url) => {
          await upsertCreatorDiscordChannel(userId, url);
          setDiscordChannelUrl(url);
        }}
        onClear={async () => {
          await removeCreatorDiscordChannel(userId);
          setDiscordChannelUrl("");
        }}
        allowClear
      />

      <UrlRow
        label="Reward page"
        icon={Check}
        iconClass="text-amber-500"
        value={rewardPageUrl}
        placeholder="https://packy.gg/r/…"
        hint="Public reward-page link for this creator."
        onSave={async (url) => {
          await upsertCreatorRewardPage(userId, url);
          setRewardPageUrl(url);
        }}
        onClear={async () => {
          await removeCreatorRewardPage(userId);
          setRewardPageUrl("");
        }}
        allowClear
      />
    </div>
  );
}

function SocialRow({
  userId,
  config,
  value,
  discordChannelUrl,
  onDiscordChannelChange,
  onChange,
}: {
  userId: string;
  config: RowConfig;
  value: string;
  discordChannelUrl?: string;
  onDiscordChannelChange?: (v: string) => void;
  onChange: (next: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [channelDraft, setChannelDraft] = useState(discordChannelUrl ?? "");
  const [isPending, startTransition] = useTransition();

  const Icon = config.icon;
  const hasValue = value.trim().length > 0;
  const href =
    hasValue && config.url ? config.url(value.replace(/^@/, "")) : null;

  function beginEdit() {
    setDraft(value);
    setChannelDraft(discordChannelUrl ?? "");
    setEditing(true);
  }

  function cancel() {
    setDraft(value);
    setChannelDraft(discordChannelUrl ?? "");
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
        await upsertCreatorSocial(
          userId,
          config.platform,
          next,
          config.platform === "discord" && channelDraft.trim()
            ? { discordChannelUrl: channelDraft.trim() }
            : undefined,
        );
        onChange(next);
        if (config.platform === "discord" && onDiscordChannelChange) {
          onDiscordChannelChange(channelDraft.trim());
        }
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
      <div className="flex w-full items-center gap-2 sm:w-44 sm:shrink-0">
        <div className="flex size-7 items-center justify-center rounded-lg bg-muted">
          <Icon className={cn("size-4", config.iconClass)} />
        </div>
        <span className="text-sm font-medium">{config.label}</span>
      </div>

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
            {config.platform === "discord" && (
              <Input
                value={channelDraft}
                onChange={(e) => setChannelDraft(e.target.value)}
                placeholder="Discord channel link (optional here)"
                disabled={isPending}
                className="h-8"
              />
            )}
            <p className="text-[11px] text-muted-foreground">{config.hint}</p>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            {hasValue ? (
              href ? (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-w-0 items-center gap-1.5 truncate text-sm font-medium hover:underline"
                >
                  <span className="truncate">@{value.replace(/^@/, "")}</span>
                  <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
                </a>
              ) : (
                <span className="min-w-0 truncate font-mono text-sm">
                  {value}
                </span>
              )
            ) : (
              <span className="text-sm text-muted-foreground">Not linked</span>
            )}
          </div>
        )}
      </div>

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

function UrlRow({
  label,
  icon: Icon,
  iconClass,
  value,
  placeholder,
  hint,
  onSave,
  onClear,
  allowClear,
}: {
  label: string;
  icon: LucideIcon;
  iconClass: string;
  value: string;
  placeholder: string;
  hint: string;
  onSave: (url: string) => Promise<void>;
  onClear: () => Promise<void>;
  allowClear?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [isPending, startTransition] = useTransition();
  const hasValue = value.trim().length > 0;

  function beginEdit() {
    setDraft(value);
    setEditing(true);
  }

  function cancel() {
    setDraft(value);
    setEditing(false);
  }

  function save() {
    const next = draft.trim();
    if (!next) {
      toast.error("Enter a URL, or use Clear to remove it.");
      return;
    }
    startTransition(async () => {
      try {
        await onSave(next);
        setEditing(false);
        toast.success(`${label} saved`);
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : `Could not save ${label}`,
        );
      }
    });
  }

  function clear() {
    startTransition(async () => {
      try {
        await onClear();
        setDraft("");
        setEditing(false);
        toast.success(`${label} cleared`);
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : `Could not clear ${label}`,
        );
      }
    });
  }

  return (
    <div className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:gap-3">
      <div className="flex w-full items-center gap-2 sm:w-44 sm:shrink-0">
        <div className="flex size-7 items-center justify-center rounded-lg bg-muted">
          <Icon className={cn("size-4", iconClass)} />
        </div>
        <span className="text-sm font-medium">{label}</span>
      </div>

      <div className="min-w-0 flex-1">
        {editing ? (
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <Input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={placeholder}
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
            <p className="text-[11px] text-muted-foreground">{hint}</p>
          </div>
        ) : hasValue ? (
          <a
            href={value}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-w-0 items-center gap-1.5 truncate text-sm font-medium hover:underline"
          >
            <span className="truncate">{value}</span>
            <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
          </a>
        ) : (
          <span className="text-sm text-muted-foreground">Not set</span>
        )}
      </div>

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
          {allowClear && hasValue && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-8 text-muted-foreground hover:text-destructive"
              onClick={clear}
              disabled={isPending}
              aria-label={`Clear ${label}`}
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
