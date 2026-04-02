"use client";

import { useCallback, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { updateCard } from "../actions";
import { uploadImageClient } from "@/lib/upload-image-client";

type CardData = {
  id: string;
  name: string;
  imageUrl: string;
  priceUsd: number;
  hp: number | null;
  rarity: string | null;
  artist: string | null;
  tcgplayerId: number | null;
  type: string;
  cardNumber: string | null;
  setId: string | null;
  setName: string | null;
};

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

const RARITIES = ["Common", "Uncommon", "Rare", "Ultra Rare", "Secret"] as const;
const CARD_TYPES = ["card", "promo", "special"] as const;

export function EditCardButton({
  card,
  sets,
}: {
  card: CardData;
  sets?: { id: string; name: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const [name, setName] = useState(card.name);
  const [price, setPrice] = useState(String(card.priceUsd));
  const [hp, setHp] = useState(String(card.hp));
  const [rarity, setRarity] = useState(card.rarity);
  const [artist, setArtist] = useState(card.artist);
  const [tcgplayerId, setTcgplayerId] = useState(card.tcgplayerId ? String(card.tcgplayerId) : "");
  const [type, setType] = useState(card.type);
  const [cardNumber, setCardNumber] = useState(card.cardNumber ?? "");
  const [setId, setSetId] = useState(card.setId ?? "");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(card.imageUrl);

  const imageCleared = imagePreview === null && imageFile === null;

  function handleSubmit() {
    startTransition(async () => {
      try {
        if (imageCleared) {
          toast.error("Please select a new image");
          return;
        }

        let imageUrl = card.imageUrl;

        if (imageFile) {
          imageUrl = await uploadImageClient(imageFile, "/cards");
        }

        await updateCard(card.id, {
          name,
          imageUrl,
          price: parseFloat(price) || 0,
          hp: parseInt(hp) || 0,
          rarity,
          artist,
          tcgplayerId: tcgplayerId ? parseInt(tcgplayerId) : null,
          type,
          cardNumber: cardNumber || null,
          setId: setId || null,
        });

        toast.success("Card updated");
        setOpen(false);
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to update card");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" variant="outline" />}>
        <Pencil className="mr-1 size-3.5" />
        Edit
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Card</DialogTitle>
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

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Card name" />
            </div>
            <div className="space-y-1.5">
              <Label>Price (USD)</Label>
              <Input type="number" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0.00" min="0" step="0.01" />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <Label>Rarity</Label>
              <Select value={rarity} onValueChange={(v) => v && setRarity(v)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RARITIES.map((r) => (
                    <SelectItem key={r} value={r}>{r}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>HP</Label>
              <Input type="number" value={hp} onChange={(e) => setHp(e.target.value)} min="0" />
            </div>
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select value={type} onValueChange={(v) => v && setType(v)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CARD_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Artist</Label>
              <Input value={artist ?? ""} onChange={(e) => setArtist(e.target.value)} placeholder="Artist name" />
            </div>
            <div className="space-y-1.5">
              <Label>Card Number</Label>
              <Input value={cardNumber} onChange={(e) => setCardNumber(e.target.value)} placeholder="e.g. 025/198" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Set</Label>
              <Select value={setId} onValueChange={(v) => setSetId(v ?? "")}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select set..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">None</SelectItem>
                  {(sets ?? []).map((s) => (
                    <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>TCGPlayer ID</Label>
              <Input type="number" value={tcgplayerId} onChange={(e) => setTcgplayerId(e.target.value)} placeholder="Optional" />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button onClick={handleSubmit} disabled={isPending || !name || imageCleared}>
            {isPending ? "Saving..." : "Save Changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
