"use client";

import { useState, useEffect, useRef, useTransition, useCallback, memo } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Trash2, Pin, PinOff, Ban, VolumeX, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime, formatRelative } from "@/lib/utils/format";
import type { ChatMessageItem, MuteItem } from "@/lib/queries/chat";
import { deleteMessage, pinMessage, unpinMessage, muteUser, unmuteUser, pollMessages } from "./actions";
import { banUser } from "../users/actions";

const ROLE_BADGE: Record<string, string> = {
  admin: "bg-red-500/20 text-red-400",
  support: "bg-blue-500/20 text-blue-400",
  creator: "bg-purple-500/20 text-purple-400",
  marketing: "bg-amber-500/20 text-amber-400",
};

export function ChatContent({
  tab,
  messages: initialMessages,
  mutes,
  role,
}: {
  tab: string;
  messages: ChatMessageItem[];
  mutes: MuteItem[];
  role: string;
}) {
  if (tab === "messages")
    return <ChatView initialMessages={initialMessages} role={role} />;
  return <MutesTable mutes={mutes} role={role} />;
}

// ── Chat bubble view ─────────────────────────────────────────────────

function ChatView({
  initialMessages,
  role,
}: {
  initialMessages: ChatMessageItem[];
  role: string;
}) {
  const [messages, setMessages] = useState<ChatMessageItem[]>(initialMessages);
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastPollRef = useRef<string>(
    initialMessages.length
      ? initialMessages[initialMessages.length - 1].createdAt
      : new Date().toISOString(),
  );

  // Sync when server sends a new batch (page change / search)
  useEffect(() => {
    setMessages(initialMessages);
    if (initialMessages.length) {
      lastPollRef.current =
        initialMessages[initialMessages.length - 1].createdAt;
    }
  }, [initialMessages]);

  // Auto-scroll on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  // Poll every 3s for new messages
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (!alive) return;
      try {
        const newer = await pollMessages(lastPollRef.current);
        if (newer.length && alive) {
          setMessages((prev) => {
            const ids = new Set(prev.map((m) => m.id));
            const fresh = newer.filter((m) => !ids.has(m.id));
            if (!fresh.length) return prev;
            lastPollRef.current = fresh[fresh.length - 1].createdAt;
            return [...prev, ...fresh.map((m) => ({ ...m, activeMuteId: null }))];
          });
        }
      } catch {
        // silently ignore polling errors
      }
    };
    const id = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="flex flex-col gap-1 overflow-y-auto rounded-lg border bg-card p-3"
      style={{ maxHeight: "calc(100vh - 220px)" }}
    >
      {messages.length === 0 && (
        <p className="py-12 text-center text-sm text-muted-foreground">
          No messages
        </p>
      )}
      {messages.map((m) => (
        <ChatBubble key={m.id} message={m} role={role} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}

// Memoized: ChatBubble props are only `message` (object ref, stable for
// existing rows since the poll only appends new items) and `role` (string
// prop from parent, stable for the session). Without memo every 3s poll
// re-renders every bubble in the list.
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
      className={`group relative flex items-start gap-2.5 rounded-lg px-3 py-2 transition-colors hover:bg-accent/30 ${
        m.isDeleted ? "opacity-40" : ""
      }`}
    >
      {/* Avatar */}
      <Link
        href={`/users/${m.userId}`}
        className="shrink-0"
      >
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

      {/* Content */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-1.5">
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
          {m.isPinned && (
            <Pin className="size-3 text-blue-400" />
          )}
          {m.isDeleted && (
            <Badge
              variant="outline"
              className="ml-1 border-red-500/30 bg-red-500/10 px-1 py-0 text-[9px] text-red-400"
            >
              deleted
            </Badge>
          )}
        </div>
        <p className="mt-0.5 break-words text-sm leading-5 text-foreground/80">
          {m.content}
        </p>
      </div>

      {/* Hover actions — no animation, instant show/hide */}
      <div className="absolute right-2 top-1.5 hidden items-center gap-0.5 rounded-md border bg-popover p-0.5 shadow group-hover:flex">
        {canDelete && !m.isDeleted && (
          <ConfirmAction
            title="Delete message?"
            description={`"${m.content.slice(0, 80)}${m.content.length > 80 ? "…" : ""}"`}
            onConfirm={() => act(() => deleteMessage(m.id), "Message deleted")}
            isPending={isPending}
            tooltip="Delete message"
          >
            <Trash2 className="size-3 text-red-400" />
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

// ── Shared action helpers ─────────────────────────────────────────────

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
  return (
    <AlertDialog>
      <AlertDialogTrigger render={
        <Button variant="ghost" size="icon" className="size-6" title={tooltip} disabled={isPending} />
      }>
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
          <AlertDialogAction onClick={onConfirm}>Confirm</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ── Mute dialog ──────────────────────────────────────────────────────

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
      <DialogTrigger render={
        <Button variant="ghost" size="icon" className="size-6" disabled={isPending} />
      }>
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
          <Button
            className="w-full"
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
                  toast.error(
                    e instanceof Error ? e.message : "Failed",
                  );
                }
              });
            }}
          >
            {pending ? "Muting…" : "Mute"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Ban dialog ───────────────────────────────────────────────────────

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
      <AlertDialogTrigger render={
        <Button variant="ghost" size="icon" className="size-6" disabled={isPending} />
      }>
        <Ban className="size-3 text-red-400" />
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
                  toast.error(
                    e instanceof Error ? e.message : "Failed",
                  );
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

// ── Mutes table (unchanged tab) ──────────────────────────────────────

function MutesTable({ mutes, role }: { mutes: MuteItem[]; role: string }) {
  const canMute = role === "admin" || role === "support";
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const [muteOpen, setMuteOpen] = useState(false);
  const [muteUserId, setMuteUserId] = useState("");
  const [muteReason, setMuteReason] = useState("");
  const [muteExpires, setMuteExpires] = useState("");

  function handleUnmute(muteId: string) {
    startTransition(async () => {
      try {
        await unmuteUser(muteId);
        toast.success("User unmuted");
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed");
      }
    });
  }

  function handleMute() {
    if (!muteUserId.trim()) {
      toast.error("Please enter a user ID");
      return;
    }
    startTransition(async () => {
      try {
        await muteUser({
          userId: muteUserId.trim(),
          reason: muteReason,
          expiresAt: muteExpires || null,
        });
        toast.success("User muted");
        setMuteOpen(false);
        setMuteUserId("");
        setMuteReason("");
        setMuteExpires("");
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed");
      }
    });
  }

  return (
    <div className="space-y-4">
      {canMute && (
        <Dialog open={muteOpen} onOpenChange={setMuteOpen}>
          <DialogTrigger render={<Button />}>Mute User</DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Mute User</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>User ID</Label>
                <Input
                  value={muteUserId}
                  onChange={(e) => setMuteUserId(e.target.value)}
                  placeholder="User ID"
                />
              </div>
              <div className="space-y-2">
                <Label>Reason</Label>
                <Input
                  value={muteReason}
                  onChange={(e) => setMuteReason(e.target.value)}
                  placeholder="Reason for mute"
                />
              </div>
              <div className="space-y-2">
                <Label>Expires At (optional)</Label>
                <Input
                  type="datetime-local"
                  value={muteExpires}
                  onChange={(e) => setMuteExpires(e.target.value)}
                />
              </div>
              <Button
                onClick={handleMute}
                disabled={isPending}
                className="w-full"
              >
                {isPending ? "Muting..." : "Mute"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Muted By</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {mutes.map((m) => (
              <TableRow key={m.id}>
                <TableCell>
                  <Link
                    href={`/users/${m.userId}`}
                    className="hover:underline"
                  >
                    {m.username ?? m.userId.slice(0, 8)}
                  </Link>
                </TableCell>
                <TableCell>{m.mutedByUsername ?? "-"}</TableCell>
                <TableCell>{m.reason ?? "-"}</TableCell>
                <TableCell>
                  {m.expiresAt ? formatDateTime(m.expiresAt) : "Permanent"}
                </TableCell>
                <TableCell>
                  {m.unmutedAt ? (
                    <Badge
                      variant="outline"
                      className="border-green-500/30 bg-green-500/15 text-green-400"
                    >
                      Unmuted
                    </Badge>
                  ) : (
                    <Badge
                      variant="outline"
                      className="border-red-500/30 bg-red-500/15 text-red-400"
                    >
                      Active
                    </Badge>
                  )}
                </TableCell>
                <TableCell>{formatDateTime(m.createdAt)}</TableCell>
                <TableCell>
                  {canMute && !m.unmutedAt && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleUnmute(m.id)}
                      disabled={isPending}
                    >
                      Unmute
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {mutes.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={7}
                  className="h-24 text-center"
                >
                  No mutes found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
