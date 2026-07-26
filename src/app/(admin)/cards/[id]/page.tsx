import { notFound } from "next/navigation";
import Link from "next/link";
import {
  Layers,
  DollarSign,
  Heart,
  Package,
  Boxes,
  Swords,
  Coins,
  Fingerprint,
  Gauge,
  Tag,
  Clock,
} from "lucide-react";
import { BackButton } from "@/components/back-button";
import { getCardDetail, getSets } from "@/lib/queries/cards";
import { requirePageAccess } from "@/lib/dal";
import { isUuid } from "@/lib/utils/ids";
import { Badge } from "@/components/ui/badge";
import { CardImage } from "@/components/card-image";
import {
  formatCurrency,
  formatNumber,
  formatDateTime,
  formatRelative,
} from "@/lib/utils/format";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
  KpiTile,
  StatPanel,
  PanelRow,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EditCardButton } from "./edit-card-button";
import { DeleteCardButton } from "./delete-card-button";
import { safeQuery } from "@/lib/errors/safe-query";
import { InlineError } from "@/components/entity-surface";
import { isOnePieceSetName } from "../_constants/onepiece";
import { tcgplayerProductUrl } from "../_constants/tcgplayer";
import { ExternalLink } from "lucide-react";

export const metadata = { title: "Card Detail" };

const RARITY_COLORS: Record<string, string> = {
  common: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
  uncommon: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  rare: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  "ultra rare": "bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30",
  secret: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
};

