"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, Copy } from "lucide-react";
import { toast } from "sonner";
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
  DialogFooter,
} from "@/components/ui/dialog";
import { addWhitelistUser, deleteWhitelistUser } from "./actions";
import type { WhitelistUser } from "@/lib/queries/whitelist";

function formatDate(date: Date | string) {
  return new Date(date).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function WhitelistContent({ data }: { data: WhitelistUser[] }) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [discordId, setDiscordId] = useState("");
  const [username, setUsername] = useState("");
  const [referralCode, setReferralCode] = useState("");

  function handleCreate() {
    if (!discordId.trim() || !username.trim()) {
      toast.error("Discord ID and username are required");
      return;
    }
    startTransition(async () => {
      try {
        await addWhitelistUser(discordId.trim(), username.trim(), referralCode.trim() || undefined);
        toast.success("User added to whitelist");
        setCreateOpen(false);
        setDiscordId("");
        setUsername("");
        setReferralCode("");
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to add user");
      }
    });
  }

  function handleDelete(userId: string, name: string) {
    if (!confirm(`Remove ${name} from the whitelist?`)) return;
    startTransition(async () => {
      try {
        await deleteWhitelistUser(userId);
        toast.success("User removed from whitelist");
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to remove user");
      }
    });
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text);
    toast.success("Copied to clipboard");
  }

  return (
    <div className="space-y-4">
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogTrigger render={<Button />}>
          <Plus className="mr-2 size-4" />
          Add User
        </DialogTrigger>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add to Whitelist</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>Discord ID</Label>
              <Input
                value={discordId}
                onChange={(e) => setDiscordId(e.target.value)}
                placeholder="123456789012345678"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Username</Label>
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="username"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Referral Code <span className="text-muted-foreground font-normal">(optional, auto-generated if empty)</span></Label>
              <Input
                value={referralCode}
                onChange={(e) => setReferralCode(e.target.value)}
                placeholder="leave empty for random"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              onClick={handleCreate}
              disabled={isPending || !discordId.trim() || !username.trim()}
            >
              {isPending ? "Adding..." : "Add User"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Username</TableHead>
              <TableHead>Discord ID</TableHead>
              <TableHead>Referral Code</TableHead>
              <TableHead>Flagged</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Claimed</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((user) => (
              <TableRow key={user.id}>
                <TableCell className="font-medium">{user.username}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-1">
                    <span className="font-mono text-xs">{user.discordId}</span>
                    <button
                      type="button"
                      onClick={() => copyToClipboard(user.discordId)}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <Copy className="size-3" />
                    </button>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1">
                    <span className="font-mono text-xs">{user.referralCode}</span>
                    <button
                      type="button"
                      onClick={() => copyToClipboard(user.referralCode)}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <Copy className="size-3" />
                    </button>
                  </div>
                </TableCell>
                <TableCell>
                  {user.flagged ? (
                    <span className="text-red-400">Yes</span>
                  ) : (
                    <span className="text-muted-foreground">No</span>
                  )}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {formatDate(user.createdAt)}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {user.claimedAt ? formatDate(user.claimedAt) : "—"}
                </TableCell>
                <TableCell>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    onClick={() => handleDelete(user.id, user.username)}
                    disabled={isPending}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {data.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center">
                  No whitelisted users found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
