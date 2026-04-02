"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
import { formatDateTime } from "@/lib/utils/format";
import type { ChatMessageItem, MuteItem } from "@/lib/queries/chat";
import { deleteMessage, pinMessage, unpinMessage, muteUser, unmuteUser } from "./actions";
import { banUser } from "../users/actions";

export function ChatContent({
  tab,
  messages,
  mutes,
  role,
}: {
  tab: string;
  messages: ChatMessageItem[];
  mutes: MuteItem[];
  role: string;
}) {
  if (tab === "messages") return <MessagesTable messages={messages} role={role} />;
  return <MutesTable mutes={mutes} role={role} />;
}

function MessagesTable({ messages, role }: { messages: ChatMessageItem[]; role: string }) {
  const canDelete = role === "admin" || role === "support";
  const canPin = role === "admin" || role === "marketing";
  const canMute = role === "admin" || role === "support";
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const [banReason, setBanReason] = useState("");
  const [muteReason, setMuteReason] = useState("");
  const [muteExpires, setMuteExpires] = useState("");

  function handleDelete(id: string) {
    startTransition(async () => {
      try {
        await deleteMessage(id);
        toast.success("Message deleted");
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed");
      }
    });
  }

  function handlePin(id: string) {
    startTransition(async () => {
      try {
        await pinMessage(id);
        toast.success("Message pinned");
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed");
      }
    });
  }

  function handleUnpin(id: string) {
    startTransition(async () => {
      try {
        await unpinMessage(id);
        toast.success("Message unpinned");
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed");
      }
    });
  }

  function handleBan(userId: string) {
    if (!banReason.trim()) {
      toast.error("Please enter a ban reason");
      return;
    }
    startTransition(async () => {
      try {
        await banUser(userId, banReason.trim());
        toast.success("User banned");
        setBanReason("");
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed");
      }
    });
  }

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

  function handleMute(userId: string) {
    startTransition(async () => {
      try {
        await muteUser({
          userId,
          reason: muteReason.trim(),
          expiresAt: muteExpires || null,
        });
        toast.success("User muted");
        setMuteReason("");
        setMuteExpires("");
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed");
      }
    });
  }

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>User</TableHead>
            <TableHead>Content</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Date</TableHead>
            <TableHead>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {messages.map((m) => (
            <TableRow key={m.id}>
              <TableCell>
                <Link href={`/users/${m.userId}`} className="hover:underline">
                  {m.username ?? m.userId.slice(0, 8)}
                </Link>
              </TableCell>
              <TableCell className="max-w-md truncate">{m.content}</TableCell>
              <TableCell>
                <div className="flex gap-1">
                  {m.isDeleted && (
                    <Badge variant="outline" className="bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30">
                      Deleted
                    </Badge>
                  )}
                  {m.isPinned && (
                    <Badge variant="outline" className="bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30">
                      Pinned
                    </Badge>
                  )}
                </div>
              </TableCell>
              <TableCell>{formatDateTime(m.createdAt)}</TableCell>
              <TableCell>
                <div className="flex gap-1">
                  {canDelete && !m.isDeleted && (
                    <Button size="sm" variant="destructive" onClick={() => handleDelete(m.id)} disabled={isPending}>
                      Delete
                    </Button>
                  )}
                  {canDelete && (
                    <AlertDialog>
                      <AlertDialogTrigger render={<Button size="sm" variant="destructive" disabled={isPending} />}>
                        Ban
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Ban {m.username ?? m.userId.slice(0, 8)}?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This will ban the user and terminate all their sessions.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <div className="space-y-2">
                          <Label>Reason</Label>
                          <Input
                            value={banReason}
                            onChange={(e) => setBanReason(e.target.value)}
                            placeholder="Reason for ban"
                          />
                        </div>
                        <AlertDialogFooter>
                          <AlertDialogCancel onClick={() => setBanReason("")}>Cancel</AlertDialogCancel>
                          <AlertDialogAction onClick={() => handleBan(m.userId)}>
                            Ban User
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  )}
                  {canMute && (m.activeMuteId ? (
                    <Button size="sm" variant="outline" onClick={() => handleUnmute(m.activeMuteId!)} disabled={isPending}>
                      Unmute
                    </Button>
                  ) : (
                    <Dialog>
                      <DialogTrigger render={<Button size="sm" variant="outline" disabled={isPending} />}>
                        Mute
                      </DialogTrigger>
                      <DialogContent>
                        <DialogHeader>
                          <DialogTitle>Mute {m.username ?? m.userId.slice(0, 8)}</DialogTitle>
                        </DialogHeader>
                        <div className="space-y-4">
                          <div className="space-y-2">
                            <Label>Reason (optional)</Label>
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
                          <Button onClick={() => handleMute(m.userId)} disabled={isPending} className="w-full">
                            {isPending ? "Muting..." : "Mute User"}
                          </Button>
                        </div>
                      </DialogContent>
                    </Dialog>
                  ))}
                  {canPin && (m.isPinned ? (
                    <Button size="sm" variant="outline" onClick={() => handleUnpin(m.id)} disabled={isPending}>
                      Unpin
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => handlePin(m.id)} disabled={isPending}>
                      Pin
                    </Button>
                  ))}
                </div>
              </TableCell>
            </TableRow>
          ))}
          {messages.length === 0 && (
            <TableRow>
              <TableCell colSpan={5} className="h-24 text-center">
                No messages found.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}

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
      {canMute && <Dialog open={muteOpen} onOpenChange={setMuteOpen}>
        <DialogTrigger render={<Button />}>
          Mute User
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mute User</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>User ID</Label>
              <Input value={muteUserId} onChange={(e) => setMuteUserId(e.target.value)} placeholder="User ID" />
            </div>
            <div className="space-y-2">
              <Label>Reason</Label>
              <Input value={muteReason} onChange={(e) => setMuteReason(e.target.value)} placeholder="Reason for mute" />
            </div>
            <div className="space-y-2">
              <Label>Expires At (optional)</Label>
              <Input type="datetime-local" value={muteExpires} onChange={(e) => setMuteExpires(e.target.value)} />
            </div>
            <Button onClick={handleMute} disabled={isPending} className="w-full">
              {isPending ? "Muting..." : "Mute"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>}

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
                  <Link href={`/users/${m.userId}`} className="hover:underline">
                    {m.username ?? m.userId.slice(0, 8)}
                  </Link>
                </TableCell>
                <TableCell>{m.mutedByUsername ?? "-"}</TableCell>
                <TableCell>{m.reason ?? "-"}</TableCell>
                <TableCell>{m.expiresAt ? formatDateTime(m.expiresAt) : "Permanent"}</TableCell>
                <TableCell>
                  {m.unmutedAt ? (
                    <Badge variant="outline" className="bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30">
                      Unmuted
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30">
                      Active
                    </Badge>
                  )}
                </TableCell>
                <TableCell>{formatDateTime(m.createdAt)}</TableCell>
                <TableCell>
                  {canMute && !m.unmutedAt && (
                    <Button size="sm" variant="outline" onClick={() => handleUnmute(m.id)} disabled={isPending}>
                      Unmute
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {mutes.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center">
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
