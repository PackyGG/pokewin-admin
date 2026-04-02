"use client";

import { useCallback, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Upload } from "lucide-react";
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
      className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 transition-colors ${
        dragging ? "border-primary bg-primary/5" : "border-muted-foreground/25 hover:border-muted-foreground/50"
      }`}
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
                <TableCell>
                  <EditBotButton bot={bot} />
                </TableCell>
              </TableRow>
            ))}
            {data.length === 0 && (
              <TableRow>
                <TableCell colSpan={10} className="h-24 text-center">
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
