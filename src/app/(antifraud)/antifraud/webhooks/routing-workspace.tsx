"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  CircleOff,
  Hash,
  ListFilter,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings2,
  Trash2,
  Webhook,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type {
  DiscordNotificationConfig,
  DiscordNotificationEvent,
} from "@/lib/discord-notifications/config";
import { cn } from "@/lib/utils";
import {
  createCustomEventAction,
  deleteRouteAction,
  setRouteEnabledAction,
  upsertRouteAction,
} from "./actions";

export function DiscordRoutingWorkspace({
  initialConfig,
}: {
  initialConfig: DiscordNotificationConfig | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedChannelId, setSelectedChannelId] = useState(
    initialConfig?.channels.find(
      (channel) => channel.canView && channel.canSend && channel.canEmbed,
    )?.id ??
      initialConfig?.channels[0]?.id ??
      "",
  );
  const [selectedEventKey, setSelectedEventKey] = useState("");
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    if (
      initialConfig &&
      !initialConfig.channels.some((channel) => channel.id === selectedChannelId)
    ) {
      setSelectedChannelId(
        initialConfig.channels.find(
          (channel) => channel.canView && channel.canSend && channel.canEmbed,
        )?.id ??
          initialConfig.channels[0]?.id ??
          "",
      );
    }
  }, [initialConfig, selectedChannelId]);

  const channels = useMemo(() => {
    if (!initialConfig) return [];
    const normalized = query.trim().toLowerCase();
    return initialConfig.channels
      .filter(
        (channel) =>
          !normalized ||
          channel.name.toLowerCase().includes(normalized) ||
          channel.parentName?.toLowerCase().includes(normalized) ||
          channel.id.includes(normalized),
      )
      .sort(
        (a, b) =>
          (a.parentName ?? "").localeCompare(b.parentName ?? "") ||
          a.position - b.position ||
          a.name.localeCompare(b.name),
      );
  }, [initialConfig, query]);

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

  const selectedChannel =
    initialConfig.channels.find((channel) => channel.id === selectedChannelId) ??
    null;
  const selectedRoutes = selectedChannel
    ? initialConfig.routes.filter(
        (route) => route.channelId === selectedChannel.id,
      )
    : [];
  const routeByEvent = new Map(
    selectedRoutes.map((route) => [route.eventKey, route]),
  );
  const availableEvents = initialConfig.events.filter(
    (event) => event.enabled && !routeByEvent.has(event.key),
  );
  const activeRoutes = initialConfig.routes.filter((route) => route.enabled).length;
  const sendableChannels = initialConfig.channels.filter(
    (channel) => channel.canView && channel.canSend && channel.canEmbed,
  ).length;

  function runMutation(
    key: string,
    operation: () => Promise<void>,
    successMessage: string,
  ) {
    setBusyKey(key);
    startTransition(async () => {
      try {
        await operation();
        toast.success(successMessage);
        router.refresh();
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "That change could not be saved",
        );
      } finally {
        setBusyKey(null);
      }
    });
  }

  function addSelectedEvent() {
    if (!selectedChannel || !selectedEventKey) return;
    runMutation(
      `add:${selectedChannel.id}:${selectedEventKey}`,
      () =>
        upsertRouteAction({
          channelId: selectedChannel.id,
          eventKey: selectedEventKey,
          enabled: true,
        }),
      "Event routed to this channel",
    );
    setSelectedEventKey("");
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <SummaryCard
          icon={Hash}
          label="Bot-visible channels"
          value={sendableChannels}
          detail={`${initialConfig.channels.length} synced from Discord`}
        />
        <SummaryCard
          icon={ListFilter}
          label="Available events"
          value={initialConfig.events.filter((event) => event.enabled).length}
          detail={`${initialConfig.events.filter((event) => event.custom).length} custom`}
        />
        <SummaryCard
          icon={Send}
          label="Active routes"
          value={activeRoutes}
          detail={`${initialConfig.routes.length} configured`}
        />
      </div>

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
              ? `Channel inventory synced ${formatTimestamp(initialConfig.guild.lastSyncedAt)}`
              : "Waiting for the bot to publish its first channel inventory"}
          </p>
        </div>
        <Button
          variant="outline"
          disabled={pending}
          onClick={() => startTransition(() => router.refresh())}
        >
          <RefreshCw className={cn(pending && "animate-spin")} />
          Reload synced data
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.45fr)]">
        <section className="overflow-hidden rounded-xl border bg-card">
          <div className="border-b p-4">
            <div className="flex items-center gap-2">
              <Hash className="size-4 text-cyan-500" />
              <h2 className="font-semibold">Channels</h2>
              <Badge variant="secondary" className="ml-auto">
                {channels.length}
              </Badge>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Every channel the bot can currently see. Unsuitable channels stay
              visible with the missing permission explained.
            </p>
            <div className="relative mt-3">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search channels or categories"
                className="pl-9"
              />
            </div>
          </div>

          <div className="max-h-[520px] overflow-y-auto p-2">
            {channels.length === 0 ? (
              <EmptyState
                icon={Hash}
                title={query ? "No matching channels" : "No channels synced"}
                detail={
                  query
                    ? "Try another name, category, or channel ID."
                    : "Invite the bot to the admin server and wait for its inventory sync."
                }
              />
            ) : (
              <div className="space-y-1">
                {channels.map((channel) => {
                  const routeCount = initialConfig.routes.filter(
                    (route) => route.channelId === channel.id,
                  ).length;
                  const canDeliver =
                    channel.canView && channel.canSend && channel.canEmbed;
                  return (
                    <button
                      key={channel.id}
                      type="button"
                      onClick={() => setSelectedChannelId(channel.id)}
                      className={cn(
                        "flex w-full items-start gap-3 rounded-lg border px-3 py-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                        selectedChannelId === channel.id
                          ? "border-cyan-500/35 bg-cyan-500/8"
                          : "border-transparent hover:bg-muted/60",
                      )}
                    >
                      <Hash className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">
                            {channel.name}
                          </span>
                          {routeCount > 0 && (
                            <Badge variant="secondary">{routeCount}</Badge>
                          )}
                        </span>
                        <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                          {channel.parentName ?? "No category"} · {channel.type}
                        </span>
                      </span>
                      <span
                        className={cn(
                          "mt-0.5 size-2 shrink-0 rounded-full",
                          canDeliver ? "bg-emerald-500" : "bg-amber-500",
                        )}
                        title={
                          canDeliver
                            ? "Ready for embeds"
                            : "Missing View Channel, Send Messages, or Embed Links"
                        }
                      />
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        <section className="overflow-hidden rounded-xl border bg-card">
          {selectedChannel ? (
            <>
              <div className="border-b p-4">
                <div className="flex flex-wrap items-start gap-3">
                  <span className="flex size-9 items-center justify-center rounded-lg bg-[#5865F2]/10 text-[#5865F2]">
                    <Webhook className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate font-semibold">
                      #{selectedChannel.name}
                    </h2>
                    <p className="text-xs text-muted-foreground">
                      {selectedChannel.parentName ?? "No category"} ·{" "}
                      {selectedChannel.id}
                    </p>
                  </div>
                  <DeliveryBadge
                    canView={selectedChannel.canView}
                    canSend={selectedChannel.canSend}
                    canEmbed={selectedChannel.canEmbed}
                  />
                </div>

                <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                  <Select
                    value={selectedEventKey}
                    onValueChange={(value) => setSelectedEventKey(value ?? "")}
                    disabled={
                      !selectedChannel.canSend ||
                      !selectedChannel.canView ||
                      !selectedChannel.canEmbed ||
                      availableEvents.length === 0
                    }
                  >
                    <SelectTrigger className="w-full sm:flex-1">
                      <SelectValue placeholder="Choose an event to route" />
                    </SelectTrigger>
                    <SelectContent>
                      {availableEvents.map((event) => (
                        <SelectItem key={event.key} value={event.key}>
                          {event.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    onClick={addSelectedEvent}
                    disabled={!selectedEventKey || pending}
                  >
                    <Plus />
                    Add event
                  </Button>
                  <Button variant="outline" onClick={() => setCreateOpen(true)}>
                    <Settings2 />
                    New action
                  </Button>
                </div>
              </div>

              <div className="min-h-[360px] p-4">
                {selectedRoutes.length === 0 ? (
                  <EmptyState
                    icon={Send}
                    title="Nothing routes here yet"
                    detail="Choose an event above. One event can route to multiple channels, and one channel can receive multiple events."
                  />
                ) : (
                  <div className="space-y-3">
                    {selectedRoutes.map((route) => {
                      const event = initialConfig.events.find(
                        (candidate) => candidate.key === route.eventKey,
                      );
                      const toggleKey = `toggle:${route.id}`;
                      const deleteKey = `delete:${route.id}`;
                      return (
                        <div
                          key={route.id}
                          className={cn(
                            "flex items-start gap-3 rounded-xl border p-4",
                            route.enabled
                              ? "border-border/70"
                              : "border-dashed bg-muted/20 opacity-75",
                          )}
                        >
                          <span
                            className={cn(
                              "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg",
                              route.enabled
                                ? "bg-cyan-500/10 text-cyan-500"
                                : "bg-muted text-muted-foreground",
                            )}
                          >
                            <Bot className="size-4" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex flex-wrap items-center gap-2">
                              <span className="text-sm font-semibold">
                                {event?.label ?? route.eventKey}
                              </span>
                              {event?.custom && (
                                <Badge variant="outline">Custom</Badge>
                              )}
                            </span>
                            <span className="mt-1 block text-xs text-muted-foreground">
                              {event?.description ??
                                "This event is no longer in the catalog."}
                            </span>
                            <code className="mt-2 block text-[10px] text-muted-foreground">
                              {route.eventKey}
                            </code>
                          </span>
                          <div className="flex shrink-0 items-center gap-2">
                            <Switch
                              checked={route.enabled}
                              disabled={pending || busyKey === toggleKey}
                              aria-label={`${route.enabled ? "Disable" : "Enable"} ${event?.label ?? route.eventKey}`}
                              onCheckedChange={(enabled) =>
                                runMutation(
                                  toggleKey,
                                  () =>
                                    setRouteEnabledAction({
                                      id: route.id,
                                      enabled,
                                    }),
                                  enabled ? "Route enabled" : "Route disabled",
                                )
                              }
                            />
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              disabled={pending || busyKey === deleteKey}
                              aria-label={`Delete route for ${event?.label ?? route.eventKey}`}
                              onClick={() => {
                                if (
                                  !window.confirm(
                                    `Stop routing ${event?.label ?? route.eventKey} to #${selectedChannel.name}?`,
                                  )
                                ) {
                                  return;
                                }
                                runMutation(
                                  deleteKey,
                                  () => deleteRouteAction({ id: route.id }),
                                  "Routing rule deleted",
                                );
                              }}
                            >
                              <Trash2 className="text-destructive" />
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          ) : (
            <EmptyState
              icon={Hash}
              title="Select a channel"
              detail="Choose a bot-visible Discord channel to configure its events."
            />
          )}
        </section>
      </div>

      <section className="rounded-xl border bg-card">
        <div className="flex flex-col gap-3 border-b p-4 sm:flex-row sm:items-center">
          <div className="flex-1">
            <h2 className="font-semibold">Event catalog</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Built-in antifraud events and reusable custom actions. Counts show
              how many Discord channels receive each event.
            </p>
          </div>
          <Button variant="outline" onClick={() => setCreateOpen(true)}>
            <Plus />
            Add custom action
          </Button>
        </div>
        {initialConfig.events.length === 0 ? (
          <EmptyState
            icon={ListFilter}
            title="No events available"
            detail="The event catalog has not been initialized yet."
          />
        ) : (
          <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-3">
            {initialConfig.events.map((event) => {
              const eventRoutes = initialConfig.routes.filter(
                (route) => route.eventKey === event.key,
              );
              return (
                <div
                  key={event.key}
                  className={cn(
                    "rounded-xl border p-4",
                    !event.enabled && "border-dashed bg-muted/20 opacity-70",
                  )}
                >
                  <div className="flex items-start gap-3">
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                      <Bot className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-semibold">{event.label}</p>
                        {event.custom && <Badge variant="outline">Custom</Badge>}
                        {!event.enabled && (
                          <Badge variant="secondary">Unavailable</Badge>
                        )}
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {event.description}
                      </p>
                    </div>
                  </div>
                  <div className="mt-3 flex items-center justify-between border-t pt-3 text-[11px] text-muted-foreground">
                    <span>{event.category}</span>
                    <span>
                      {eventRoutes.filter((route) => route.enabled).length} active ·{" "}
                      {eventRoutes.length} total
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <CreateEventDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        existingEvents={initialConfig.events}
        pending={pending}
        onCreate={(input) =>
          runMutation(
            `event:${input.key}`,
            () => createCustomEventAction(input),
            "Custom action created",
          )
        }
      />
    </div>
  );
}

function SummaryCard({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: typeof Hash;
  label: string;
  value: number;
  detail: string;
}) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-center gap-3">
        <span className="flex size-9 items-center justify-center rounded-lg bg-cyan-500/10 text-cyan-500">
          <Icon className="size-4" />
        </span>
        <div>
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="text-xl font-bold tabular-nums">{value}</p>
        </div>
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">{detail}</p>
    </div>
  );
}

function DeliveryBadge({
  canView,
  canSend,
  canEmbed,
}: {
  canView: boolean;
  canSend: boolean;
  canEmbed: boolean;
}) {
  const ready = canView && canSend && canEmbed;
  return (
    <Badge variant={ready ? "secondary" : "destructive"}>
      {ready
        ? "Ready"
        : !canView
          ? "Cannot view"
          : !canSend
          ? "Cannot send"
          : "Cannot embed"}
    </Badge>
  );
}

function EmptyState({
  icon: Icon,
  title,
  detail,
}: {
  icon: typeof Hash;
  title: string;
  detail: string;
}) {
  return (
    <div className="flex min-h-48 flex-col items-center justify-center px-6 py-10 text-center">
      <span className="flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
        <Icon className="size-5" />
      </span>
      <p className="mt-3 text-sm font-semibold">{title}</p>
      <p className="mt-1 max-w-sm text-xs text-muted-foreground">{detail}</p>
    </div>
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
          <DialogTitle>Add custom action</DialogTitle>
          <DialogDescription>
            Create a reusable event key, then assign it to one or more Discord
            channels. The sending system must publish this exact key.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="event-label">Display name</Label>
            <Input
              id="event-label"
              value={label}
              maxLength={80}
              placeholder="Manual review escalated"
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
              placeholder="manual_review_escalated"
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
              placeholder="When this action should be sent and what staff should do."
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
            Create action
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
