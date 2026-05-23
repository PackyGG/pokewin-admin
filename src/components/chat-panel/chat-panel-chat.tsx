"use client";

import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import {
  Ban,
  Loader2,
  Pin,
  PinOff,
  Search,
  Trash2,
  VolumeX,
  Volume2,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { ChatMessageItem } from "@/lib/queries/chat";
import { subscribePackyWs, type ChatMessage } from "@/lib/packy-ws";
import {
  deleteMessage,
  fetchChatMessagesPanel,
  muteUser,
  pinMessage,
  pollMessages,
  unmuteUser,
  unpinMessage,
} from "@/app/(admin)/chat/actions";
import { banUser } from "@/app/(admin)/users/actions";

const ROLE_BADGE: Record<string, string> = {
  admin: "bg-rose-500/20 text-rose-400",
  support: "bg-blue-500/20 text-blue-400",
  creator: "bg-purple-500/20 text-purple-400",
  marketing: "bg-amber-500/20 text-amber-400",
};

const PAGE_SIZE = 50;
// Cap the in-memory message list so a long-lived panel on a busy chat
// doesn't grow the array (and the DOM) without bound. We keep the most
// recent N — same approach the WS hooks use via `.slice`.
const MAX_MESSAGES = 200;

/**
 * Convert a packy.gg WebSocket `chat.pull.history` message into the
 * `ChatMessageItem` shape the panel already renders. The WS payload
 * uses snake_case ids + `created_at`; we translate to camelCase and
 * default the admin-only decoration fields (`isDeleted`, `isPinned`,
 * `activeMuteId`) to null/false — the WS doesn't carry mute / pin
 * state, so those flags stay at their "clean" value until the admin
 * refreshes the panel and the server query rehydrates them.
 *
 * Returns `null` for rows that are too malformed to render (missing id
 * or content). Caller filters those out.
 */
function normalizeWsChatMessage(
  m: ChatMessage,
): Omit<ChatMessageItem, "activeMuteId"> | null {
  if (!m || typeof m.id !== "string" || typeof m.content !== "string") {
    return null;
  }
  const createdAt =
    typeof m.created_at === "string" && m.created_at
      ? m.created_at
      : new Date().toISOString();
  return {
    id: m.id,
    userId: typeof m.user_id === "string" ? m.user_id : "",
    username: m.username ?? null,
    image: m.image ?? null,
    level: typeof m.level === "number" ? m.level : 0,
    role: m.role ?? "user",
    content: m.content,
    isDeleted: false,
    isPinned: false,
    createdAt,
  };
}

export function ChatPanelChat({ role }: { role: string }) {
  const [messages, setMessages] = useState<ChatMessageItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [activeSearch, setActiveSearch] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastPollRef = useRef<string>(new Date().toISOString());
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Live updates come from the packy.gg WebSocket (chat.pull.history) via
  // the `/api/packy-live` SSE proxy. The 3s polling loop below is only a
  // degraded fallback for browsers without EventSource — without it the
  // WS proxy can't connect either, so polling is the only way to stay
  // live. Computed once at mount; nothing flips it at runtime.
  const [useFallback] = useState<boolean>(
    () => typeof window !== "undefined" && typeof EventSource === "undefined",
  );

  // Accepts either full `ChatMessageItem`s (SSE stream) or the slimmer
  // rows returned by `pollMessages` (no `activeMuteId`). Both shapes
  // have the same base fields; mute state is loaded separately via the
  // initial panel fetch and defaults to null for live rows.
  const appendLive = useCallback(
    (incoming: Omit<ChatMessageItem, "activeMuteId">[]) => {
      if (incoming.length === 0) return;
      setMessages((prev) => {
        const ids = new Set(prev.map((m) => m.id));
        const fresh = incoming.filter((m) => !ids.has(m.id));
        if (!fresh.length) return prev;
        lastPollRef.current = fresh[fresh.length - 1].createdAt;
        const next = [
          ...prev,
          ...fresh.map((m) => ({ ...m, activeMuteId: null })),
        ];
        // Trim from the top (oldest) so the list stays bounded; the view
        // is oldest-at-top / newest-at-bottom, so we keep the tail.
        return next.length > MAX_MESSAGES
          ? next.slice(next.length - MAX_MESSAGES)
          : next;
      });
    },
    [],
  );

  // Initial + search-triggered load. Keeps the newest batch and reverses
  // so oldest-at-top matches the look of the original /chat page.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchChatMessagesPanel({
      page: 1,
      perPage: PAGE_SIZE,
      search: activeSearch || undefined,
    })
      .then((res) => {
        if (!alive) return;
        const asc = [...res.data].reverse();
        setMessages(asc);
        lastPollRef.current = asc.length
          ? asc[asc.length - 1].createdAt
          : new Date().toISOString();
      })
      .catch(() => {
        if (alive) toast.error("Failed to load messages");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [activeSearch]);

  // Debounced search — identical UX to the DataTableToolbar used previously
  // on /chat but scoped to the panel (no URL state).
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setActiveSearch(search.trim()), 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [search]);

  // Auto-scroll to latest on new messages.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  // packy.gg live WebSocket — the SINGLE live transport for the panel.
  // Subscribes to chat.pull.history and merges new messages into the
  // feed. (We previously also ran an SSE stream against /api/live/chat in
  // parallel, which double-polled the chat_messages table for the exact
  // same rows; the WS already carries chat without any DB polling, so the
  // SSE path was removed.) The append-path dedupes by message id. Paused
  // while the operator is searching, since the WS payload can't be
  // filtered server-side.
  useEffect(() => {
    if (activeSearch) return;
    return subscribePackyWs<{
      type: "chat.pull.history";
      payload: { messages: ChatMessage[] };
      timestamp: string;
    }>("chat.pull.history", (evt) => {
      const items = evt.payload?.messages;
      if (!Array.isArray(items) || items.length === 0) return;
      const normalized = items
        .map(normalizeWsChatMessage)
        .filter((m): m is Omit<ChatMessageItem, "activeMuteId"> => m != null);
      if (normalized.length > 0) appendLive(normalized);
    });
  }, [activeSearch, appendLive]);

  // Polling fallback — only active when EventSource isn't supported (very
  // old browsers). Without EventSource the packy WS proxy can't connect
  // either, so this 3s poll is the only way to keep the panel live. The
  // append-path dedupes by id so it never double-renders a message.
  useEffect(() => {
    if (activeSearch) return;
    if (!useFallback) return;
    let alive = true;
    const tick = async () => {
      if (!alive) return;
      // Skip while the tab is backgrounded so a hidden panel doesn't keep
      // polling the chat_messages table — matches the other live feeds.
      if (
        typeof document !== "undefined" &&
        document.visibilityState !== "visible"
      ) {
        return;
      }
      try {
        const newer = await pollMessages(lastPollRef.current);
        if (newer.length && alive) {
          appendLive(newer);
        }
      } catch {
        // Silently ignore — the user will see stale data but no noise.
      }
    };
    const id = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [activeSearch, useFallback, appendLive]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-border px-4 py-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search messages or username..."
            className="h-9 pl-8 pr-8"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label="Clear search"
            >
              <X className="size-4" />
            </button>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {loading ? (
          <ChatSkeleton />
        ) : messages.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">
            {activeSearch ? "No messages match your search." : "No messages yet."}
          </p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {messages.map((m) => (
              <ChatBubble key={m.id} message={m} role={role} />
            ))}
            <div ref={bottomRef} />
          </div>
        )}
      </div>
    </div>
  );
}

