"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { toggleBotActive, createBot } from "./actions";
import type { BotListItem } from "@/lib/queries/bots";

export function BotsContent({ data }: { data: BotListItem[] }) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [imageUrl, setImageUrl] = useState("");

  function handleToggle(botId: string, isActive: boolean) {
    startTransition(async () => {
      try {
        await toggleBotActive(botId, !isActive);
        toast.success(isActive ? "Bot deactivated" : "Bot activated");
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed");
      }
    });
  }

  function handleCreate() {
    if (!username.trim()) {
      toast.error("Please enter a username");
      return;
    }
    startTransition(async () => {
      try {
        await createBot({ username: username.trim(), imageUrl: imageUrl || null });
        toast.success("Bot created");
        setCreateOpen(false);
        setUsername("");
        setImageUrl("");
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed");
      }
    });
  }

  return (
    <div className="space-y-4">
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogTrigger render={<Button />}>
          Create Bot
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Bot</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Username</Label>
              <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="BotName" />
            </div>
            <div className="space-y-2">
              <Label>Image URL (optional)</Label>
              <Input value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="https://..." />
            </div>
            <Button onClick={handleCreate} disabled={isPending} className="w-full">
              {isPending ? "Creating..." : "Create"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Username</TableHead>
              <TableHead>Battles</TableHead>
              <TableHead>Won</TableHead>
              <TableHead>Wagered</TableHead>
              <TableHead>Won (USD)</TableHead>
              <TableHead>Lost (USD)</TableHead>
              <TableHead>PnL</TableHead>
              <TableHead>House Edge</TableHead>
              <TableHead>Active</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((bot) => (
              <TableRow key={bot.id}>
                <TableCell className="font-medium">{bot.username}</TableCell>
                <TableCell>{formatNumber(bot.battlesPlayed)}</TableCell>
                <TableCell>{formatNumber(bot.battlesWon)}</TableCell>
                <TableCell>{formatCurrency(bot.totalWageredUsd)}</TableCell>
                <TableCell className="text-green-400">{formatCurrency(bot.totalWonUsd)}</TableCell>
                <TableCell className="text-red-400">{formatCurrency(bot.totalLostUsd)}</TableCell>
                <TableCell className={bot.totalWonUsd - bot.totalLostUsd >= 0 ? "text-green-400" : "text-red-400"}>
                  {formatCurrency(bot.totalWonUsd - bot.totalLostUsd)}
                </TableCell>
                <TableCell>
                  {bot.totalWageredUsd > 0
                    ? `${(((bot.totalWonUsd - bot.totalLostUsd) / bot.totalWageredUsd) * 100).toFixed(2)}%`
                    : "—"}
                </TableCell>
                <TableCell>
                  <Switch
                    checked={bot.isActive}
                    onCheckedChange={() => handleToggle(bot.id, bot.isActive)}
                    disabled={isPending}
                  />
                </TableCell>
              </TableRow>
            ))}
            {data.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="h-24 text-center">
                  No bots found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
