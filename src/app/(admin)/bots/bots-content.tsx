"use client";

import { useCallback, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Bot, Pencil, Upload } from "lucide-react";
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
  DialogFooter,
} from "@/components/ui/dialog";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { toggleBotActive, createBot, updateBot } from "./actions";
import { uploadImageClient } from "@/lib/upload-image-client";
import { EmptyState } from "@/components/empty-state";
import { Spinner, transition } from "@/components/ux";
import { cn } from "@/lib/utils";
import type { BotListItem } from "@/lib/queries/bots";

function ImageDropzone({
  preview,
  onFile,
  onClear,
}: {
  preview: string | null;
  onFile: (file: File) => void;
  onClear: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const handleFile = useCallback(
    (file: File) => {
      if (file.type.startsWith("image/")) onFile(file);
    },
    [onFile],
  );

  if (preview) {
    return (
      <div className="relative inline-block">
        <img src={preview} alt="Preview" className="h-24 rounded-lg object-contain" />
        <button
          type="button"
          onClick={onClear}
          className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-destructive text-destructive-foreground text-xs"
        >
          &times;
        </button>
      </div>
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => inputRef.current?.click()}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") inputRef.current?.click(); }}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const file = e.dataTransfer.files[0];
        if (file) handleFile(file);
      }}
      className={cn(
        "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6",
        transition("colors", "fast"),
        dragging
          ? "border-primary bg-primary/5"
          : "border-muted-foreground/25 hover:border-muted-foreground/50",
      )}
    >
      <Upload className="size-6 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">
        Drop an image here or <span className="text-primary underline underline-offset-2">browse</span>
      </p>
      <p className="text-xs text-muted-foreground/60">PNG, JPG, WebP up to 5 MB</p>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFile(file);
        }}
      />
    </div>
  );
}

