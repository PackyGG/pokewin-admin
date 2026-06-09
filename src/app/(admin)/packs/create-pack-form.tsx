"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DialogFooter } from "@/components/ui/dialog";
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
  TARGET_HOUSE_EDGE,
} from "@/app/(admin)/insights/edge-calc/math";
import { createPack, getCardPickerFilters } from "./actions";
import { uploadImageClient } from "@/lib/upload-image-client";
import { pack_tag } from "@/generated/prisma/enums";
import { RiskLevelSlider } from "./risk-level-slider";

/**
 * Heavy body of the "Create Pack" dialog, split out of
 * <CreatePackButton> so it can be `React.lazy()`-loaded on first open.
 *
 * Everything expensive lives here — the dnd-kit <SortableCardTable>, the
 * <CardPickerDialog>, the EV math, the image-upload flow, the risk slider
 * — so none of it is bundled into the /packs route chunk. The parent
 * keeps only the trigger + open state; on first open this chunk downloads
 * and mounts inside <LazyModalContent>. Behavior + numbers are identical
 * to the previous inline implementation.
 *
 * `onClose` closes the parent dialog after a successful create.
 */

const TAG_LABELS: Record<pack_tag, string> = {
  pct1: "%1",
  pct5: "%5",
  pct10: "%10",
  fifty50: "50/50",
};

type CardEntry = SortableCard;

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
      <p className="text-xs text-muted-foreground/60">PNG, JPG, WebP up to 20 MB</p>
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

