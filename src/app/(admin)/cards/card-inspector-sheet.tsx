"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Layers, Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { CardImage } from "@/components/card-image";
import { Badge } from "@/components/ui/badge";
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
import { Skeleton } from "@/components/ui/skeleton";
import { InspectorSheet } from "@/components/entity-surface";
import {
  formatCurrency,
  formatNumber,
  formatRelative,
} from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import type { CardInspector } from "@/lib/queries/cards";
import { loadCardInspector, loadMoveDialogData } from "./load-actions";
import { updateCard } from "./actions";

/**
 * In-list card INSPECTOR — a right-side sheet that previews a card's detail
 * and allows a fast price / rarity / set edit WITHOUT leaving the list. Opens
 * from a table-row or gallery-tile click in <CardsExplorer>.
 *
 * Loading discipline (CLAUDE.md): the sheet body is gated by `InspectorSheet`'s
 * `LazyModalContent`, and the lean detail (`loadCardInspector`) + the set
 * options (`loadMoveDialogData`) are fetched ONLY once the sheet is open —
 * never on the list render. A `seed` (the row we already have) paints the
 * header name/image instantly while the detail streams behind it.
 *
 * The full `/cards/[id]` page stays the deep-link (the "Open full page" button
 * in the header) for the heavier inventory/pack breakdown + the full
 * edit/delete dialogs — the inspector is a fast triage surface, not a
 * replacement.
 */

const RARITY_BADGE: Record<string, string> = {
  common: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
  uncommon:
    "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  rare: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  "ultra rare":
    "bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30",
  secret:
    "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
};

// Pokemon edit rarities (mirrors EditCardButton's RARITIES). The inspector's
// quick-edit is scalar-only; full variant branching lives in the /cards/[id]
// Edit dialog. We keep whatever rarity the card already has selectable even if
// it's an OnePiece short-code by prepending it when not in the list.
const POKEMON_RARITIES = [
  "Common",
  "Uncommon",
  "Rare",
  "Ultra Rare",
  "Secret",
] as const;

export type InspectorSeed = {
  name: string;
  imageUrl: string | null;
  rarity: string | null;
  setName: string | null;
};

export function CardInspectorSheet({
  cardId,
  seed,
  onOpenChange,
}: {
  cardId: string | null;
  seed: InspectorSeed | null;
  onOpenChange: (open: boolean) => void;
}) {
  const open = cardId != null;

  return (
    <InspectorSheet
      open={open}
      onOpenChange={onOpenChange}
      icon={Layers}
      accent="blue"
      title={seed?.name ?? "Card"}
      subtitle={seed?.setName ?? undefined}
      fullHref={cardId ? `/cards/${cardId}` : undefined}
      fullLabel="Open full page"
      bodyMinHeight={360}
    >
      {cardId && <InspectorBody cardId={cardId} seed={seed} />}
    </InspectorSheet>
  );
}