function ChatSkeleton() {
  return (
    <div className="flex flex-col gap-2 p-2">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex items-start gap-2.5 px-2 py-1.5">
          <Skeleton className="size-7 shrink-0 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-4 w-full max-w-sm" />
          </div>
        </div>
      ))}
    </div>
  );
}

// Memoized so the 3s poll doesn't re-render every existing bubble.
const ChatBubble = memo(function ChatBubble({
  message: m,
  role,
}: {
  message: ChatMessageItem;
  role: string;
}) {
  const canDelete = role === "admin" || role === "support";
  const canPin = role === "admin" || role === "marketing";
  const canMute = role === "admin" || role === "support";
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const act = useCallback(
    (fn: () => Promise<void>, msg: string) => {
      startTransition(async () => {
        try {
          await fn();
          toast.success(msg);
          router.refresh();
        } catch (e) {
          toast.error(e instanceof Error ? e.message : "Failed");
        }
      });
    },
    [router],
  );

  const time = new Date(m.createdAt);
  const timeStr = `${time.getHours().toString().padStart(2, "0")}:${time.getMinutes().toString().padStart(2, "0")}`;
  const isStaff = m.role !== "user";

  return (
    <div
      className={`group relative flex items-start gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-accent/40 ${
        m.isDeleted ? "opacity-40" : ""
      }`}
    >
      <Link href={`/users/${m.userId}`} className="shrink-0">
        <div className="size-7 overflow-hidden rounded-full bg-muted">
          {m.image && (m.image.startsWith("https://") || m.image.startsWith("http://")) ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={m.image}
              alt=""
              className="size-full object-cover"
              referrerPolicy="no-referrer"
            />
          ) : (
            <div className="flex size-full items-center justify-center text-xs font-bold text-muted-foreground">
              {(m.username ?? "?")[0].toUpperCase()}
            </div>
          )}
        </div>
      </Link>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-1.5">
          <Link
            href={`/users/${m.userId}`}
            className="text-sm font-semibold leading-none hover:underline"
          >
            {m.username ?? m.userId.slice(0, 8)}
          </Link>
          {m.level > 0 && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
              {m.level}
            </span>
          )}
          {isStaff && (
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-semibold capitalize ${ROLE_BADGE[m.role] ?? ""}`}
            >
              {m.role}
            </span>
          )}
          <span className="text-[11px] leading-none text-muted-foreground">
            {timeStr}
          </span>
          {m.isPinned && <Pin className="size-3 text-blue-400" />}
          {m.isDeleted && (
            <Badge
              variant="outline"
              className="ml-1 border-rose-500/30 bg-rose-500/10 px-1 py-0 text-[9px] text-rose-400"
            >
              deleted
            </Badge>
          )}
        </div>
        <p className="mt-0.5 break-words text-sm leading-5 text-foreground/80">
          {m.content}
        </p>
      </div>
      <div className="absolute right-1.5 top-1 hidden items-center gap-0.5 rounded-md border bg-popover p-0.5 shadow group-hover:flex">
        {canDelete && !m.isDeleted && (
          <ConfirmAction
            title="Delete message?"
            description={`"${m.content.slice(0, 80)}${m.content.length > 80 ? "…" : ""}"`}
            onConfirm={() => act(() => deleteMessage(m.id), "Message deleted")}
            isPending={isPending}
            tooltip="Delete message"
          >
            <Trash2 className="size-3 text-rose-400" />
          </ConfirmAction>
        )}
        {canPin &&
          (m.isPinned ? (
            <ActionButton
              tooltip="Unpin message"
              disabled={isPending}
              onClick={() => act(() => unpinMessage(m.id), "Unpinned")}
            >
              <PinOff className="size-3" />
            </ActionButton>
          ) : (
            <ActionButton
              tooltip="Pin message"
              disabled={isPending}
              onClick={() => act(() => pinMessage(m.id), "Pinned")}
            >
              <Pin className="size-3" />
            </ActionButton>
          ))}
        {canMute &&
          (m.activeMuteId ? (
            <ConfirmAction
              title={`Unmute ${m.username ?? m.userId.slice(0, 8)}?`}
              onConfirm={() => act(() => unmuteUser(m.activeMuteId!), "Unmuted")}
              isPending={isPending}
              tooltip="Unmute user"
            >
              <Volume2 className="size-3" />
            </ConfirmAction>
          ) : (
            <MuteDialog
              userId={m.userId}
              username={m.username}
              isPending={isPending}
            />
          ))}
        {canDelete && (
          <BanDialog
            userId={m.userId}
            username={m.username}
            isPending={isPending}
          />
        )}
      </div>
    </div>
  );
});

function ActionButton({
  tooltip,
  disabled,
  onClick,
  children,
}: {
  tooltip: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-6"
      title={tooltip}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function ConfirmAction({
  title,
  description,
  onConfirm,
  isPending,
  tooltip,
  children,
}: {
  title: string;
  description?: string;
  onConfirm: () => void;
  isPending: boolean;
  tooltip: string;
  children: React.ReactNode;
}) {
  // Controlled so we can explicitly close the dialog the moment the
  // operator confirms. Base-ui's default AlertDialogAction click
  // dispatches onClick but does not guarantee closing when the handler
  // kicks off an async transition — the user was seeing the dialog
  // stay open after "Confirm" even though the action ran successfully.
  const [open, setOpen] = useState(false);
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            title={tooltip}
            disabled={isPending}
          />
        }
      >
        {children}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description && (
            <AlertDialogDescription className="break-words">
              {description}
            </AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              onConfirm();
              setOpen(false);
            }}
          >
            Confirm
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function MuteDialog({
  userId,
  username,
  isPending,
}: {
  userId: string;
  username: string | null;
  isPending: boolean;
}) {
  const [reason, setReason] = useState("");
  const [expires, setExpires] = useState("");
  const [pending, start] = useTransition();
  const router = useRouter();

  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            disabled={isPending}
          />
        }
      >
        <VolumeX className="size-3" />
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Mute {username ?? userId.slice(0, 8)}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">Reason</Label>
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Optional reason"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Expires</Label>
            <Input
              type="datetime-local"
              value={expires}
              onChange={(e) => setExpires(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            className="w-full sm:w-auto"
            disabled={pending}
            onClick={() => {
              start(async () => {
                try {
                  await muteUser({
                    userId,
                    reason: reason.trim(),
                    expiresAt: expires || null,
                  });
                  toast.success("Muted");
                  router.refresh();
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : "Failed");
                }
              });
            }}
          >
            {pending ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                Muting…
              </>
            ) : (
              "Mute"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BanDialog({
  userId,
  username,
  isPending,
}: {
  userId: string;
  username: string | null;
  isPending: boolean;
}) {
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();
  const router = useRouter();

  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            disabled={isPending}
          />
        }
      >
        <Ban className="size-3 text-rose-400" />
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Ban {username ?? userId.slice(0, 8)}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Terminates all sessions and bans the user.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-1">
          <Label className="text-xs">Reason</Label>
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Ban reason"
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => setReason("")}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={pending || !reason.trim()}
            onClick={() => {
              start(async () => {
                try {
                  await banUser(userId, reason.trim());
                  toast.success("Banned");
                  setReason("");
                  router.refresh();
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : "Failed");
                }
              });
            }}
          >
            Ban
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
