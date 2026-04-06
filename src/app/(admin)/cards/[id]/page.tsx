import { notFound } from "next/navigation";
import Link from "next/link";
import { BackButton } from "@/components/back-button";
import { getCardDetail, getSets } from "@/lib/queries/cards";
import { requirePageAccess } from "@/lib/dal";
import { Badge } from "@/components/ui/badge";
import { CardImage } from "@/components/card-image";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { EditCardButton } from "./edit-card-button";
import { DeleteCardButton } from "./delete-card-button";

const RARITY_COLORS: Record<string, string> = {
  common: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
  uncommon: "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30",
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

  const stats = [
    { label: "Price", value: formatCurrency(data.priceUsd) },
    { label: "HP", value: String(data.hp) },
    { label: "Rarity", value: data.rarity },
    { label: "Type", value: data.type },
    { label: "Artist", value: data.artist },
    { label: "Set", value: data.setName ?? "—" },
    { label: "Card #", value: data.cardNumber ?? "—" },
    { label: "TCGPlayer ID", value: data.tcgplayerId ? String(data.tcgplayerId) : "—" },
    { label: "In Packs", value: String(data.packs.length) },
    { label: "In Inventory", value: formatNumber(data.inventoryCount) },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <BackButton />
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold">{data.name}</h1>
            {data.rarity && (
              <Badge variant="outline" className={RARITY_COLORS[data.rarity.toLowerCase()] ?? ""}>
                {data.rarity}
              </Badge>
            )}
            <EditCardButton card={data} sets={sets} />
            <DeleteCardButton cardId={data.id} cardName={data.name} packCount={data.packs.length} packNames={data.packs.map((p: { name: string }) => p.name)} />
          </div>
        </div>
      </div>

      <div className="flex gap-8 items-start">
        <div className="shrink-0 w-[200px]">
          <CardImage src={data.imageUrl} alt={data.name} className="w-full rounded-lg" />
        </div>
        <div className="flex-1 grid grid-cols-2 lg:grid-cols-5 gap-x-8 gap-y-5">
          {stats.map((s) => (
            <div key={s.label}>
              <p className="text-xs text-muted-foreground">{s.label}</p>
              <p className="text-lg font-bold">{s.value}</p>
            </div>
          ))}
        </div>
      </div>

      {data.packs.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold">Packs containing this card</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
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
          </div>
        </div>
      )}
    </div>
  );
}