export default async function CardDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePageAccess("/cards");
  const { id } = await params;
  // Shape-check UUID before any DB call — see src/lib/utils/ids.ts.
  if (!isUuid(id)) notFound();
  // Both fetches wrapped in safeQuery so a runtime DB fault (connection blip,
  // or a stale column on the live cards/sets table the worktree schema
  // is ahead of) degrades in place instead of rejecting the page-body
  // Promise.all and bubbling to the (admin) route error boundary — the
  // documented white-screen. A genuine 404 (detail query OK, row absent) still
  // falls through to notFound() below. The sets list only feeds the edit
  // dialog's set picker, so an empty fallback ([]) is harmless — EditCardButton
  // tolerates it.
  const [{ data, error: detailError }, { data: sets }] = await Promise.all([
    safeQuery(() => getCardDetail(id), null, "cards.detail"),
    safeQuery(
      () => getSets(),
      [] as Awaited<ReturnType<typeof getSets>>,
      "cards.detail.sets",
    ),
  ]);

  // Detail query threw → degrade in place (keep the back button + retry
  // usable) rather than crash the whole route. Never notFound() on an error —
  // the card may well exist; only the read failed.
  if (detailError) {
    return (
      <div className="space-y-6">
        <PageHero>
          <div className="flex items-center gap-3">
            <BackButton />
            <h1 className="text-xl font-semibold leading-tight tracking-tight">
              Card
            </h1>
          </div>
        </PageHero>
        <InlineError
          title="Couldn't load this card"
          hint="The card query failed — most likely a stale schema field that hasn't reached the live DB yet, or a transient connection blip. Retry, or head back to the catalog. Server logs hold the digest."
        />
      </div>
    );
  }
  if (!data) notFound();

  // Game-stat presentation forks on the card's set. OnePiece cards use a
  // "Life" stat (stored in the `hp` column — there is no dedicated `life`
  // column) and a "Power" stat; they have no Pokemon-style "HP" and we no
  // longer surface "Cost" for them. Pokemon cards keep their "HP" tile and
  // never show the OnePiece stats. `setName` is the single source of truth
  // (same rule the create dialog uses via isOnePieceSetName).
  const isOnePiece = isOnePieceSetName(data.setName);
  const dash = "—";

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Layers}
          accent="blue"
          back={<BackButton />}
          title={data.name}
          titleClassName="truncate"
          badges={
            data.rarity ? (
              <Badge variant="outline" className={RARITY_COLORS[data.rarity.toLowerCase()] ?? ""}>
                {data.rarity}
              </Badge>
            ) : undefined
          }
          subtitle={
            <>
              {data.setName ? `${data.setName} · ` : ""}
              {data.cardNumber ? `#${data.cardNumber}` : ""}
            </>
          }
          subtitleClassName="truncate"
          action={
            <div className="flex flex-wrap gap-1.5 sm:gap-2">
              <EditCardButton card={data} sets={sets} />
              <DeleteCardButton cardId={data.id} cardName={data.name} packCount={data.packs.length} packNames={data.packs.map((p: { name: string }) => p.name)} />
            </div>
          }
        />
      </PageHero>

      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 md:grid-cols-3 lg:grid-cols-6">
        {/* House-POV note: `Price` is the card's catalog value, not a
            user win/loss event, so the emerald/blue/cyan accents here are
            purely categorical (matching the rest of the catalog UI) — no
            financial-direction meaning is implied. */}
        <KpiTile
          label="Price"
          value={formatCurrency(data.priceUsd)}
          icon={DollarSign}
          accent="emerald"
        />
        {isOnePiece ? (
          <>
            {/* OnePiece: Life (sourced from the `hp` column) + Power. No
                Pokemon-style "HP" tile and no "Cost" tile. */}
            <KpiTile
              label="Life"
              value={data.hp != null ? String(data.hp) : dash}
              icon={Heart}
              accent="rose"
            />
            <KpiTile
              label="Power"
              value={data.power != null ? formatNumber(data.power) : dash}
              icon={Swords}
              accent="purple"
            />
          </>
        ) : (
          <KpiTile
            label="HP"
            value={data.hp != null ? String(data.hp) : dash}
            icon={Heart}
            accent="rose"
          />
        )}
        <KpiTile
          label="In Packs"
          value={String(data.packs.length)}
          icon={Package}
          accent="blue"
        />
        <KpiTile
          label="In Inventory"
          value={formatNumber(data.inventoryCount)}
          icon={Boxes}
          accent="cyan"
        />
      </div>

      <div className="space-y-3">
        <SectionHeading icon={Layers} title="Card attributes" />
        <FadeIn>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
            {/* Artwork — the image field, shown at a comfortable size with
                a soft card frame so it reads as the canonical asset. */}
            <div className="rounded-2xl border bg-card p-4">
              <CardImage
                src={data.imageUrl}
                alt={data.name}
                className="w-full rounded-lg"
              />
            </div>

            {/* Every other stored field, grouped into panels. Each row is
                a single column on the card so nothing is hidden — HP,
                cost/power, rarity, set, artist, pricing, ids and the
                create/update timestamps are all surfaced. */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <StatPanel title="Catalog" icon={Tag} accent="blue">
                <PanelRow label="Name" value={data.name} />
                <PanelRow
                  label="Rarity"
                  value={
                    data.rarity ? (
                      <Badge
                        variant="outline"
                        className={RARITY_COLORS[data.rarity.toLowerCase()] ?? ""}
                      >
                        {data.rarity}
                      </Badge>
                    ) : (
                      dash
                    )
                  }
                />
                <PanelRow label="Type" value={data.type} />
                <PanelRow label="Set" value={data.setName ?? dash} />
                <PanelRow label="Artist" value={data.artist ?? dash} />
              </StatPanel>

              <StatPanel title="Game stats" icon={Gauge} accent="rose">
                {isOnePiece ? (
                  <>
                    {/* OnePiece stats: Life (from the `hp` column) + Power.
                        No "HP" or "Cost" rows for OnePiece cards. */}
                    <PanelRow
                      label="Life"
                      value={data.hp != null ? formatNumber(data.hp) : dash}
                    />
                    <PanelRow
                      label="Power"
                      value={data.power != null ? formatNumber(data.power) : dash}
                    />
                  </>
                ) : (
                  <PanelRow
                    label="HP"
                    value={data.hp != null ? formatNumber(data.hp) : dash}
                  />
                )}
              </StatPanel>

              <StatPanel title="Economy" icon={Coins} accent="emerald">
                <PanelRow
                  label="Price"
                  value={formatCurrency(data.priceUsd)}
                />
                {/* `price_raw` is the pre-fee catalog price the create/edit
                    actions mirror from `price`. Surfaced for transparency
                    so every stored money column is visible. */}
                <PanelRow
                  label="Price (raw)"
                  value={formatCurrency(data.priceRawUsd)}
                />
                <PanelRow
                  label="In packs"
                  value={formatNumber(data.packs.length)}
                />
                <PanelRow
                  label="In inventory"
                  value={formatNumber(data.inventoryCount)}
                />
              </StatPanel>

              <StatPanel title="Identifiers" icon={Fingerprint} accent="cyan">
                <PanelRow
                  label="Card #"
                  value={data.cardNumber ?? dash}
                />
                {/* TCGplayer reference. The product LINK is the operator
                    input format, but only the integer product id is stored
                    (no url column exists). We reconstruct the canonical
                    product URL from the stored id — the original slug is not
                    retained (accepted no-migration tradeoff) — and render it
                    as a clickable link. Applies to OnePiece and any card
                    with a tcgplayer_id set; falls back to a dash otherwise. */}
                <PanelRow
                  label="TCGplayer"
                  value={
                    data.tcgplayerId != null ? (
                      <a
                        href={tcgplayerProductUrl(data.tcgplayerId)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-primary hover:underline"
                      >
                        View on TCGplayer
                        <ExternalLink className="size-3" />
                      </a>
                    ) : (
                      dash
                    )
                  }
                />
                <PanelRow
                  label="Card ID"
                  value={
                    <span className="font-mono text-xs">{data.id}</span>
                  }
                />
                <PanelRow
                  label="Set ID"
                  value={
                    data.setId ? (
                      <span className="font-mono text-xs">{data.setId}</span>
                    ) : (
                      dash
                    )
                  }
                />
              </StatPanel>

              <StatPanel
                title="Timestamps"
                icon={Clock}
                accent="amber"
              >
                <PanelRow
                  label="Created"
                  value={formatDateTime(data.createdAt)}
                />
                <PanelRow
                  label="Created (relative)"
                  value={formatRelative(data.createdAt)}
                  valueClassName="text-muted-foreground font-normal"
                />
                <PanelRow
                  label="Updated"
                  value={formatDateTime(data.updatedAt)}
                />
                <PanelRow
                  label="Updated (relative)"
                  value={formatRelative(data.updatedAt)}
                  valueClassName="text-muted-foreground font-normal"
                />
              </StatPanel>
            </div>
          </div>
        </FadeIn>
      </div>

      {data.packs.length > 0 && (
        <div className="space-y-3">
          <SectionHeading icon={Package} title="Packs containing this card" />
          <FadeIn className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
            {data.packs.map((pack: { id: string; name: string; imageUrl: string | null }) => (
              <Link
                key={pack.id}
                href={`/packs/${pack.id}`}
                className="group flex items-center gap-3 rounded-md border p-3 hover:bg-accent transition-colors"
              >
                <CardImage src={pack.imageUrl} alt={pack.name} className="size-10 rounded" />
                <span className="text-sm font-medium truncate group-hover:text-primary">{pack.name}</span>
              </Link>
            ))}
          </FadeIn>
        </div>
      )}
    </div>
  );
}
