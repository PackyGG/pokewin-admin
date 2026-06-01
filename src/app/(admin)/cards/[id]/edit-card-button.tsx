"use client";

import { useCallback, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Pencil,
  Upload,
  Image as ImageIcon,
  FileText,
  Coins,
  Loader2,
  X,
} from "lucide-react";
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
import { cn } from "@/lib/utils";
import { updateCard } from "../actions";
import { uploadImageClient } from "@/lib/upload-image-client";
import { toastActionError } from "@/lib/utils/action-error";

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

// ────────────────────────────────────────────────────────────────────
//  Section heading — mirrors the one in create-card-button.tsx so the
//  two dialogs feel like a matched pair.
// ────────────────────────────────────────────────────────────────────
function Section({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: React.ElementType;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="flex size-6 items-center justify-center rounded-md bg-primary/10">
          <Icon className="size-3.5 text-primary" />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold leading-tight">{title}</h3>
          {description && (
            <p className="text-[11px] text-muted-foreground">{description}</p>
          )}
        </div>
      </div>
      <div className="space-y-3 pl-8">{children}</div>
    </section>
  );
}

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
      <div className="flex items-start gap-4 rounded-xl border bg-card/50 p-3">
        <div className="relative shrink-0 overflow-hidden rounded-lg ring-1 ring-border bg-muted/40">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={preview}
            alt="Preview"
            className="h-24 w-[72px] object-cover"
          />
        </div>
        <div className="flex-1 space-y-2">
          <p className="text-xs font-medium">Current image</p>
          <p className="text-[11px] text-muted-foreground">
            Replace or remove and upload a new file.
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => inputRef.current?.click()}
            >
              <Upload className="size-3" />
              Replace
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={onClear}
            >
              <X className="size-3" />
              Remove
            </Button>
          </div>
        </div>
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

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => inputRef.current?.click()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const file = e.dataTransfer.files[0];
        if (file) handleFile(file);
      }}
      className={cn(
        "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-7 text-center",
        "motion-safe:transition-colors",
        dragging
          ? "border-primary bg-primary/5"
          : "border-border hover:border-primary/50 hover:bg-muted/30",
      )}
    >
      <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10">
        <Upload className="size-4 text-primary" />
      </div>
      <p className="text-sm">
        <span className="font-medium">Click to upload</span>
        <span className="text-muted-foreground"> or drag and drop</span>
      </p>
      <p className="text-[11px] text-muted-foreground">PNG, JPG, WebP · up to 5 MB</p>
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
  const [tcgplayerId, setTcgplayerId] = useState(
    card.tcgplayerId ? String(card.tcgplayerId) : "",
  );
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
        // Let Next's redirect()/notFound() control-flow errors (e.g. expired
        // session → /login) navigate cleanly instead of toasting NEXT_REDIRECT.
        toastActionError(e, "Failed to update card");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" variant="outline" />}>
        <Pencil className="size-3.5" />
        Edit
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto p-0">
        <div className="relative overflow-hidden rounded-t-xl border-b bg-gradient-to-br from-card via-card to-card/60 px-5 py-4">
          <div
            aria-hidden
            className="pointer-events-none absolute -right-16 -top-16 size-48 rounded-full bg-blue-500/[0.06] blur-3xl"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute -left-16 -bottom-16 size-48 rounded-full bg-purple-500/[0.06] blur-3xl"
          />
          <DialogHeader className="relative">
            <div className="flex items-center gap-3">
              <div className="flex size-9 items-center justify-center rounded-xl bg-primary/10">
                <Pencil className="size-4 text-primary" />
              </div>
              <div>
                <DialogTitle className="text-base font-semibold leading-tight">
                  Edit Card
                </DialogTitle>
                <p className="text-xs text-muted-foreground">
                  Update metadata or artwork for this card.
                </p>
              </div>
            </div>
          </DialogHeader>
        </div>

        <div className="space-y-6 px-5 py-5">
          <Section
            icon={ImageIcon}
            title="Image"
            description="Artwork shown in the catalog and packs."
          >
            <ImageDropzone
              preview={imagePreview}
              onFile={(file) => {
                setImageFile(file);
                setImagePreview(URL.createObjectURL(file));
              }}
              onClear={() => {
                setImageFile(null);
                setImagePreview(null);
              }}
            />
          </Section>

          <Section
            icon={FileText}
            title="Card details"
            description="Name, set, and rarity metadata."
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="edit-card-name">Name</Label>
                <Input
                  id="edit-card-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Card name"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit-card-rarity">Rarity</Label>
                <Select
                  value={rarity ?? ""}
                  onValueChange={(v) => v && setRarity(v)}
                >
                  <SelectTrigger id="edit-card-rarity" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RARITIES.map((r) => (
                      <SelectItem key={r} value={r}>
                        {r}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="edit-card-set">Set</Label>
                <Select value={setId} onValueChange={(v) => setSetId(v ?? "")}>
                  <SelectTrigger id="edit-card-set" className="w-full">
                    <SelectValue placeholder="Select set..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">None</SelectItem>
                    {(sets ?? []).map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit-card-number">Card Number</Label>
                <Input
                  id="edit-card-number"
                  value={cardNumber}
                  onChange={(e) => setCardNumber(e.target.value)}
                  placeholder="e.g. 025/198"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="edit-card-type">Type</Label>
                <Select value={type} onValueChange={(v) => v && setType(v)}>
                  <SelectTrigger id="edit-card-type" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CARD_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>
                        {t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit-card-hp">HP</Label>
                <Input
                  id="edit-card-hp"
                  type="number"
                  value={hp}
                  onChange={(e) => setHp(e.target.value)}
                  min="0"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit-card-artist">Artist</Label>
                <Input
                  id="edit-card-artist"
                  value={artist ?? ""}
                  onChange={(e) => setArtist(e.target.value)}
                  placeholder="Artist name"
                />
              </div>
            </div>
          </Section>

          <Section
            icon={Coins}
            title="Economy"
            description="Pricing and external-market reference."
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="edit-card-price">Price (USD)</Label>
                <Input
                  id="edit-card-price"
                  type="number"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  placeholder="0.00"
                  min="0"
                  step="0.01"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit-card-tcg">TCGPlayer ID</Label>
                <Input
                  id="edit-card-tcg"
                  type="number"
                  value={tcgplayerId}
                  onChange={(e) => setTcgplayerId(e.target.value)}
                  placeholder="Optional"
                />
              </div>
            </div>
          </Section>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => setOpen(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isPending || !name || imageCleared}
          >
            {isPending ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Saving...
              </>
            ) : (
              <>Save changes</>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
