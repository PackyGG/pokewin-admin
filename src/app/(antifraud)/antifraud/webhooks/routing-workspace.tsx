"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  CircleOff,
  FolderPlus,
  Hash,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Send,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { StepUpField } from "@/components/step-up-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type {
  DiscordNotificationChannel,
  DiscordNotificationConfig,
  DiscordNotificationEvent,
} from "@/lib/discord-notifications/config";
import { APPROVED_DISCORD_CATEGORY_IDS } from "@/lib/discord-notifications/antifraud-policy";
import { cn } from "@/lib/utils";
import {
  createDiscordChannelAction,
  createCustomEventAction,
  replaceChannelRoutesAction,
} from "./actions";

type ChannelEditorState = {
  channelId: string;
  eventKeys: string[];
};

export function DiscordRoutingWorkspace({
  initialConfig,
}: {
  initialConfig: DiscordNotificationConfig | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editor, setEditor] = useState<ChannelEditorState | null>(null);
  const [editingChannelId, setEditingChannelId] = useState<string | null>(null);
  const [eventQuery, setEventQuery] = useState("");
  const [createEventOpen, setCreateEventOpen] = useState(false);
  const [createChannelOpen, setCreateChannelOpen] = useState(false);
  const [credential, setCredential] = useState("");
  const approvedCategoryIds = useMemo(
    () => new Set<string>(APPROVED_DISCORD_CATEGORY_IDS),
    [],
  );

  const activeChannels = useMemo(() => {
    if (!initialConfig) return [];
    const enabledEventKeys = new Set(
      initialConfig.events
        .filter((event) => event.enabled)
        .map((event) => event.key),
    );
    return initialConfig.channels
      .filter(
        (channel) =>
          channel.parentId !== null &&
          approvedCategoryIds.has(channel.parentId) &&
          initialConfig.routes.some(
            (route) =>
              route.channelId === channel.id &&
              route.enabled &&
              enabledEventKeys.has(route.eventKey),
          ),
      )
      .sort(
        (a, b) =>
          (a.parentName ?? "").localeCompare(b.parentName ?? "") ||
          a.position - b.position ||
          a.name.localeCompare(b.name),
      );
  }, [approvedCategoryIds, initialConfig]);

  const availableChannels = useMemo(() => {
    if (!initialConfig) return [];
    const activeIds = new Set(activeChannels.map((channel) => channel.id));
    return initialConfig.channels.filter(
      (channel) =>
        !activeIds.has(channel.id) &&
        channel.parentId !== null &&
        approvedCategoryIds.has(channel.parentId) &&
        channel.canView &&
        channel.canSend &&
        channel.canEmbed,
    );
  }, [activeChannels, approvedCategoryIds, initialConfig]);

  const availableCategories = useMemo(
    () =>
      initialConfig?.channels
        .filter(
          (channel) =>
            channel.type === "category" &&
            channel.canView &&
            approvedCategoryIds.has(channel.id),
        )
        .sort(
          (a, b) =>
            a.position - b.position || a.name.localeCompare(b.name),
        ) ?? [],
    [approvedCategoryIds, initialConfig],
  );

  if (!initialConfig) {
    return (
      <div className="rounded-xl border border-amber-500/25 bg-amber-500/5 p-6">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-500" />
          <div>
            <h2 className="font-semibold">Discord routing is unavailable</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              The configuration store could not be read. No routes were changed.
            </p>
            <Button
              className="mt-4"
              variant="outline"
              onClick={() => router.refresh()}
            >
              <RefreshCw />
              Try again
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const config = initialConfig;
  const enabledEvents = initialConfig.events.filter((event) => event.enabled);
  const filteredEvents = enabledEvents.filter((event) => {
    const normalized = eventQuery.trim().toLowerCase();
    return (
      !normalized ||
      event.label.toLowerCase().includes(normalized) ||
      event.description.toLowerCase().includes(normalized) ||
      event.category.toLowerCase().includes(normalized) ||
      event.key.includes(normalized)
    );
  });

  function runMutation(
    operation: () => Promise<void>,
    successMessage: string,
    onSuccess?: () => void,
  ) {
    if (!credential) {
      toast.error("Approve this routing change with a passkey or 2FA code.");
      return;
    }
    startTransition(async () => {
      try {
        await operation();
        toast.success(successMessage);
        setCredential("");
        onSuccess?.();
        router.refresh();
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "That change could not be saved",
        );
      }
    });
  }

  function openNewChannel() {
    setEditingChannelId(null);
    setEventQuery("");
    setEditor({
      channelId: availableChannels[0]?.id ?? "",
      eventKeys: [],
    });
  }

  function openExistingChannel(channelId: string) {
    setEditingChannelId(channelId);
    setEventQuery("");
    setEditor({
      channelId,
      eventKeys: config.routes
        .filter(
          (route) =>
            route.channelId === channelId &&
            route.enabled &&
            config.events.some(
              (event) => event.key === route.eventKey && event.enabled,
            ),
        )
        .map((route) => route.eventKey),
    });
  }

  function closeEditor() {
    setEditor(null);
    setEditingChannelId(null);
    setEventQuery("");
  }

  function toggleEvent(eventKey: string, checked: boolean) {
    if (!editor) return;
    setEditor({
      ...editor,
      eventKeys: checked
        ? [...new Set([...editor.eventKeys, eventKey])]
        : editor.eventKeys.filter((key) => key !== eventKey),
    });
  }

  function saveChannel() {
    if (!editor?.channelId || editor.eventKeys.length === 0) return;

    runMutation(
      () =>
        replaceChannelRoutesAction({
          channelId: editor.channelId,
          eventKeys: editor.eventKeys,
          credential,
        }),
      editingChannelId ? "Channel updated" : "Channel added",
      closeEditor,
    );
  }

  function removeChannel(channel: DiscordNotificationChannel) {
    if (
      !window.confirm(
        `Remove #${channel.name} and all of its event assignments?`,
      )
    ) {
      return;
    }
    runMutation(
      () =>
        replaceChannelRoutesAction({
          channelId: channel.id,
          eventKeys: [],
          credential,
        }),
      "Channel removed",
      closeEditor,
    );
  }

  return (
    <div className="space-y-4">
      <div
        className={cn(
          "flex flex-col gap-3 rounded-xl border px-4 py-3 sm:flex-row sm:items-center",
          initialConfig.guild.connected
            ? "border-emerald-500/20 bg-emerald-500/5"
            : "border-amber-500/25 bg-amber-500/5",
        )}
      >
        <span
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-lg",
            initialConfig.guild.connected
              ? "bg-emerald-500/10 text-emerald-500"
              : "bg-amber-500/10 text-amber-500",
          )}
        >
          {initialConfig.guild.connected ? (
            <CheckCircle2 className="size-4" />
          ) : (
            <CircleOff className="size-4" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">
            {initialConfig.guild.connected
              ? initialConfig.guild.name
              : "Antifraud Discord routing is not connected"}
          </p>
          <p className="text-xs text-muted-foreground">
            {initialConfig.guild.lastSyncedAt
              ? `Channels synced ${formatTimestamp(initialConfig.guild.lastSyncedAt)}`
              : "Waiting for the bot to sync its channels"}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => startTransition(() => router.refresh())}
        >
          <RefreshCw className={cn(pending && "animate-spin")} />
          Refresh
        </Button>
      </div>

      <section className="rounded-xl border border-border/60 bg-card p-3 sm:p-4">
        <StepUpField
          id="discord-routing-step-up"
          value={credential}
          onChange={setCredential}
          disabled={pending}
          label="Approve Discord configuration changes"
        />
      </section>

      <section className="overflow-hidden rounded-xl border border-border/60 bg-card">
        <div className="flex flex-col gap-3 border-b border-border/60 p-3 sm:flex-row sm:items-center sm:p-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Send className="size-4 text-cyan-500" />
              <h2 className="font-semibold">Active channels</h2>
              <Badge variant="secondary" className="tabular-nums">
                {activeChannels.length}
              </Badge>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Every configured channel and the events it receives.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => setCreateChannelOpen(true)}
              disabled={pending || availableCategories.length === 0}
            >
              <FolderPlus />
              Create Discord channel
            </Button>
            <Button
              variant="outline"
              onClick={() => setCreateEventOpen(true)}
            >
              <Bot />
              New event
            </Button>
            <Button
              onClick={openNewChannel}
              disabled={
                pending ||
                availableChannels.length === 0 ||
                enabledEvents.length === 0
              }
            >
              <Plus />
              Add existing
            </Button>
          </div>
        </div>

        {activeChannels.length === 0 ? (
          <div className="flex min-h-64 flex-col items-center justify-center px-6 py-12 text-center">
            <span className="flex size-11 items-center justify-center rounded-xl bg-cyan-500/10 text-cyan-500">
              <Hash className="size-5" />
            </span>
            <p className="mt-3 text-sm font-semibold">No active channels</p>
            <p className="mt-1 max-w-sm text-xs text-muted-foreground">
              Add a bot-visible Discord channel and choose the events it should
              receive.
            </p>
            <Button
              className="mt-4"
              onClick={openNewChannel}
              disabled={
                pending ||
                availableChannels.length === 0 ||
                enabledEvents.length === 0
              }
            >
              <Plus />
              Add existing channel
            </Button>
          </div>
        ) : (
          <div className="divide-y divide-border/60">
            {activeChannels.map((channel) => {
              const routes = initialConfig.routes.filter(
                (route) =>
                  route.channelId === channel.id &&
                  route.enabled &&
                  initialConfig.events.some(
                    (event) => event.key === route.eventKey && event.enabled,
                  ),
              );
              const events = routes.map(
                (route) =>
                  initialConfig.events.find(
                    (event) => event.key === route.eventKey,
                  ) ?? {
                    key: route.eventKey,
                    label: route.eventKey,
                    description: "This event is no longer in the catalog.",
                    category: "Unavailable",
                    custom: false,
                    enabled: false,
                  },
              );

              return (
                <div
                  key={channel.id}
                  className="flex flex-col gap-4 p-3 sm:flex-row sm:items-start sm:p-4"
                >
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[#5865F2]/10 text-[#5865F2]">
                    <Hash className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-semibold">#{channel.name}</h3>
                      <DeliveryBadge channel={channel} />
                      <span className="text-xs text-muted-foreground">
                        {channel.parentName ?? "No category"}
                      </span>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {events.map((event) => (
                        <Badge
                          key={event.key}
                          variant={event.enabled ? "secondary" : "destructive"}
                          title={event.description}
                        >
                          {event.label}
                        </Badge>
                      ))}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => openExistingChannel(channel.id)}
                    >
                      <Pencil />
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove #${channel.name}`}
                      disabled={pending}
                      onClick={() => removeChannel(channel)}
                    >
                      <Trash2 className="text-destructive" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <ChannelEditorDialog
        editor={editor}
        editingChannelId={editingChannelId}
        channels={editingChannelId ? initialConfig.channels : availableChannels}
        events={filteredEvents}
        eventQuery={eventQuery}
        pending={pending}
        onEventQueryChange={setEventQuery}
        onEditorChange={setEditor}
        onToggleEvent={toggleEvent}
        onClose={closeEditor}
        onSave={saveChannel}
        onRemove={
          editingChannelId
            ? () => {
                const channel = initialConfig.channels.find(
                  (candidate) => candidate.id === editingChannelId,
                );
                if (channel) removeChannel(channel);
              }
            : undefined
        }
      />

      <CreateDiscordChannelDialog
        open={createChannelOpen}
        onOpenChange={setCreateChannelOpen}
        categories={availableCategories}
        defaultParentId={initialConfig.channelCreation.defaultParentId}
        pending={pending}
        onCreate={(input) =>
          runMutation(
            async () => {
              await createDiscordChannelAction({ ...input, credential });
            },
            "Channel creation queued",
            () => setCreateChannelOpen(false),
          )
        }
      />

      <CreateEventDialog
        open={createEventOpen}
        onOpenChange={setCreateEventOpen}
        existingEvents={initialConfig.events}
        pending={pending}
        onCreate={(input) =>
          runMutation(
            () => createCustomEventAction({ ...input, credential }),
            "Event created",
            () => setCreateEventOpen(false),
          )
        }
      />
    </div>
  );
}

function CreateDiscordChannelDialog({
  open,
  onOpenChange,
  categories,
  defaultParentId,
  pending,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  categories: DiscordNotificationChannel[];
  defaultParentId: string | null;
  pending: boolean;
  onCreate: (input: { parentId: string; name: string }) => void;
}) {
  const preferredParentId = categories.some(
    (category) => category.id === defaultParentId,
  )
    ? defaultParentId
    : categories[0]?.id;
  const [parentId, setParentId] = useState(preferredParentId ?? "");
  const [name, setName] = useState("");

  function handleOpenChange(next: boolean) {
    if (next) {
      setParentId(preferredParentId ?? "");
      setName("");
    }
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create Discord channel</DialogTitle>
          <DialogDescription>
            The bot creates a text channel in the selected main section. This
            section becomes the default for the next channel.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-1">
          <div className="space-y-1.5">
            <Label htmlFor="channel-parent">Main section</Label>
            <Select
              value={parentId}
              onValueChange={(value) => setParentId(value ?? "")}
            >
              <SelectTrigger id="channel-parent">
                <SelectValue placeholder="Choose a Discord category" />
              </SelectTrigger>
              <SelectContent>
                {categories.map((category) => (
                  <SelectItem key={category.id} value={category.id}>
                    {category.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="channel-name">Channel name</Label>
            <Input
              id="channel-name"
              value={name}
              maxLength={100}
              placeholder="fraud-alerts"
              autoComplete="off"
              onChange={(event) => setName(event.target.value)}
            />
            <p className="text-[11px] text-muted-foreground">
              Spaces are converted to dashes.
            </p>
          </div>
        </div>
        <DialogFooter showCloseButton>
          <Button
            disabled={pending || !parentId || name.trim().length === 0}
            onClick={() => onCreate({ parentId, name })}
          >
            <FolderPlus />
            Create channel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ChannelEditorDialog({
  editor,
  editingChannelId,
  channels,
  events,
  eventQuery,
  pending,
  onEventQueryChange,
  onEditorChange,
  onToggleEvent,
  onClose,
  onSave,
  onRemove,
}: {
  editor: ChannelEditorState | null;
  editingChannelId: string | null;
  channels: DiscordNotificationChannel[];
  events: DiscordNotificationEvent[];
  eventQuery: string;
  pending: boolean;
  onEventQueryChange: (value: string) => void;
  onEditorChange: (value: ChannelEditorState) => void;
  onToggleEvent: (eventKey: string, checked: boolean) => void;
  onClose: () => void;
  onSave: () => void;
  onRemove?: () => void;
}) {
  const channel = channels.find((candidate) => candidate.id === editor?.channelId);

  return (
    <Dialog open={editor !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {editingChannelId ? `Edit #${channel?.name ?? "channel"}` : "New channel"}
          </DialogTitle>
          <DialogDescription>
            Choose a Discord channel and the events the bot should send there.
          </DialogDescription>
        </DialogHeader>

        {editor && (
          <div className="space-y-5">
            <div className="space-y-1.5">
              <Label>Discord channel</Label>
              <Select
                value={editor.channelId}
                disabled={Boolean(editingChannelId)}
                onValueChange={(channelId) =>
                  onEditorChange({ ...editor, channelId: channelId ?? "" })
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Choose a channel" />
                </SelectTrigger>
                <SelectContent>
                  {channels.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      #{item.name}
                      {item.parentName ? ` · ${item.parentName}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <Label>Events</Label>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {editor.eventKeys.length} selected
                </span>
              </div>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={eventQuery}
                  onChange={(event) => onEventQueryChange(event.target.value)}
                  placeholder="Search events"
                  className="pl-9"
                />
              </div>
              <div className="max-h-72 space-y-2 overflow-y-auto rounded-xl border border-border/60 p-2">
                {events.length === 0 ? (
                  <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                    No matching events.
                  </p>
                ) : (
                  events.map((event) => {
                    const checked = editor.eventKeys.includes(event.key);
                    return (
                      <label
                        key={event.key}
                        className={cn(
                          "flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors",
                          checked
                            ? "border-cyan-500/30 bg-cyan-500/5"
                            : "border-transparent hover:bg-muted/60",
                        )}
                      >
                        <Checkbox
                          className="mt-0.5"
                          checked={checked}
                          onCheckedChange={(value) =>
                            onToggleEvent(event.key, value === true)
                          }
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium">{event.label}</span>
                            <Badge variant="outline">{event.category}</Badge>
                            {event.custom && (
                              <Badge variant="secondary">Custom</Badge>
                            )}
                          </span>
                          <span className="mt-1 block text-xs text-muted-foreground">
                            {event.description}
                          </span>
                        </span>
                      </label>
                    );
                  })
                )}
              </div>
              {editor.eventKeys.length === 0 && (
                <p className="text-xs text-amber-500">
                  Select at least one event.
                </p>
              )}
            </div>
          </div>
        )}

        <DialogFooter className="sm:justify-between">
          <div>
            {onRemove && (
              <Button
                variant="ghost"
                className="text-destructive hover:text-destructive"
                disabled={pending}
                onClick={onRemove}
              >
                <Trash2 />
                Remove channel
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" disabled={pending} onClick={onClose}>
              Cancel
            </Button>
            <Button
              disabled={
                pending || !editor?.channelId || editor.eventKeys.length === 0
              }
              onClick={onSave}
            >
              {editingChannelId ? "Save changes" : "Add channel"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeliveryBadge({ channel }: { channel: DiscordNotificationChannel }) {
  const ready = channel.canView && channel.canSend && channel.canEmbed;
  return (
    <Badge variant={ready ? "secondary" : "destructive"}>
      {ready
        ? "Active"
        : !channel.canView
          ? "Cannot view"
          : !channel.canSend
            ? "Cannot send"
            : "Cannot embed"}
    </Badge>
  );
}

function CreateEventDialog({
  open,
  onOpenChange,
  existingEvents,
  pending,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingEvents: DiscordNotificationEvent[];
  pending: boolean;
  onCreate: (input: {
    key: string;
    label: string;
    description: string;
    category: string;
  }) => void;
}) {
  const [label, setLabel] = useState("");
  const [key, setKey] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("Custom");

  function reset() {
    setLabel("");
    setKey("");
    setDescription("");
    setCategory("Custom");
  }

  function create() {
    const normalizedKey = key.trim().toLowerCase();
    if (existingEvents.some((event) => event.key === normalizedKey)) {
      toast.error("That event key already exists");
      return;
    }
    onCreate({
      key: normalizedKey,
      label: label.trim(),
      description: description.trim(),
      category: category.trim(),
    });
    onOpenChange(false);
    reset();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New event</DialogTitle>
          <DialogDescription>
            Add a reusable event, then assign it to a channel.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="event-label">Name</Label>
            <Input
              id="event-label"
              value={label}
              maxLength={80}
              placeholder="Manual review alert"
              onChange={(event) => {
                const next = event.target.value;
                setLabel(next);
                if (!key) {
                  setKey(
                    next
                      .toLowerCase()
                      .replace(/[^a-z0-9]+/g, "_")
                      .replace(/^_+|_+$/g, ""),
                  );
                }
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="event-key">Event key</Label>
            <Input
              id="event-key"
              value={key}
              maxLength={80}
              placeholder="manual_review_alert"
              onChange={(event) => setKey(event.target.value)}
            />
            <p className="text-[11px] text-muted-foreground">
              Lowercase letters, numbers, dots, dashes, and underscores only.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="event-category">Category</Label>
            <Input
              id="event-category"
              value={category}
              maxLength={60}
              onChange={(event) => setCategory(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="event-description">Description</Label>
            <Textarea
              id="event-description"
              value={description}
              maxLength={240}
              placeholder="When this event is sent."
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
        </div>
        <DialogFooter showCloseButton>
          <Button
            disabled={
              pending ||
              label.trim().length < 2 ||
              description.trim().length < 2 ||
              category.trim().length < 2 ||
              !/^[a-z0-9][a-z0-9_.-]{2,79}$/.test(key.trim().toLowerCase())
            }
            onClick={create}
          >
            <Plus />
            Create event
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function formatTimestamp(value: string): string {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return "at an unknown time";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}
