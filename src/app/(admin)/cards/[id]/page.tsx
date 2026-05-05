import { notFound } from "next/navigation";
import Link from "next/link";
import { Layers, DollarSign, Heart, Package, Boxes } from "lucide-react";
import { BackButton } from "@/components/back-button";
import { getCardDetail, getSets } from "@/lib/queries/cards";
import { requirePageAccess } from "@/lib/dal";
import { Badge } from "@/components/ui/badge";
import { CardImage } from "@/components/card-image";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { PageHero, SectionHeading, KpiTile } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EditCardButton } from "./edit-card-button";
import { DeleteCardButton } from "./delete-card-button";

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
  const [data, sets] = await Promise.all([getCardDetail(id), getSets()]);

  if (!data) notFound();

  const detailRows = [
    { label: "Type", value: data.type },
    { label: "Artist", value: data.artist },
    { label: "Set", value: data.setName ?? "—" },
    { label: "Card #", value: data.cardNumber ?? "—" },
    { label: "TCGPlayer ID", value: data.tcgplayerId ? String(data.tcgplayerId) : "—" },
  ];

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <BackButton />
            <div className="flex size-10 items-center justify-center rounded-xl bg-blue-500/10">
              <Layers className="size-5 text-blue-500" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-2xl font-bold leading-tight">{data.name}</h1>
                {data.rarity && (
                  <Badge variant="outline" className={RARITY_COLORS[data.rarity.toLowerCase()] ?? ""}>
                    {data.rarity}
                  </Badge>
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                {data.setName ? `${data.setName} · ` : ""}
                {data.cardNumber ? `#${data.cardNumber}` : ""}
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <EditCardButton card={data} sets={sets} />
            <DeleteCardButton cardId={data.id} cardName={data.name} packCount={data.packs.length} packNames={data.packs.map((p: { name: string }) => p.name)} />
          </div>
        </div>
      </PageHero>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiTile
          label="Price"
          value={formatCurrency(data.priceUsd)}
          icon={DollarSign}
          accent="emerald"
        />
        <KpiTile
          label="HP"
          value={String(data.hp)}
          icon={Heart}
          accent="rose"
        />
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

      <FadeIn>
        <div className="rounded-2xl border bg-card p-5">
          <div className="flex flex-col gap-6 items-start sm:flex-row sm:gap-8">
            <div className="shrink-0 w-[160px] sm:w-[200px]">
              <CardImage src={data.imageUrl} alt={data.name} className="w-full rounded-lg" />
            </div>
            <div className="flex-1 min-w-0 grid grid-cols-1 gap-x-8 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
              {detailRows.map((s) => (
                <div key={s.label}>
                  <p className="text-xs uppercase tracking-wider text-muted-foreground">
                    {s.label}
                  </p>
                  <p className="mt-0.5 text-base font-semibold">{s.value}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </FadeIn>

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
