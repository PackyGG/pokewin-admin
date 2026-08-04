"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, Boxes, Image as ImageIcon, Package, Scale, Upload } from "lucide-react";
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
import { SectionHeading } from "@/components/modern-panels";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils/format";
import { suggestedPriceFromEv } from "@/app/(admin)/insights/edge-calc/math";
import { computePackEconomics, PackEconomicsPanel } from "./pack-economics";
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
import {
  PACK_BUILDER_TICKET_TOTAL,
  scaleToPackBuilderTickets,
} from "@/lib/packs/builder-edge";

type PackCard = SortableCard;

const ODDS_EPSILON = 0.00005;

function editableCardsFromPack(pack: PackEditData): PackCard[] {
  return pack.cards.map((card) => ({
    cardId: card.cardId,
    name: card.name,
    imageUrl: card.imageUrl,
    priceUsd: card.priceUsd,
    // Use the real normalized probability. A legacy/non-million ticket total
    // must still open as 100%, rather than looking broken and being rewritten.
    odds: Math.round(card.probability * 10_000) / 10_000,
    color: card.color,
    animation: card.animation,
  }));
}

const TAG_LABELS: Record<pack_tag, string> = {
  pct1: "%1",
  pct5: "%5",
  pct10: "%10",
  fifty50: "50/50",
  onepiece: "One Piece",
};