function EditBotButton({ bot }: { bot: BotListItem }) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const [username, setUsername] = useState(bot.username);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(bot.imageUrl);

  function handleSubmit() {
    if (!username.trim()) {
      toast.error("Please enter a username");
      return;
    }
    startTransition(async () => {
      try {
        let imageUrl = bot.imageUrl;

        if (imageFile) {
          imageUrl = await uploadImageClient(imageFile, "/bots");
        } else if (imagePreview === null) {
          imageUrl = null;
        }

        await updateBot(bot.id, { username: username.trim(), imageUrl });
        toast.success("Bot updated");
        setOpen(false);
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to update bot");
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v) {
          setUsername(bot.username);
          setImageFile(null);
          setImagePreview(bot.imageUrl);
        }
      }}
    >
      <DialogTrigger render={<Button size="icon" variant="ghost" />}>
        <Pencil className="size-3.5" />
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit Bot</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Image</Label>
            <ImageDropzone
              preview={imagePreview}
              onFile={(file) => { setImageFile(file); setImagePreview(URL.createObjectURL(file)); }}
              onClear={() => { setImageFile(null); setImagePreview(null); }}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Username</Label>
            <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="BotName" />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={handleSubmit} disabled={isPending || !username.trim()}>
            {isPending && <Spinner size={14} className="text-current" />}
            {isPending ? "Saving..." : "Save Changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function BotsContent({ data }: { data: BotListItem[] }) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [createImageFile, setCreateImageFile] = useState<File | null>(null);
  const [createImagePreview, setCreateImagePreview] = useState<string | null>(null);

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
        let imageUrl: string | null = null;
        if (createImageFile) {
          imageUrl = await uploadImageClient(createImageFile, "/bots");
        }
        await createBot({ username: username.trim(), imageUrl });
        toast.success("Bot created");
        setCreateOpen(false);
        setUsername("");
        setCreateImageFile(null);
        setCreateImagePreview(null);
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
            <div className="space-y-1.5">
              <Label>Image (optional)</Label>
              <ImageDropzone
                preview={createImagePreview}
                onFile={(file) => { setCreateImageFile(file); setCreateImagePreview(URL.createObjectURL(file)); }}
                onClear={() => { setCreateImageFile(null); setCreateImagePreview(null); }}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Username</Label>
              <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="BotName" />
            </div>
            <Button onClick={handleCreate} disabled={isPending} className="w-full">
              {isPending && <Spinner size={14} className="text-current" />}
              {isPending ? "Creating..." : "Create"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Mobile card list (<lg) */}
      <div className="lg:hidden">
        {data.length === 0 ? (
          <div className="rounded-md border">
            <EmptyState
              icon={Bot}
              title="No bots found"
              description="Create a bot to populate battles with house-controlled players."
              compact
            />
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border">
            {data.map((bot) => {
              const pnl = bot.totalWonUsd - bot.totalLostUsd;
              const pnlPositive = pnl >= 0;
              return (
                <div
                  key={bot.id}
                  className="border-b border-border/60 last:border-b-0 px-3 py-3"
                >
                  <div className="flex items-start gap-3">
                    {bot.imageUrl ? (
                      <img
                        src={bot.imageUrl}
                        alt={bot.username}
                        className="size-9 rounded-full object-cover shrink-0"
                      />
                    ) : (
                      <div className="size-9 rounded-full bg-muted shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium truncate">
                          {bot.username}
                        </span>
                        <Switch
                          checked={bot.isActive}
                          onCheckedChange={() => handleToggle(bot.id, bot.isActive)}
                          disabled={isPending}
                        />
                      </div>
                      <div className="mt-1 grid grid-cols-2 gap-x-3 text-[11px] text-muted-foreground">
                        <div>
                          <span className="text-[9px] uppercase tracking-wide">
                            Battles
                          </span>
                          <div className="tabular-nums">
                            {formatNumber(bot.battlesPlayed)} ({formatNumber(bot.battlesWon)} won)
                          </div>
                        </div>
                        <div>
                          <span className="text-[9px] uppercase tracking-wide">
                            Wagered
                          </span>
                          <div className="tabular-nums">
                            {formatCurrency(bot.totalWageredUsd)}
                          </div>
                        </div>
                      </div>
                      <div className="mt-1 flex items-center justify-between">
                        <span className="text-[10px] text-muted-foreground">
                          P&L:{" "}
                          <span
                            className={
                              "tabular-nums font-medium " +
                              (pnlPositive
                                ? "text-emerald-600 dark:text-emerald-400"
                                : "text-rose-600 dark:text-rose-400")
                            }
                          >
                            {formatCurrency(pnl)}
                          </span>
                          {bot.totalWageredUsd > 0 && (
                            <>
                              {" · "}
                              {((pnl / bot.totalWageredUsd) * 100).toFixed(2)}%
                            </>
                          )}
                        </span>
                        <EditBotButton bot={bot} />
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Desktop table (>=lg) */}
      <div className="hidden rounded-md border overflow-x-auto lg:block">
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
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((bot) => (
              <TableRow key={bot.id}>
                <TableCell className="font-medium">
                  <div className="flex items-center gap-2">
                    {bot.imageUrl ? (
                      <img src={bot.imageUrl} alt={bot.username} className="size-7 rounded-full object-cover" />
                    ) : (
                      <div className="size-7 rounded-full bg-muted" />
                    )}
                    {bot.username}
                  </div>
                </TableCell>
                <TableCell>{formatNumber(bot.battlesPlayed)}</TableCell>
                <TableCell>{formatNumber(bot.battlesWon)}</TableCell>
                <TableCell>{formatCurrency(bot.totalWageredUsd)}</TableCell>
                {/* Bots are house-controlled, so their P/L is the
                    house's P/L directly: bot wins = house gains, bot
                    losses = house losses. Palette matches the
                    emerald/rose house-POV tone used everywhere else. */}
                <TableCell className="text-emerald-600 dark:text-emerald-400">
                  {formatCurrency(bot.totalWonUsd)}
                </TableCell>
                <TableCell className="text-rose-600 dark:text-rose-400">
                  {formatCurrency(bot.totalLostUsd)}
                </TableCell>
                <TableCell
                  className={
                    bot.totalWonUsd - bot.totalLostUsd >= 0
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-rose-600 dark:text-rose-400"
                  }
                >
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
                <TableCell>
                  <EditBotButton bot={bot} />
                </TableCell>
              </TableRow>
            ))}
            {data.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={10} className="p-0">
                  <EmptyState
                    icon={Bot}
                    title="No bots found"
                    description="Create a bot to populate battles with house-controlled players."
                    compact
                  />
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