export function CreatePackForm({
  onClose,
  // When set (e.g. from the dedicated /rewards/shards "Create shard pack"
  // dialog) the pack type is locked to this value and the type Select is
  // hidden. Defaults to undefined → the normal editable type Select with
  // "official" preselected, identical to the original /packs flow.
  lockedType,
}: {
  onClose: () => void;
  lockedType?: string;
}) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugManual, setSlugManual] = useState(false);
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("");
  const [priceManual, setPriceManual] = useState(false);
  const [cardsPerOpen, setCardsPerOpen] = useState("1");
  const [packType, setPackType] = useState(lockedType ?? "official");
  const [shardCost, setShardCost] = useState("");
  const [tags, setTags] = useState<pack_tag[]>([]);
  const [difficulty, setDifficulty] = useState(0);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [cards, setCards] = useState<CardEntry[]>([]);
  const [pickerSets, setPickerSets] = useState<{ id: string; name: string }[]>([]);
  const [pickerRarities, setPickerRarities] = useState<string[]>([]);

  // This form only ever mounts when the dialog is open (it's behind
  // LazyModalContent's open-gate), so the filter fetch fires exactly once
  // on first open — no `open` guard needed here anymore.
  useEffect(() => {
    if (pickerSets.length === 0) {
      getCardPickerFilters()
        .then(({ sets, rarities }) => {
          setPickerSets(sets);
          setPickerRarities(rarities);
        })
        .catch((err) => {
          console.error("[card picker filters]", err);
          toast.error("Failed to load filter options");
        });
    }
  }, [pickerSets]);

  function autoSlug(val: string) {
    return val
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60);
  }

  function handleNameChange(val: string) {
    setName(val);
    if (!slugManual) setSlug(autoSlug(val));
  }

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

  function updateCard(index: number, updates: Partial<CardEntry>) {
    setCards((prev) => prev.map((c, i) => (i === index ? { ...c, ...updates } : c)));
  }

  function removeCard(index: number) {
    setCards((prev) => prev.filter((_, i) => i !== index));
  }

  const totalOdds = cards.reduce((sum, c) => sum + c.odds, 0);
  const weightedPriceSum = cards.reduce((sum, c) => sum + c.priceUsd * c.odds, 0);
  const packPrice = parseFloat(price) || 0;
  const cpo = parseInt(cardsPerOpen) || 1;

  // Reuse the exact Edge Calc EV math: E[V_card] = Σ(w·price)/Σ(w),
  // E[Payout] = E[V_card] × cardsPerOpen. Odds (normalized %) are the
  // weights here — EV is scale-invariant in weights so the result is
  // identical to the catalog computation off pack_cards.weight.
  const ev = computePackEv({
    pricePerOpen: packPrice,
    cardsPerOpen: cpo,
    totalWeight: totalOdds,
    weightedPriceSum,
  });
  const evPerCard = ev.expectedCardValue;
  const expectedPayout = ev.expectedPayoutPerOpen;
  const houseEdge = packPrice > 0 ? ev.houseEdge * 100 : 0;

  // EV-based suggested price targeting TARGET_HOUSE_EDGE. Auto-fills the
  // price field as cards/odds/cards-per-open change, until the admin
  // types a price manually (priceManual) — they can always override.
  const suggestedPrice = suggestedPriceFromEv(expectedPayout);

  useEffect(() => {
    if (priceManual) return;
    if (suggestedPrice <= 0) return;
    const next = suggestedPrice.toFixed(2);
    setPrice((prev) => (prev === next ? prev : next));
  }, [suggestedPrice, priceManual]);

  function oddsToWeights(entries: CardEntry[]): number[] {
    return entries.map((c) => Math.max(1, Math.round(c.odds / 100 * 1_000_000)));
  }

  function resetForm() {
    setName("");
    setSlug("");
    setSlugManual(false);
    setDescription("");
    setPrice("");
    setPriceManual(false);
    setCardsPerOpen("1");
    setPackType(lockedType ?? "official");
    setShardCost("");
    setTags([]);
    setDifficulty(0);
    setImageFile(null);
    setImagePreview(null);
    setCards([]);
  }

  // Shard packs must carry an integer shard cost >= 1. Validate client-side
  // for a fast toast; the server action re-validates as the source of truth.
  const parsedShardCost = parseInt(shardCost, 10);
  const shardCostValid =
    packType !== "shard" ||
    (Number.isInteger(parsedShardCost) && parsedShardCost >= 1);

  function handleSubmit() {
    startTransition(async () => {
      try {
        if (packType === "shard" && !shardCostValid) {
          toast.error("Shard packs require a shard cost of at least 1");
          return;
        }

        let imageUrl: string | null = null;

        if (imageFile) {
          imageUrl = await uploadImageClient(imageFile, "/packs");
        }

        const weights = oddsToWeights(cards);
        await createPack({
          name,
          slug,
          description,
          price: parseFloat(price) || 0,
          cardsPerOpen: parseInt(cardsPerOpen) || 5,
          packType,
          shardCost: packType === "shard" ? parsedShardCost : null,
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

        toast.success("Pack created");
        onClose();
        resetForm();
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to create pack");
      }
    });
  }

  return (
    <>
      <div className="space-y-6">
        {/* Section 1: Pack Info */}
        <div className="space-y-4">
          <h3 className="text-sm font-medium text-muted-foreground">Pack Info</h3>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input value={name} onChange={(e) => handleNameChange(e.target.value)} placeholder="Pack name" />
            </div>
            <div className="space-y-1.5">
              <Label>Slug</Label>
              <Input
                value={slug}
                onChange={(e) => {
                  setSlugManual(true);
                  setSlug(e.target.value);
                }}
                placeholder="pack-slug"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Description</Label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional description" />
          </div>

          <div
            className={`grid grid-cols-1 gap-4 ${
              lockedType ? "sm:grid-cols-2" : "sm:grid-cols-3"
            }`}
          >
            <div className="space-y-1.5">
              <Label>Price (USD)</Label>
              <Input
                type="number"
                value={price}
                onChange={(e) => {
                  setPriceManual(true);
                  setPrice(e.target.value);
                }}
                placeholder="0.00"
                min="0"
                step="0.01"
              />
              {suggestedPrice > 0 && (
                <p className="text-xs text-muted-foreground">
                  EV {formatCurrency(expectedPayout)} · Suggested {formatCurrency(suggestedPrice)} · Edge{" "}
                  {(TARGET_HOUSE_EDGE * 100).toFixed(2)}%
                  {priceManual && (
                    <>
                      {" · "}
                      <button
                        type="button"
                        onClick={() => {
                          setPriceManual(false);
                          setPrice(suggestedPrice.toFixed(2));
                        }}
                        className="text-primary underline underline-offset-2"
                      >
                        use suggested
                      </button>
                    </>
                  )}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>Cards per Open</Label>
              <Input type="number" value={cardsPerOpen} onChange={(e) => setCardsPerOpen(e.target.value)} min="1" />
            </div>
            {!lockedType && (
              <div className="space-y-1.5">
                <Label>Pack Type</Label>
                <Select value={packType} onValueChange={(v) => v && setPackType(v)}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="official">Official</SelectItem>
                    <SelectItem value="custom">Custom</SelectItem>
                    <SelectItem value="promo">Promo</SelectItem>
                    <SelectItem value="reward">Reward</SelectItem>
                    <SelectItem value="shard">Shard</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          {packType === "shard" && (
            <div className="space-y-1.5">
              <Label>Shard Cost</Label>
              <Input
                type="number"
                value={shardCost}
                onChange={(e) => setShardCost(e.target.value)}
                placeholder="e.g. 100"
                min="1"
                step="1"
              />
              <p className="text-xs text-muted-foreground">
                Number of shards required to buy &amp; open this pack. Shard
                packs free-roll cards into inventory like reward packs.
              </p>
            </div>
          )}

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
                      onClick={() =>
                        setTags((prev) =>
                          selected
                            ? prev.filter((t) => t !== value)
                            : [...prev, value as pack_tag],
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
              onFile={(file) => { setImageFile(file); setImagePreview(URL.createObjectURL(file)); }}
              onClear={() => { setImageFile(null); setImagePreview(null); }}
            />
          </div>
        </div>

        {/* Section 2: Cards & Odds */}
        <div className="space-y-4">
          <h3 className="text-sm font-medium text-muted-foreground">Cards & Odds</h3>

          <div className="space-y-1.5">
            <Label>Add Card</Label>
            <CardPickerDialog
              selectedIds={cards.map((c) => c.cardId)}
              onSelect={handleAddCard}
              sets={pickerSets}
              rarities={pickerRarities}
            />
          </div>

          {cards.length > 0 && (
            <SortableCardTable
              cards={cards}
              onReorder={setCards}
              updateCard={updateCard}
              removeCard={removeCard}
            />
          )}

          {cards.length > 0 && (
            <div className="flex items-center gap-4 text-xs">
              <p className={Math.abs(totalOdds - 100) > 0.000001 ? "text-yellow-500" : "text-muted-foreground"}>
                Total odds: {totalOdds.toFixed(6)}%{Math.abs(totalOdds - 100) > 0.000001 && " — should sum to 100%"}
              </p>
              <span className="text-muted-foreground/40">|</span>
              <p className="text-muted-foreground">
                EV/card: {formatCurrency(evPerCard)} · EV/open: {formatCurrency(expectedPayout)}
              </p>
              <span className="text-muted-foreground/40">|</span>
              <p
                className={
                  houseEdge < 0
                    ? "text-rose-600 dark:text-rose-400"
                    : houseEdge < 5
                      ? "text-yellow-500"
                      : "text-emerald-600 dark:text-emerald-400"
                }
              >
                RTP: {packPrice > 0 ? ((expectedPayout / packPrice) * 100).toFixed(6) : "0.000000"}% · House edge: {houseEdge.toFixed(6)}%
              </p>
            </div>
          )}

          {cards.length === 0 && (
            <p className="text-sm text-muted-foreground">No cards added yet. Use the picker above to add cards.</p>
          )}
        </div>
      </div>

      <DialogFooter>
        <Button
          onClick={handleSubmit}
          disabled={isPending || !name || !price || !shardCostValid}
          className="w-full sm:w-auto"
        >
          {isPending ? "Creating..." : "Create Pack"}
        </Button>
      </DialogFooter>
    </>
  );
}
