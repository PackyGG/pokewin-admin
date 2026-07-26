"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CardPickerDialog } from "./card-picker-dialog";
import type { CardPickerItem } from "./actions";
import { SortableCardTable, type SortableCard } from "./sortable-card-table";
import { formatCurrency } from "@/lib/utils/format";
import {
  computePackEv,
  suggestedPriceFromEv,
} from "@/app/(admin)/insights/edge-calc/math";
import { updatePack, getCardPickerFilters } from "./actions";
import { uploadImageClient } from "@/lib/upload-image-client";
const pack_tag = {
  pct1: "pct1",
  pct5: "pct5",
  pct10: "pct10",
  fifty50: "fifty50",
  onepiece: "onepiece",
} as const;
type pack_tag = (typeof pack_tag)[keyof typeof pack_tag];
import { RiskLevelSlider } from "./risk-level-slider";
import { ChangePackSet } from "./change-pack-set";
import { invalidatePackDetailCache } from "./pack-detail-cache";

type PackCard = SortableCard;

const TAG_LABELS: Record<pack_tag, string> = {
  pct1: "%1",
  pct5: "%5",
  pct10: "%10",
  fifty50: "50/50",
  onepiece: "One Piece",
};

export type PackEditData = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  imageUrl: string | null;
  priceUsd: number;
  cardsPerOpen: number;
  packType: string;
  tags: pack_tag[];
  difficulty: number | null;
  cards: {
    cardId: string;
    name: string;
    imageUrl: string | null;
    priceUsd: number;
    weight: number;
    probability: number;
    color: string | null;
    animation: boolean;
  }[];
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
        {/* eslint-disable-next-line @next/next/no-img-element */}
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
      className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 transition-colors ${
        dragging
          ? "border-primary bg-primary/5"
          : "border-muted-foreground/25 hover:border-muted-foreground/50"
      }`}
    >
      <Upload className="size-6 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">
        Drop an image here or{" "}
        <span className="text-primary underline underline-offset-2">browse</span>
      </p>
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

export function PackEditForm({
  pack,
  onCancel,
  onSaved,
  showCancel = true,
}: {
  pack: PackEditData;
  onCancel?: () => void;
  onSaved?: () => void;
  showCancel?: boolean;
}) {
  const router = useRouter();

  const [name, setName] = useState(pack.name);
  const [slug, setSlug] = useState(pack.slug);
  const [description, setDescription] = useState(pack.description ?? "");
  const [price, setPrice] = useState(String(pack.priceUsd));
  const [cardsPerOpen, setCardsPerOpen] = useState(String(pack.cardsPerOpen));
  const [packType, setPackType] = useState(pack.packType);
  const [tags, setTags] = useState<pack_tag[]>(pack.tags);
  const [difficulty, setDifficulty] = useState<number>(pack.difficulty ?? 0);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(pack.imageUrl);
  const [cards, setCards] = useState<PackCard[]>(
    pack.cards.map((c) => ({
      cardId: c.cardId,
      name: c.name,
      imageUrl: c.imageUrl,
      priceUsd: c.priceUsd,
      odds: Math.round((c.weight / 1_000_000) * 100 * 10000) / 10000,
      color: c.color,
      animation: c.animation,
    })),
  );

  const [pickerSets, setPickerSets] = useState<{ id: string; name: string }[]>([]);
  const [pickerRarities, setPickerRarities] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (pickerSets.length === 0) {
      getCardPickerFilters()
        .then(({ sets, rarities }) => {
          setPickerSets(sets);
          setPickerRarities(rarities);
        })
        .catch(() => {
          toast.error("Failed to load filter options");
        });
    }
  }, [pickerSets.length]);

  function handleAddCard(item: CardPickerItem) {
    if (cards.some((c) => c.cardId === item.id)) {
      toast.error("Card already added");
      return;
    }
    setCards((prev) => [
      ...prev,
      {
        cardId: item.id,
        name: item.name,
        imageUrl: item.imageUrl,
        priceUsd: item.priceUsd,
        odds: 1,
        color: null,
        animation: false,
      },
    ]);
  }

  function updateCard(index: number, updates: Partial<PackCard>) {
    setCards((prev) => prev.map((c, i) => (i === index ? { ...c, ...updates } : c)));
  }

  function removeCard(index: number) {
    setCards((prev) => prev.filter((_, i) => i !== index));
  }

  const totalOdds = cards.reduce((sum, c) => sum + c.odds, 0);
  const weightedPriceSum = cards.reduce((sum, c) => sum + c.priceUsd * c.odds, 0);
  const packPrice = parseFloat(price) || 0;
  const cpo = parseInt(cardsPerOpen) || 1;

  const ev = computePackEv({
    pricePerOpen: packPrice,
    cardsPerOpen: cpo,
    totalWeight: totalOdds,
    weightedPriceSum,
  });
  const evPerCard = ev.expectedCardValue;
  const expectedPayout = ev.expectedPayoutPerOpen;
  const houseEdge = packPrice > 0 ? ev.houseEdge * 100 : 0;
  const suggestedPrice = suggestedPriceFromEv(expectedPayout);

  function oddsToWeights(entries: PackCard[]): number[] {
    return entries.map((c) => Math.max(1, Math.round((c.odds / 100) * 1_000_000)));
  }

  async function handleSubmit() {
    if (saving) return;
    setSaving(true);
    try {
      let imageUrl = imagePreview === null ? null : pack.imageUrl;
      if (imageFile) {
        imageUrl = await uploadImageClient(imageFile, "/packs");
      }

      const weights = oddsToWeights(cards);
      await updatePack(pack.id, {
        name,
        slug,
        description,
        price: parseFloat(price) || 0,
        cardsPerOpen: parseInt(cardsPerOpen) || 5,
        packType,
        imageUrl,
        tags,
        difficulty: difficulty || null,
        cards: cards.map((c, i) => ({
          cardId: c.cardId,
          weight: weights[i],
          color: c.color || null,
          animation: c.animation,
          order: i,
        })),
      });

      invalidatePackDetailCache(pack.id);
      toast.success("Pack updated");
      onSaved?.();
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update pack");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-muted-foreground">Pack Info</h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} disabled={saving} />
          </div>
          <div className="space-y-1.5">
            <Label>Slug</Label>
            <Input value={slug} onChange={(e) => setSlug(e.target.value)} disabled={saving} />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>Description</Label>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} disabled={saving} />
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label>Price (USD)</Label>
            <Input type="number" value={price} onChange={(e) => setPrice(e.target.value)} min="0" step="0.01" disabled={saving} />
            {suggestedPrice > 0 && (
              <p className="text-xs text-muted-foreground">
                EV {formatCurrency(expectedPayout)} · Suggested {formatCurrency(suggestedPrice)}
                {price !== suggestedPrice.toFixed(2) && (
                  <>
                    {" · "}
                    <button type="button" onClick={() => setPrice(suggestedPrice.toFixed(2))} className="text-primary underline underline-offset-2">
                      set from EV
                    </button>
                  </>
                )}
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label>Cards per Open</Label>
            <Input type="number" value={cardsPerOpen} onChange={(e) => setCardsPerOpen(e.target.value)} min="1" disabled={saving} />
          </div>
          <div className="space-y-1.5">
            <Label>Pack Type</Label>
            <Select value={packType} onValueChange={(v) => v && setPackType(v)} disabled={saving}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="official">Official</SelectItem>
                <SelectItem value="custom">Custom</SelectItem>
                <SelectItem value="promo">Promo</SelectItem>
                <SelectItem value="reward">Reward</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Tags</Label>
            <div className="flex flex-wrap gap-2">
              {Object.entries(TAG_LABELS).map(([value, label]) => {
                const selected = tags.includes(value as pack_tag);
                return (
                  <button
                    key={value}
                    type="button"
                    disabled={saving}
                    onClick={() =>
                      setTags((prev) =>
                        selected ? prev.filter((t) => t !== value) : [...prev, value as pack_tag],
                      )
                    }
                    className={`rounded-md border px-3 py-1.5 text-sm font-medium transition-colors ${
                      selected
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-background text-muted-foreground hover:bg-muted"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Risk Level</Label>
            <RiskLevelSlider value={difficulty} onChange={setDifficulty} />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>Image</Label>
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
        </div>
      </div>

      <div className="space-y-4">
        <h3 className="text-sm font-medium text-muted-foreground">
          Cards & Odds ({cards.length} cards)
        </h3>
        <CardPickerDialog
          selectedIds={cards.map((c) => c.cardId)}
          onSelect={handleAddCard}
          sets={pickerSets}
          rarities={pickerRarities}
        />
        {cards.length > 0 && (
          <>
            <SortableCardTable cards={cards} onReorder={setCards} updateCard={updateCard} removeCard={removeCard} />
            <div className="flex flex-wrap items-center gap-4 text-xs">
              <p className={Math.abs(totalOdds - 100) > 0.000001 ? "text-yellow-500" : "text-muted-foreground"}>
                Total odds: {totalOdds.toFixed(6)}%
              </p>
              <p className="text-muted-foreground">EV/card: {formatCurrency(evPerCard)} · EV/open: {formatCurrency(expectedPayout)}</p>
              {packType !== "reward" && (
              <p className={houseEdge < 0 ? "text-rose-600" : houseEdge < 5 ? "text-yellow-500" : "text-emerald-600"}>
                House edge: {houseEdge.toFixed(6)}%
              </p>
              )}
            </div>
          </>
        )}
      </div>

      <ChangePackSet packId={pack.id} />

      <div className="flex items-center justify-end gap-2">
        {showCancel && onCancel ? (
          <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
        ) : null}
        <Button onClick={handleSubmit} disabled={saving || !name || !price}>
          {saving ? "Saving..." : "Save Changes"}
        </Button>
      </div>
    </div>
  );
}