function InspectorBody({
  cardId,
  seed,
}: {
  cardId: string;
  seed: InspectorSeed | null;
}) {
  const router = useRouter();
  const [data, setData] = React.useState<CardInspector | null>(null);
  const [loadError, setLoadError] = React.useState(false);
  const [sets, setSets] = React.useState<{ id: string; name: string }[]>([]);

  // Lean detail + set options, fetched only now that the sheet body mounted.
  React.useEffect(() => {
    let cancelled = false;
    setData(null);
    setLoadError(false);
    loadCardInspector(cardId)
      .then((d) => {
        if (cancelled) return;
        if (!d) setLoadError(true);
        else setData(d);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [cardId]);

  // Set options for the quick-edit Set dropdown. Reuses the move-dialog loader
  // (same enriched set list) — fetched once per open, lazily.
  React.useEffect(() => {
    let cancelled = false;
    loadMoveDialogData()
      .then((d) => {
        if (!cancelled) setSets(d.sets.map((s) => ({ id: s.id, name: s.name })));
      })
      .catch(() => {
        /* set dropdown just stays minimal; non-blocking */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loadError) {
    return (
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.06] px-4 py-8 text-center text-sm text-muted-foreground">
        Couldn&apos;t load this card&apos;s detail. Use{" "}
        <span className="font-medium text-foreground">Open full page</span> for
        the full view.
      </div>
    );
  }

  if (!data) {
    return <InspectorBodySkeleton seed={seed} />;
  }

  return <InspectorLoaded data={data} sets={sets} onSaved={() => router.refresh()} />;
}

function InspectorLoaded({
  data,
  sets,
  onSaved,
}: {
  data: CardInspector;
  sets: { id: string; name: string }[];
  onSaved: () => void;
}) {
  const [price, setPrice] = React.useState(String(data.priceUsd));
  const [rarity, setRarity] = React.useState(data.rarity ?? "");
  const [setId, setSetId] = React.useState(data.setId ?? "");
  const [saving, startSave] = React.useTransition();

  // Keep the card's stored rarity selectable even if it's an OnePiece code not
  // in the Pokemon list (so the quick-edit never silently changes it).
  const rarityOptions = React.useMemo(() => {
    const opts: string[] = [...POKEMON_RARITIES];
    if (data.rarity && !opts.includes(data.rarity)) opts.unshift(data.rarity);
    return opts;
  }, [data.rarity]);

  // value → label map for the Set <Select>. base-ui's <Select.Value> renders
  // the raw `value` (here a set UUID) unless it can look the value up in an
  // `items` map — without this the trigger shows the card's set UUID instead
  // of its name (the bug). Seeded with the card's OWN set so the name shows
  // instantly on first paint (before the lazy `loadMoveDialogData` set list
  // resolves), then overlaid with the full list once it arrives. Mirrors the
  // proven pattern in create-card-form.tsx.
  const setItems = React.useMemo<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    if (data.setId && data.setName) map[data.setId] = data.setName;
    for (const s of sets) map[s.id] = s.name;
    return map;
  }, [data.setId, data.setName, sets]);

  const priceNum = parseFloat(price);
  const dirty =
    (Number.isFinite(priceNum) ? priceNum : 0) !== data.priceUsd ||
    (rarity || null) !== (data.rarity ?? null) ||
    (setId || null) !== (data.setId ?? null);

  function handleSave() {
    if (!Number.isFinite(priceNum) || priceNum < 0) {
      toast.error("Enter a valid price");
      return;
    }
    startSave(async () => {
      try {
        // updateCard takes the FULL payload; we resubmit the card's existing
        // scalars with the edited price/rarity/set so nothing else changes.
        const result = await updateCard(data.id, {
          name: data.name,
          imageUrl: data.imageUrl,
          price: priceNum,
          hp: data.hp,
          rarity: rarity || null,
          artist: data.artist,
          tcgplayerId: data.tcgplayerId,
          type: data.type,
          cardNumber: data.cardNumber,
          setId: setId || null,
        });
        if (!result.success) {
          toast.error(result.error);
          return;
        }
        toast.success("Card updated");
        onSaved();
      } catch {
        toast.error("Failed to update card");
      }
    });
  }

  const dash = "—";

  return (
    <div className="space-y-5">
      {/* Artwork + identity */}
      <div className="flex gap-4">
        <div className="relative h-36 w-[104px] shrink-0 overflow-hidden rounded-lg bg-muted/40 ring-1 ring-border">
          <CardImage
            src={data.imageUrl}
            alt={data.name}
            className="absolute inset-0 size-full"
          />
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {data.rarity && (
              <Badge
                variant="outline"
                className={cn(RARITY_BADGE[data.rarity.toLowerCase()] ?? "")}
              >
                {data.rarity}
              </Badge>
            )}
            <Badge variant="outline" className="capitalize">
              {data.type}
            </Badge>
          </div>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
            <DetailRow label="Set" value={data.setName ?? "Unassigned"} />
            <DetailRow
              label="Card #"
              value={
                data.cardNumber ? (
                  <span className="font-mono">{data.cardNumber}</span>
                ) : (
                  dash
                )
              }
            />
            <DetailRow
              label="HP"
              value={data.hp != null ? formatNumber(data.hp) : dash}
            />
            <DetailRow label="Artist" value={data.artist ?? dash} />
            {data.cost != null && (
              <DetailRow label="Cost" value={formatNumber(data.cost)} />
            )}
            {data.power != null && (
              <DetailRow label="Power" value={formatNumber(data.power)} />
            )}
            <DetailRow
              label="In packs"
              value={formatNumber(data.packCount)}
            />
            <DetailRow
              label="Price (raw)"
              value={formatCurrency(data.priceRawUsd)}
            />
          </dl>
        </div>
      </div>

      {/* Quick edit — the low-friction path the discovery asked for: adjust
          price / rarity / set without a full navigation. */}
      <div className="space-y-3 rounded-xl border bg-card/40 p-3">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Quick edit
          </h4>
          {data.priceUsd > 0 && (
            <span className="text-[11px] text-muted-foreground tabular-nums">
              was {formatCurrency(data.priceUsd)}
            </span>
          )}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="inspect-price">Price (USD)</Label>
            <Input
              id="inspect-price"
              type="number"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              min="0"
              step="0.01"
              placeholder="0.00"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="inspect-rarity">Rarity</Label>
            <Select value={rarity} onValueChange={(v) => setRarity(v ?? "")}>
              <SelectTrigger id="inspect-rarity" className="w-full">
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent>
                {rarityOptions.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="inspect-set">Set</Label>
          <Select
            items={setItems}
            value={setId}
            onValueChange={(v) => setSetId(v ?? "")}
          >
            <SelectTrigger id="inspect-set" className="w-full">
              <SelectValue placeholder="Unassigned" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">Unassigned</SelectItem>
              {sets.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          size="sm"
          className="w-full"
          onClick={handleSave}
          disabled={saving || !dirty}
        >
          {saving ? (
            <>
              <Loader2 className="size-3.5 animate-spin" />
              Saving…
            </>
          ) : (
            <>
              <Save className="size-3.5" />
              Save changes
            </>
          )}
        </Button>
      </div>

      <p className="text-[11px] text-muted-foreground">
        Updated {formatRelative(data.updatedAt)}. For artwork, identifiers and
        delete, open the full page.
      </p>
    </div>
  );
}

function DetailRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-2">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="truncate text-right font-medium tabular-nums text-foreground/90">
        {value}
      </dd>
    </div>
  );
}

function InspectorBodySkeleton({ seed }: { seed: InspectorSeed | null }) {
  return (
    <div className="space-y-5">
      <div className="flex gap-4">
        <div className="relative h-36 w-[104px] shrink-0 overflow-hidden rounded-lg bg-muted/40 ring-1 ring-border">
          {seed?.imageUrl ? (
            <CardImage
              src={seed.imageUrl}
              alt={seed.name}
              className="absolute inset-0 size-full"
            />
          ) : (
            <Skeleton className="absolute inset-0 size-full rounded-lg" />
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-2.5">
          <Skeleton className="h-5 w-20 rounded" />
          <div className="grid grid-cols-2 gap-x-3 gap-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-3.5 w-full rounded" />
            ))}
          </div>
        </div>
      </div>
      <div className="space-y-3 rounded-xl border bg-card/40 p-3">
        <Skeleton className="h-3.5 w-24 rounded" />
        <div className="grid grid-cols-2 gap-3">
          <Skeleton className="h-9 w-full rounded-md" />
          <Skeleton className="h-9 w-full rounded-md" />
        </div>
        <Skeleton className="h-9 w-full rounded-md" />
        <Skeleton className="h-8 w-full rounded-md" />
      </div>
    </div>
  );
}
