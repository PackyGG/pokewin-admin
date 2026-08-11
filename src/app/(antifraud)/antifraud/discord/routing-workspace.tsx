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
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { StepUpField } from "@/components/step-up-field";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import type {
  DiscordNotificationChannel,
  DiscordNotificationConfig,
  DiscordNotificationEvent,
} from "@/lib/discord-notifications/config";
import {
  APPROVED_DISCORD_CATEGORY_IDS,
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
  const isMobile = useIsMobile();
  const [pending, startTransition] = useTransition();
  const [editor, setEditor] = useState<ChannelEditorState | null>(null);
  const [editingChannelId, setEditingChannelId] = useState<string | null>(null);
  const [eventQuery, setEventQuery] = useState("");
  const [createChannelOpen, setCreateChannelOpen] = useState(false);
  const [mobileEditorOpen, setMobileEditorOpen] = useState(false);
  const [showUnassigned, setShowUnassigned] = useState(false);
  const [collapsedCategoryIds, setCollapsedCategoryIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [credential, setCredential] = useState("");
  const [pendingMutation, setPendingMutation] =
    useState<PendingMutation | null>(null);
  // Confirmation state for the destructive channel removal. Replaces the
  // native window.confirm — identical wording, identical arguments.
  const [pendingRemoveChannel, setPendingRemoveChannel] =
    useState<DiscordNotificationChannel | null>(null);
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
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
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
          (a, b) => a.position - b.position || a.name.localeCompare(b.name),
        ) ?? [],
    [approvedCategoryIds, initialConfig],
  );

  const unassignedEvents = useMemo(() => {
    if (!initialConfig) return [];
    const liveChannelIds = new Set(
      initialConfig.channels.map((channel) => channel.id),
    );
    const routedEventKeys = new Set(
      initialConfig.routes
        .filter((route) => route.enabled && liveChannelIds.has(route.channelId))
        .map((route) => route.eventKey),
    );
    return initialConfig.events.filter(
      (event) => event.enabled && !routedEventKeys.has(event.key),
    );
  }, [initialConfig]);

  if (!initialConfig) {
    return (
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-6">
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
    if (
      claimedElsewhere.has(event.key) &&
      !editor?.eventKeys.includes(event.key)
    )
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
    if (editorHasUnsavedChanges()) {
      toast.error("Save or cancel the current changes first.");
      return;
    }
    setShowUnassigned(false);
    setEditingChannelId(null);
    setEventQuery("");
    setEditor({
      channelId: availableChannels[0]?.id ?? "",
      eventKeys: [],
      // Matches the seeded default for existing channels: first-line support.
      // Silent categories drop tags at enqueue time regardless of this.
      mentionGroupKeys: ["support"],
    });
    if (isMobile) setMobileEditorOpen(true);
  }

  function openExistingChannel(channelId: string) {
    if (editingChannelId !== channelId && editorHasUnsavedChanges()) {
      toast.error("Save or cancel the current changes first.");
      return;
    }
    setShowUnassigned(false);
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
    if (isMobile) setMobileEditorOpen(true);
  }

  function closeEditor() {
    setMobileEditorOpen(false);
    setShowUnassigned(false);
    setEditor(null);
    setEditingChannelId(null);
    setEventQuery("");
  }

  function openUnassignedEvents() {
    if (editorHasUnsavedChanges()) {
      toast.error("Save or cancel the current changes first.");
      return;
    }
    setEditor(null);
    setEditingChannelId(null);
    setEventQuery("");
    setShowUnassigned(true);
    if (isMobile) setMobileEditorOpen(true);
  }

  function editorHasUnsavedChanges(): boolean {
    if (!editor) return false;
    const sameKeys = (left: readonly string[], right: readonly string[]) =>
      [...left].sort().join("\u0000") === [...right].sort().join("\u0000");

    if (!editingChannelId) {
      return (
        editor.eventKeys.length > 0 ||
        !sameKeys(editor.mentionGroupKeys, ["support"])
      );
    }

    const savedEvents = config.routes
      .filter(
        (route) =>
          route.channelId === editingChannelId &&
          route.enabled &&
          config.events.some(
            (event) => event.key === route.eventKey && event.enabled,
          ),
      )
      .map((route) => route.eventKey);
    const savedMentions =
      config.channelMentions.find(
        (mention) => mention.channelId === editingChannelId,
      )?.groupKeys ?? [];
    return (
      !sameKeys(editor.eventKeys, savedEvents) ||
      !sameKeys(editor.mentionGroupKeys, savedMentions)
    );
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
      editingChannelId
        ? () => {
            if (isMobile) closeEditor();
          }
        : closeEditor,
    );
  }

  function removeChannel(channel: DiscordNotificationChannel) {
    setPendingRemoveChannel(channel);
  }

  function confirmRemoveChannel() {
    const channel = pendingRemoveChannel;
    if (!channel) return;
    setPendingRemoveChannel(null);
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
          <RefreshCw className={cn(pending && "motion-safe:animate-spin")} />
          Refresh
        </Button>
      </div>

      <section className="grid min-h-[580px] overflow-hidden rounded-xl border border-border/60 bg-card md:grid-cols-[280px_minmax(0,1fr)]">
        <aside
          aria-label="Discord channel tree"
          className="min-w-0 border-border/60 md:border-r"
        >
          <div className="flex h-12 items-center gap-2 border-b border-border/60 px-3">
            <span className="min-w-0 flex-1 text-sm font-semibold">Channels</span>
            <Button
              variant={showUnassigned ? "secondary" : "ghost"}
              size="sm"
              className="h-7 gap-1 px-2 text-xs"
              onClick={openUnassignedEvents}
            >
              Unassigned
              <Badge variant="outline" className="h-5 px-1.5 tabular-nums">
                {unassignedEvents.length}
              </Badge>
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Add Discord channel"
                  />
                }
              >
                <Plus />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-52">
                <DropdownMenuItem
                  disabled={pending || availableCategories.length === 0}
                  onClick={() => setCreateChannelOpen(true)}
                >
                  <FolderPlus />
                  Create Discord channel
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={
                    pending ||
                    availableChannels.length === 0 ||
                    enabledEvents.length === 0
                  }
                  onClick={openNewChannel}
                >
                  <Hash />
                  Add existing
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div role="tree" className="max-h-[720px] overflow-y-auto p-2">
            {activeChannelGroups.length === 0 ? (
              <p className="px-3 py-10 text-center text-sm text-muted-foreground">
                No configured channels.
              </p>
            ) : (
              activeChannelGroups.map((group) => {
                const categoryOpen = !collapsedCategoryIds.has(group.id);
                return (
                  <Collapsible
                    key={group.id}
                    open={categoryOpen}
                    onOpenChange={(open) =>
                      setCollapsedCategoryIds((current) => {
                        const next = new Set(current);
                        if (open) next.delete(group.id);
                        else next.add(group.id);
                        return next;
                      })
                    }
                    className="mb-2 last:mb-0"
                  >
                    <CollapsibleTrigger
                      className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left hover:bg-muted/60"
                      aria-label={`${categoryOpen ? "Collapse" : "Expand"} ${group.name}`}
                    >
                      <ChevronDown
                        className={cn(
                          "size-3.5 text-muted-foreground transition-transform",
                          !categoryOpen && "-rotate-90",
                        )}
                      />
                      <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                        {group.name}
                      </span>
                      <span className="text-[11px] tabular-nums text-muted-foreground">
                        {group.channels.length}
                      </span>
                    </CollapsibleTrigger>
                    <CollapsibleContent className="mt-1 space-y-0.5">
                      {group.channels.map((channel) => {
                        const eventCount = initialConfig.routes.filter(
                          (route) =>
                            route.channelId === channel.id &&
                            route.enabled &&
                            initialConfig.events.some(
                              (event) =>
                                event.key === route.eventKey && event.enabled,
                            ),
                        ).length;
                        const selected = editingChannelId === channel.id;
                        return (
                          <div
                            key={channel.id}
                            className={cn(
                              "group flex items-center rounded-md border border-transparent",
                              selected && "border-primary/30 bg-primary/5",
                            )}
                          >
                            <button
                              type="button"
                              role="treeitem"
                              aria-selected={selected}
                              className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              onClick={() => openExistingChannel(channel.id)}
                            >
                              <DeliveryIndicator channel={channel} />
                              <span className="min-w-0 flex-1 truncate text-sm">
                                #{channel.name}
                              </span>
                              <span className="text-xs tabular-nums text-muted-foreground">
                                {eventCount}
                              </span>
                            </button>
                            <DropdownMenu>
                              <DropdownMenuTrigger
                                render={
                                  <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    className="mr-0.5 opacity-60 hover:opacity-100"
                                    aria-label={`Actions for #${channel.name}`}
                                  />
                                }
                              >
                                <MoreHorizontal />
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem
                                  variant="destructive"
                                  disabled={pending}
                                  onClick={() => removeChannel(channel)}
                                >
                                  <Trash2 />
                                  Remove channel
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        );
                      })}
                    </CollapsibleContent>
                  </Collapsible>
                );
              })
            )}
          </div>
        </aside>

        <div className="hidden min-w-0 md:block">
          {showUnassigned ? (
            <UnassignedEventsPanel events={unassignedEvents} />
          ) : editor ? (
            <ChannelEditorPanel
              editor={editor}
              editingChannelId={editingChannelId}
              channels={
                editingChannelId ? initialConfig.channels : availableChannels
              }
              events={filteredEvents}
              eventQuery={eventQuery}
              pending={pending}
              onEventQueryChange={setEventQuery}
              onEditorChange={setEditor}
              onToggleEvent={toggleEvent}
              onToggleMentionGroup={toggleMentionGroup}
              onClose={closeEditor}
              onSave={saveChannel}
            />
          ) : (
            <div className="flex min-h-[580px] items-center justify-center p-8 text-sm text-muted-foreground">
              Select a channel to manage its alerts.
            </div>
          )}
        </div>
      </section>

      {isMobile && (
        <Sheet
          open={mobileEditorOpen}
          onOpenChange={(open) => {
            if (!open && editorHasUnsavedChanges()) {
              toast.error("Save or cancel the current changes first.");
              return;
            }
            if (!open) closeEditor();
          }}
        >
          <SheetContent
            side="right"
            className="w-full max-w-none gap-0 overflow-hidden p-0 md:hidden"
          >
            <SheetHeader className="border-b border-border/60">
              <SheetTitle>
                {showUnassigned
                  ? "Unassigned alerts"
                  : editingChannelId
                    ? `#${initialConfig.channels.find((channel) => channel.id === editingChannelId)?.name ?? "channel"}`
                    : "Add channel"}
              </SheetTitle>
            </SheetHeader>
            {showUnassigned ? (
              <UnassignedEventsPanel events={unassignedEvents} compact />
            ) : editor ? (
              <ChannelEditorPanel
                editor={editor}
                editingChannelId={editingChannelId}
                channels={
                  editingChannelId ? initialConfig.channels : availableChannels
                }
                events={filteredEvents}
                eventQuery={eventQuery}
                pending={pending}
                onEventQueryChange={setEventQuery}
                onEditorChange={setEditor}
                onToggleEvent={toggleEvent}
                onToggleMentionGroup={toggleMentionGroup}
                onClose={closeEditor}
                onSave={saveChannel}
              />
            ) : null}
          </SheetContent>
        </Sheet>
      )}

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

      <AlertDialog
        open={pendingRemoveChannel !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setPendingRemoveChannel(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingRemoveChannel
                ? `Remove #${pendingRemoveChannel.name} and all of its event assignments?`
                : ""}
            </AlertDialogTitle>
            <AlertDialogDescription>
              The channel stops receiving every antifraud event it is routed to.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={confirmRemoveChannel}
              disabled={pending || !pendingRemoveChannel}
            >
              Remove channel
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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

function ChannelEditorPanel({
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
}: {
  editor: ChannelEditorState;
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
}) {
  const channel = channels.find(
    (candidate) => candidate.id === editor.channelId,
  );
  const silentChannel = isSilentDiscordCategory(channel?.parentId ?? null);
  const groupedEvents = [...new Set(events.map((event) => event.category))]
    .sort((a, b) => a.localeCompare(b))
    .map((category) => ({
      category,
      events: events.filter((event) => event.category === category),
    }));

  return (
    <section
      aria-label="Channel editor"
      className="flex min-h-[580px] min-w-0 flex-col"
    >
      <div className="flex h-12 items-center gap-2 border-b border-border/60 px-4">
        <Hash className="size-4 text-[#5865F2]" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">
          {editingChannelId ? `#${channel?.name ?? "channel"}` : "Add existing channel"}
        </h2>
        {channel && <DeliveryBadge channel={channel} />}
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4 sm:p-5">
        {!editingChannelId && (
          <div className="space-y-1.5">
            <Label>Discord channel</Label>
            <Select
              value={editor.channelId}
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
        )}

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <Label>Tags</Label>
            <span className="text-xs tabular-nums text-muted-foreground">
              {silentChannel
                ? "Posts silently"
                : editor.mentionGroupKeys.length === 0
                  ? "Nobody tagged"
                  : `${editor.mentionGroupKeys.length} selected`}
            </span>
          </div>
          {silentChannel ? (
            <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5 text-sm text-muted-foreground">
              Errors and KYC channels never tag anyone.
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
              {DISCORD_MENTION_GROUPS.map((group) => {
                const checked = editor.mentionGroupKeys.includes(group.key);
                return (
                  <label
                    key={group.key}
                    title={group.description}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 transition-colors",
                      checked
                        ? "border-cyan-500/30 bg-cyan-500/5"
                        : "border-border/60 hover:bg-muted/60",
                    )}
                  >
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(value) =>
                        onToggleMentionGroup(group.key, value === true)
                      }
                    />
                    <span className="truncate text-sm font-medium">
                      {group.label}
                    </span>
                  </label>
                );
              })}
            </div>
          )}
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <Label>Alerts</Label>
            <span className="text-xs tabular-nums text-muted-foreground">
              {editor.eventKeys.length} selected
            </span>
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={eventQuery}
              onChange={(event) => onEventQueryChange(event.target.value)}
              placeholder="Find an alert"
              className="pl-9"
            />
          </div>
          <div className="max-h-[420px] overflow-y-auto rounded-xl border border-border/60">
            {groupedEvents.length === 0 ? (
              <p className="px-3 py-10 text-center text-sm text-muted-foreground">
                No matching alerts.
              </p>
            ) : (
              groupedEvents.map((group) => (
                <div key={group.category}>
                  <div className="sticky top-0 z-[1] border-y border-border/50 bg-muted/70 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground first:border-t-0">
                    {group.category}
                  </div>
                  <div className="divide-y divide-border/40">
                    {group.events.map((event) => {
                      const checked = editor.eventKeys.includes(event.key);
                      return (
                        <label
                          key={event.key}
                          title={event.description}
                          className={cn(
                            "flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors",
                            checked ? "bg-cyan-500/5" : "hover:bg-muted/40",
                          )}
                        >
                          <Checkbox
                            checked={checked}
                            onCheckedChange={(value) =>
                              onToggleEvent(event.key, value === true)
                            }
                          />
                          <span className="min-w-0 flex-1 truncate text-sm">
                            {event.label}
                          </span>
                          {event.custom && (
                            <Badge variant="secondary">Custom</Badge>
                          )}
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
          </div>
          {editor.eventKeys.length === 0 && (
            <p className="text-xs text-amber-500">Select at least one alert.</p>
          )}
        </div>
      </div>

      <div className="flex shrink-0 justify-end gap-2 border-t border-border/60 bg-card p-4">
        <Button variant="outline" disabled={pending} onClick={onClose}>
          Cancel
        </Button>
        <Button
          disabled={
            pending || !editor.channelId || editor.eventKeys.length === 0
          }
          onClick={onSave}
        >
          {editingChannelId ? "Save changes" : "Add channel"}
        </Button>
      </div>
    </section>
  );
}

function UnassignedEventsPanel({
  events,
  compact = false,
}: {
  events: DiscordNotificationEvent[];
  compact?: boolean;
}) {
  return (
    <section
      aria-label="Unassigned alerts"
      className={cn("min-h-[580px] p-4 sm:p-5", compact && "overflow-y-auto")}
    >
      <div className="mb-3 flex items-center gap-2">
        <AlertTriangle className="size-4 text-amber-500" />
        <h2 className="text-sm font-semibold">Unassigned alerts</h2>
        <Badge variant="outline" className="tabular-nums">
          {events.length}
        </Badge>
      </div>
      {events.length === 0 ? (
        <p className="rounded-lg border border-border/60 bg-muted/30 px-3 py-8 text-center text-sm text-muted-foreground">
          Every enabled alert has a channel.
        </p>
      ) : (
        <div className="divide-y divide-border/40 overflow-hidden rounded-lg border border-border/60">
          {events.map((event) => (
            <div
              key={event.key}
              title={event.description}
              className="flex items-center gap-3 px-3 py-2.5"
            >
              <span className="min-w-0 flex-1 truncate text-sm">
                {event.label}
              </span>
              <Badge variant="outline" className="text-[10px]">
                {event.category}
              </Badge>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function DeliveryIndicator({
  channel,
}: {
  channel: DiscordNotificationChannel;
}) {
  const ready = channel.canView && channel.canSend && channel.canEmbed;
  return (
    <span
      className={cn(
        "size-2 shrink-0 rounded-full",
        ready ? "bg-emerald-500" : "bg-destructive",
      )}
      title={ready ? "Ready" : "Missing Discord permissions"}
      aria-label={ready ? "Ready" : "Missing Discord permissions"}
    />
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
