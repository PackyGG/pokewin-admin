"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
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
import type {
  DiscordNotificationChannel,
  DiscordNotificationConfig,
  DiscordNotificationEvent,
} from "@/lib/discord-notifications/config";
import {
  APPROVED_DISCORD_CATEGORY_IDS,
  DISCORD_ESCALATION_GROUP_KEYS,
  DISCORD_MENTION_GROUPS,
  isSilentDiscordCategory,
} from "@/lib/discord-notifications/antifraud-policy";
import type { ServerActionResult } from "@/lib/errors/server-action-result";
import { PASSKEY_GRACE_CREDENTIAL } from "@/lib/passkey-grace-shared";
import { getMyPasskeyStepUpState } from "@/lib/passkey-step-up-actions";
import { cn } from "@/lib/utils";
import {
  createDiscordChannelAction,
  replaceChannelRoutesAction,
} from "./actions";

type ChannelEditorState = {
  channelId: string;
  eventKeys: string[];
  mentionGroupKeys: string[];
};

type PendingMutation = {
  operation: (credential: string) => Promise<ServerActionResult<unknown>>;
  successMessage: string;
  onSuccess?: () => void;
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
  const [createChannelOpen, setCreateChannelOpen] = useState(false);
  const [collapsedCategoryIds, setCollapsedCategoryIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [credential, setCredential] = useState("");
  const [pendingMutation, setPendingMutation] =
    useState<PendingMutation | null>(null);
  const approvedCategoryIds = useMemo(
    () => new Set<string>(APPROVED_DISCORD_CATEGORY_IDS),
    [],
  );
  const graceExpiresAt = useRef<number | null>(null);

  // An active passkey grace window already covers these changes, so no prompt
  // is shown until it is missing or expired.
  useEffect(() => {
    let active = true;
    getMyPasskeyStepUpState()
      .then((state) => {
        if (!active || !state.graceExpiresAt) return;
        const expiresAt = new Date(state.graceExpiresAt).getTime();
        if (expiresAt <= Date.now()) return;
        graceExpiresAt.current = expiresAt;
        setCredential(PASSKEY_GRACE_CREDENTIAL);
      })
      .catch(() => {
        // Without the optional state check the prompt simply appears.
      });
    return () => {
      active = false;
    };
  }, []);

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

  // Mirrors the Discord sidebar: channels sit under their own category, in the
  // same order the server shows them.
  const activeChannelGroups = useMemo(() => {
    const categoryMeta = new Map<string, { name: string; position: number }>();
    for (const channel of initialConfig?.channels ?? []) {
      if (channel.type === "category") {
        categoryMeta.set(channel.id, {
          name: channel.name,
          position: channel.position,
        });
      }
    }

    const groups = new Map<
      string,
      {
        id: string;
        name: string;
        position: number;
        channels: DiscordNotificationChannel[];
      }
    >();
    for (const channel of activeChannels) {
      const groupId = channel.parentId ?? "uncategorized";
      let group = groups.get(groupId);
      if (!group) {
        const meta = channel.parentId
          ? categoryMeta.get(channel.parentId)
          : undefined;
        group = {
          id: groupId,
          name: meta?.name ?? channel.parentName ?? "No category",
          position: meta?.position ?? Number.MAX_SAFE_INTEGER,
          channels: [],
        };
        groups.set(groupId, group);
      }
      group.channels.push(channel);
    }

    return [...groups.values()]
      .sort(
        (a, b) => a.position - b.position || a.name.localeCompare(b.name),
      )
      .map((group) => ({
        ...group,
        channels: [...group.channels].sort(
          (a, b) => a.position - b.position || a.name.localeCompare(b.name),
        ),
      }));
  }, [activeChannels, initialConfig]);

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
  // An event belongs to exactly one channel, so anything another channel
  // already claims is dropped from this picker entirely. Only a channel the
  // guild still has can hold a claim — `channels` is loaded available-only, so a
  // row left behind by a deleted channel neither hides an event here nor blocks
  // the save.
  const liveChannelIds = new Set(initialConfig.channels.map((item) => item.id));
  const claimedElsewhere = new Set(
    initialConfig.routes
      .filter(
        (route) =>
          route.channelId !== editor?.channelId &&
          liveChannelIds.has(route.channelId),
      )
      .map((route) => route.eventKey),
  );
  const filteredEvents = enabledEvents.filter((event) => {
    // Something already selected here stays listed even if another channel
    // claims it, so the conflict can be unchecked instead of blocking the save.
    if (claimedElsewhere.has(event.key) && !editor?.eventKeys.includes(event.key))
      return false;
    const normalized = eventQuery.trim().toLowerCase();
    return (
      !normalized ||
      event.label.toLowerCase().includes(normalized) ||
      event.description.toLowerCase().includes(normalized) ||
      event.category.toLowerCase().includes(normalized) ||
      event.key.includes(normalized)
    );
  });

  function activeCredential(): string {
    if (credential !== PASSKEY_GRACE_CREDENTIAL) return credential;
    const expiresAt = graceExpiresAt.current;
    return expiresAt && expiresAt > Date.now() ? credential : "";
  }

  function execute(mutation: PendingMutation, approval: string) {
    startTransition(async () => {
      // Only a grace window is reusable. A TOTP code or one-use passkey proof
      // is spent by the attempt itself — keeping it would make every retry fail
      // with "already used" instead of asking for a fresh one.
      const dropApproval = () => {
        if (approval !== PASSKEY_GRACE_CREDENTIAL) setCredential("");
      };
      try {
        const result = await mutation.operation(approval);
        if (!result.success) {
          dropApproval();
          toast.error(result.error);
          return;
        }
        toast.success(mutation.successMessage);
        dropApproval();
        mutation.onSuccess?.();
        router.refresh();
      } catch {
        dropApproval();
        toast.error("That change could not be saved — please try again.");
      }
    });
  }

  function runMutation(
    operation: (approval: string) => Promise<ServerActionResult<unknown>>,
    successMessage: string,
    onSuccess?: () => void,
  ) {
    const mutation = { operation, successMessage, onSuccess };
    const approval = activeCredential();
    if (!approval) {
      setPendingMutation(mutation);
      return;
    }
    execute(mutation, approval);
  }

  function openNewChannel() {
    setEditingChannelId(null);
    setEventQuery("");
    setEditor({
      channelId: availableChannels[0]?.id ?? "",
      eventKeys: [],
      // Matches the seeded default for existing channels: first-line support.
      // Silent categories drop tags at enqueue time regardless of this.
      mentionGroupKeys: ["support"],
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
      mentionGroupKeys:
        config.channelMentions.find(
          (mention) => mention.channelId === channelId,
        )?.groupKeys ?? [],
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

  function toggleMentionGroup(groupKey: string, checked: boolean) {
    if (!editor) return;
    setEditor({
      ...editor,
      mentionGroupKeys: checked
        ? [...new Set([...editor.mentionGroupKeys, groupKey])]
        : editor.mentionGroupKeys.filter((key) => key !== groupKey),
    });
  }

  function saveChannel() {
    if (!editor?.channelId || editor.eventKeys.length === 0) return;

    runMutation(
      (approval) =>
        replaceChannelRoutesAction({
          channelId: editor.channelId,
          eventKeys: editor.eventKeys,
          mentionGroupKeys: editor.mentionGroupKeys,
          credential: approval,
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
      (approval) =>
        replaceChannelRoutesAction({
          channelId: channel.id,
          eventKeys: [],
          mentionGroupKeys: [],
          credential: approval,
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

      <section className="overflow-hidden rounded-xl border border-border/60 bg-card">
        <div className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:p-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Send className="size-4 text-cyan-500" />
              <h2 className="font-semibold">Active channels</h2>
              <Badge variant="secondary" className="tabular-nums">
                {activeChannels.length}
              </Badge>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Grouped by Discord category, with the events each channel
              receives.
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
      </section>

      {activeChannels.length === 0 ? (
        <section className="overflow-hidden rounded-xl border border-border/60 bg-card">
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
        </section>
      ) : (
        <div className="space-y-3">
          {activeChannelGroups.map((group) => {
            const categoryOpen = !collapsedCategoryIds.has(group.id);

            return (
              <section
                key={group.id}
                className="overflow-hidden rounded-xl border border-border/60 bg-card"
              >
                <Collapsible
                  open={categoryOpen}
                  onOpenChange={(open) =>
                    setCollapsedCategoryIds((current) => {
                      const next = new Set(current);
                      if (open) next.delete(group.id);
                      else next.add(group.id);
                      return next;
                    })
                  }
                >
                  <CollapsibleTrigger
                    className={cn(
                      "flex w-full cursor-pointer items-center gap-2 bg-muted/40 px-3 py-2 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:px-4",
                      categoryOpen && "border-b border-border/60",
                    )}
                    aria-label={`${categoryOpen ? "Collapse" : "Expand"} ${group.name}`}
                  >
                    <ChevronDown
                      className={cn(
                        "size-3.5 shrink-0 text-muted-foreground motion-safe:transition-transform motion-safe:duration-200",
                        !categoryOpen && "-rotate-90",
                      )}
                    />
                    <span className="truncate text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {group.name}
                    </span>
                    <span className="text-[11px] tabular-nums text-muted-foreground/70">
                      {group.channels.length}
                    </span>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="divide-y divide-border/40">
                      {group.channels.map((channel) => {
                        const routes = initialConfig.routes.filter(
                          (route) =>
                            route.channelId === channel.id &&
                            route.enabled &&
                            initialConfig.events.some(
                              (event) =>
                                event.key === route.eventKey && event.enabled,
                            ),
                        );
                        const events = routes.map(
                          (route) =>
                            initialConfig.events.find(
                              (event) => event.key === route.eventKey,
                            ) ?? {
                              key: route.eventKey,
                              label: route.eventKey,
                              description:
                                "This event is no longer in the catalog.",
                              category: "Unavailable",
                              custom: false,
                              enabled: false,
                            },
                        );

                        return (
                          <div
                            key={channel.id}
                            className="flex flex-col gap-3 px-3 py-3 transition-colors hover:bg-muted/25 sm:flex-row sm:items-center sm:gap-4 sm:px-4"
                          >
                            <div className="flex min-w-0 flex-1 items-start gap-3">
                              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[#5865F2]/10 text-[#5865F2]">
                                <Hash className="size-4" />
                              </span>
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                  <h3 className="truncate text-sm font-semibold">
                                    #{channel.name}
                                  </h3>
                                  <DeliveryBadge channel={channel} />
                                  <span className="text-[11px] tabular-nums text-muted-foreground">
                                    {events.length}{" "}
                                    {events.length === 1 ? "event" : "events"}
                                  </span>
                                </div>
                                <div className="mt-2 flex flex-wrap gap-1.5">
                                  {events.map((event) => (
                                    <Badge
                                      key={event.key}
                                      variant={
                                        event.enabled
                                          ? "outline"
                                          : "destructive"
                                      }
                                      className="px-1.5 py-0 text-[11px] font-normal"
                                      title={event.description}
                                    >
                                      {event.label}
                                    </Badge>
                                  ))}
                                </div>
                              </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-1 self-end sm:self-center">
                              <Button
                                variant="ghost"
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
                  </CollapsibleContent>
                </Collapsible>
              </section>
            );
          })}
        </div>
      )}

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
        onToggleMentionGroup={toggleMentionGroup}
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
            (approval) =>
              createDiscordChannelAction({
                ...input,
                credential: approval,
              }),
            "Channel creation queued",
            () => setCreateChannelOpen(false),
          )
        }
      />

      <ApprovalDialog
        open={pendingMutation !== null}
        pending={pending}
        onCancel={() => setPendingMutation(null)}
        onApprove={(approval) => {
          if (approval === PASSKEY_GRACE_CREDENTIAL) {
            setCredential(PASSKEY_GRACE_CREDENTIAL);
            // Take the real expiry from the server rather than assuming one.
            getMyPasskeyStepUpState()
              .then((state) => {
                graceExpiresAt.current = state.graceExpiresAt
                  ? new Date(state.graceExpiresAt).getTime()
                  : null;
              })
              .catch(() => {
                graceExpiresAt.current = null;
              });
          }
          const mutation = pendingMutation;
          setPendingMutation(null);
          if (mutation) execute(mutation, approval);
        }}
      />
    </div>
  );
}

/** Asks for a second factor only when no approval is already in hand. */
function ApprovalDialog({
  open,
  pending,
  onCancel,
  onApprove,
}: {
  open: boolean;
  pending: boolean;
  onCancel: () => void;
  onApprove: (credential: string) => void;
}) {
  const [value, setValue] = useState("");

  useEffect(() => {
    if (!open) setValue("");
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Approve this change</DialogTitle>
          <DialogDescription>
            Confirm with a passkey or your 2FA code to save this Discord routing
            change.
          </DialogDescription>
        </DialogHeader>
        {open && (
          <StepUpField
            id="discord-routing-step-up"
            value={value}
            onChange={setValue}
            disabled={pending}
            autoFocus
            label="Approval"
          />
        )}
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={onCancel}>
            Cancel
          </Button>
          <Button
            disabled={pending || value.trim().length === 0}
            onClick={() => onApprove(value)}
          >
            Approve
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  onToggleMentionGroup,
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
  onToggleMentionGroup: (groupKey: string, checked: boolean) => void;
  onClose: () => void;
  onSave: () => void;
  onRemove?: () => void;
}) {
  const channel = channels.find(
    (candidate) => candidate.id === editor?.channelId,
  );
  const silentChannel = isSilentDiscordCategory(channel?.parentId ?? null);

  return (
    <Dialog open={editor !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {editingChannelId
              ? `Edit #${channel?.name ?? "channel"}`
              : "New channel"}
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
                <Label>Tag these groups</Label>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {editor.mentionGroupKeys.length === 0
                    ? "Nobody tagged"
                    : `${editor.mentionGroupKeys.length} selected`}
                </span>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {DISCORD_MENTION_GROUPS.map((group) => {
                  const checked = editor.mentionGroupKeys.includes(group.key);
                  return (
                    <label
                      key={group.key}
                      className={cn(
                        "flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors",
                        checked
                          ? "border-cyan-500/30 bg-cyan-500/5"
                          : "border-border/60 hover:bg-muted/60",
                      )}
                    >
                      <Checkbox
                        className="mt-0.5"
                        checked={checked}
                        onCheckedChange={(value) =>
                          onToggleMentionGroup(group.key, value === true)
                        }
                      />
                      <span className="min-w-0 flex-1">
                        <span className="text-sm font-medium">
                          {group.label}
                        </span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          {group.description}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
              {silentChannel ? (
                <p className="text-xs text-muted-foreground">
                  This channel sits under {channel?.parentName ?? "a silent"}{" "}
                  category, so it always posts silently and tags nobody
                  regardless of the selection above.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Urgent alerts always add{" "}
                  {DISCORD_ESCALATION_GROUP_KEYS.map(
                    (key) =>
                      DISCORD_MENTION_GROUPS.find((group) => group.key === key)
                        ?.label ?? key,
                  ).join(" and ")}
                  , even if they are not selected here.
                </p>
              )}
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
                            <span className="text-sm font-medium">
                              {event.label}
                            </span>
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

function formatTimestamp(value: string): string {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return "at an unknown time";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}