export type PackEditData = {
  id: string;
  /** MAIN row version. Every full-state save must compare this under a lock. */
  updatedAt: string;
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
  onSaved?: (saved: PackEditData) => void;
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
  const [uploadedImageUrl, setUploadedImageUrl] = useState<string | null>();
  const [cards, setCards] = useState<PackCard[]>(() => editableCardsFromPack(pack));

  const [pickerSets, setPickerSets] = useState<{ id: string; name: string }[]>([]);
  const [pickerRarities, setPickerRarities] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const formSignature = useMemo(
    () =>
      JSON.stringify({
        name,
        slug,
        description,
        price,
        cardsPerOpen,
        packType,
        tags,
        difficulty,
        imagePreview,
        cards,
      }),
    [
      name,
      slug,
      description,
      price,
      cardsPerOpen,
      packType,
      tags,
      difficulty,
      imagePreview,
      cards,
    ],
  );
  const initialSignature = useRef(
    JSON.stringify({
      name: pack.name,
      slug: pack.slug,
      description: pack.description ?? "",
      price: String(pack.priceUsd),
      cardsPerOpen: String(pack.cardsPerOpen),
      packType: pack.packType,
      tags: pack.tags,
      difficulty: pack.difficulty ?? 0,
      imagePreview: pack.imageUrl,
      cards: editableCardsFromPack(pack),
    }),
  );
  const isDirty = formSignature !== initialSignature.current || imageFile !== null;

  useEffect(() => {
    if (!isDirty || saving) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [isDirty, saving]);

  useEffect(() => {
    return () => {
      if (imagePreview?.startsWith("blob:")) URL.revokeObjectURL(imagePreview);
    };
  }, [imagePreview]);

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
  const packPrice = parseFloat(price) || 0;
  const cpo = parseInt(cardsPerOpen) || 1;

  // ONE economics read, shared verbatim with the overview page — the odds the
  // form edits are percentages, and `computePackEconomics` only ever uses
  // weight RATIOS, so passing odds as weights is exact (not an approximation).
  const econ = useMemo(
    () =>
      computePackEconomics({
        priceUsd: packPrice,
        cardsPerOpen: cpo,
        packType,
        pool: cards.map((c) => ({ weight: c.odds, priceUsd: c.priceUsd })),
      }),
    [packPrice, cpo, packType, cards],
  );
  const expectedPayout = econ.evPerOpen;
  // Price the suggestion at THIS pack's target edge (the curve: 10.99% floor +
  // risk premium) — the same target the panel above reports and the same one
  // the /packs re-price tool aims a per-pack run at. Previously this suggested
  // a flat 10.99% while the page's target could be higher, so "use it" landed
  // the pack under its own target.
  const suggestedPrice = suggestedPriceFromEv(
    expectedPayout,
    econ.targetEdgePct / 100,
  );
  const oddsOff = cards.length > 0 && Math.abs(totalOdds - 100) > ODDS_EPSILON;

  const validationErrors = useMemo(() => {
    const errors: string[] = [];
    const numericPrice = Number(price);
    const numericCardsPerOpen = Number(cardsPerOpen);
    if (!name.trim()) errors.push("Enter a pack name");
    if (name.trim().length > 60) errors.push("Pack name cannot exceed 60 characters");
    if (!slug.trim()) errors.push("Enter a pack slug");
    if (slug.trim().length > 60) errors.push("Pack slug cannot exceed 60 characters");
    if (!Number.isFinite(numericPrice) || numericPrice <= 0) {
      errors.push("Enter a price greater than $0");
    } else if (Math.abs(numericPrice * 100 - Math.round(numericPrice * 100)) >= 1e-7) {
      errors.push("Price can have at most 2 decimal places");
    }
    if (
      !Number.isInteger(numericCardsPerOpen) ||
      numericCardsPerOpen < 1 ||
      numericCardsPerOpen > 100
    ) {
      errors.push("Cards per open must be a whole number from 1 to 100");
    }
    if (cards.length === 0) errors.push("Add at least one card");
    if (cards.some((card) => !Number.isFinite(card.odds) || card.odds <= 0)) {
      errors.push("Every card needs odds greater than 0%");
    }
    if (cards.length > 0 && oddsOff) errors.push("Balance card odds to exactly 100.0000%");
    return errors;
  }, [name, slug, price, cardsPerOpen, cards, oddsOff]);
  const canSave = isDirty && validationErrors.length === 0 && !saving;

  function oddsToWeights(entries: PackCard[]): number[] {
    return scaleToPackBuilderTickets(entries.map((card) => card.odds)) ?? [];
  }

  function balanceOdds() {
    const weights = oddsToWeights(cards);
    if (weights.length !== cards.length) {
      toast.error("Enter odds greater than 0% before balancing");
      return;
    }
    setCards((current) =>
      current.map((card, index) => ({
        ...card,
        odds: weights[index]! / (PACK_BUILDER_TICKET_TOTAL / 100),
      })),
    );
    setSubmitError(null);
  }

  async function handleSubmit() {
    if (saving) return;
    if (validationErrors.length > 0) {
      const message = validationErrors[0]!;
      setSubmitError(message);
      toast.error(message);
      return;
    }
    setSaving(true);
    setSubmitError(null);
    try {
      let imageUrl =
        uploadedImageUrl !== undefined
          ? uploadedImageUrl
          : imagePreview === null
            ? null
            : pack.imageUrl;
      if (imageFile) {
        imageUrl = await uploadImageClient(imageFile, "/packs");
        setUploadedImageUrl(imageUrl);
        setImageFile(null);
      }

      const weights = oddsToWeights(cards);
      if (weights.length !== cards.length) {
        throw new Error("Card odds could not be converted to a valid 100% ticket pool");
      }
      const result = await updatePack(pack.id, {
        expectedUpdatedAt: pack.updatedAt,
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

      if (!result.success) {
        setSubmitError(result.error);
        toast.error(result.error);
        return;
      }
      const saved = result.data;

      invalidatePackDetailCache(pack.id);
      if (saved.liveCacheReloaded) {
        toast.success("Pack updated, verified, and live");
      } else {
        toast.warning(
          "Pack saved and verified. The live game cache is retrying its refresh.",
        );
      }
      const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
      onSaved?.({
        ...pack,
        updatedAt: saved.updatedAt,
        name: name.trim(),
        slug: slug.trim(),
        description: description.trim() || null,
        imageUrl,
        priceUsd: parseFloat(price),
        cardsPerOpen: parseInt(cardsPerOpen),
        packType,
        tags,
        difficulty: difficulty || null,
        cards: cards.map((card, index) => ({
          ...card,
          weight: weights[index],
          probability:
            totalWeight > 0 ? (weights[index] / totalWeight) * 100 : 0,
        })),
      });
      router.refresh();
    } catch (e) {
      const message =
        e instanceof Error
          ? e.message
          : "The save request failed before it reached the server. Please try again.";
      setSubmitError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Live economics — the same panel the overview shows, recomputed on
          every keystroke so price / odds / cards-per-open edits are steered by
          the actual edge instead of a 6-decimal footnote under the table. */}
      <PackEconomicsPanel
        econ={econ}
        title="Live economics"
        hint="Updates as you edit — not saved until you hit Save"
      />

      <section className="space-y-4 rounded-xl border bg-card p-4 shadow-sm sm:p-5">
        <SectionHeading icon={Package} title="Pack info" />
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
                {formatCurrency(suggestedPrice)} hits the {econ.targetEdgePct.toFixed(2)}% target
                {price !== suggestedPrice.toFixed(2) && (
                  <>
                    {" · "}
                    <button type="button" onClick={() => setPrice(suggestedPrice.toFixed(2))} className="font-medium text-primary underline underline-offset-2">
                      use it
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
          <Label className="flex items-center gap-1.5">
            <ImageIcon className="size-3.5 text-muted-foreground" />
            Image
          </Label>
          <ImageDropzone
            preview={imagePreview}
            onFile={(file) => {
              setImageFile(file);
              setUploadedImageUrl(undefined);
              setImagePreview(URL.createObjectURL(file));
            }}
            onClear={() => {
              setImageFile(null);
              setUploadedImageUrl(null);
              setImagePreview(null);
            }}
          />
        </div>
      </section>

      <section className="space-y-4 rounded-xl border bg-card p-4 shadow-sm sm:p-5">
        <SectionHeading
          icon={Boxes}
          title={
            <>
              Cards &amp; odds
              <span className="text-xs font-normal text-muted-foreground">
                ({cards.length} in pool)
              </span>
            </>
          }
        />
        <CardPickerDialog
          selectedIds={cards.map((c) => c.cardId)}
          onSelect={handleAddCard}
          sets={pickerSets}
          rarities={pickerRarities}
        />
        {cards.length > 0 ? (
          <>
            {/* Odds total is the one thing that can silently break a pack, so
                it gets a real status row instead of a 6-decimal footnote. */}
            <div
              className={cn(
                "flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs",
                oddsOff
                  ? "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
                  : "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
              )}
            >
              <span className="font-medium tabular-nums">
                Total odds {totalOdds.toFixed(4)}%
                {oddsOff ? ` — ${(100 - totalOdds).toFixed(4)}pp off 100%` : " — balanced"}
              </span>
              <span className="text-muted-foreground tabular-nums">
                EV/card {formatCurrency(econ.evPerCard)} · EV/open{" "}
                {formatCurrency(expectedPayout)}
              </span>
              {oddsOff ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1.5 text-xs"
                  onClick={balanceOdds}
                  disabled={saving}
                >
                  <Scale className="size-3.5" />
                  Balance to 100%
                </Button>
              ) : null}
            </div>
            <SortableCardTable cards={cards} onReorder={setCards} updateCard={updateCard} removeCard={removeCard} />
          </>
        ) : (
          <p className="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
            No cards in this pack yet — add one to give it an EV.
          </p>
        )}
      </section>

      <ChangePackSet packId={pack.id} />

      {/* Sticky action bar: the card table is long, and the edge/odds status
          has to stay reachable next to Save without scrolling back up. */}
      <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center justify-between gap-3 border-t bg-background/95 px-1 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        {submitError || validationErrors.length > 0 ? (
          <p className="flex items-center gap-1.5 text-xs text-destructive" role="alert">
            <AlertCircle className="size-3.5 shrink-0" />
            {submitError ?? validationErrors[0]}
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground tabular-nums">
          {econ.showEdge
            ? `House edge ${econ.edgePct.toFixed(2)}% · target ${econ.targetEdgePct.toFixed(2)}%`
            : econ.isReward
              ? "Reward pack — no house edge"
              : "Set a price and add cards to get an edge"}
        </p>
        <div className="flex items-center gap-2">
          {showCancel && onCancel ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                if (!isDirty || window.confirm("Discard your unsaved pack changes?")) {
                  onCancel();
                }
              }}
              disabled={saving}
            >
              Cancel
            </Button>
          ) : null}
          <Button onClick={handleSubmit} disabled={!canSave}>
            {saving ? "Saving and verifying..." : isDirty ? "Save Changes" : "No Changes"}
          </Button>
        </div>
      </div>
    </div>
  );
}
