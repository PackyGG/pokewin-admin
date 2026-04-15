import { notFound } from "next/navigation";
import { BackButton } from "@/components/back-button";
import { getPackDetail, getPackStats, getPackGames } from "@/lib/queries/packs";
import { requirePageAccess } from "@/lib/dal";
import { Badge } from "@/components/ui/badge";
import { CardImage } from "@/components/card-image";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { PackTabs } from "./pack-tabs";
import { PackStatsSection } from "./revenue-chart";
import { TogglePackButton } from "./toggle-pack-button";
import { EditPackButton } from "./edit-pack-button";
import { DeletePackButton } from "./delete-pack-button";

export const metadata = { title: "Pack Detail" };

export default async function PackDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePageAccess("/packs");
  const { id } = await params;
  const data = await getPackDetail(id);
  if (!data) notFound();

  const [packStats, initialGames] = await Promise.all([
    getPackStats(id, data.priceUsd, {
      totalPayout: data.totalPayout,
      actualRtp: data.actualRtp,
    }),
    getPackGames(id, 1, 20),
  ]);

  // RTP computed from actual revenue/payout data, not DB pre-computed field
  const rtp = packStats.rtp;
  const houseEdge = packStats.houseEdge;

  const stats = [
    { label: "Price", value: formatCurrency(data.priceUsd) },
    { label: "Openings", value: formatNumber(packStats.openings.all) },
    { label: "Revenue", value: formatCurrency(packStats.revenue.all) },
    { label: "Payout", value: formatCurrency(packStats.payout.all) },
    { label: "RTP", value: `${(rtp * 100).toFixed(2)}%`, warn: rtp > 1 },
    { label: "House Edge", value: `${(houseEdge * 100).toFixed(2)}%`, warn: houseEdge < 0 },
    { label: "Cards/Open", value: String(data.cardsPerOpen) },
    { label: "Total Cards", value: String(data.cards.length) },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <BackButton />
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold">{data.name}</h1>
            <Badge variant="outline" className={data.active
              ? "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30"
              : "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30"
            }>
              {data.active ? "Active" : "Inactive"}
            </Badge>
            <Badge variant="outline">{data.packType}</Badge>
            <TogglePackButton packId={data.id} active={data.active} />
            <EditPackButton pack={data} />
            <DeletePackButton packId={data.id} packName={data.name} />
          </div>
          <p className="font-mono text-xs text-muted-foreground">{data.slug}</p>
        </div>
      </div>

      <div className="flex gap-8 items-start">
        <div className="shrink-0 w-[200px]">
          <CardImage src={data.imageUrl} alt={data.name} className="w-full rounded-lg" />
        </div>
        <div className="flex-1 grid grid-cols-2 lg:grid-cols-4 gap-x-8 gap-y-5">
          {stats.map((s) => (
            <div key={s.label}>
              <p className="text-xs text-muted-foreground">{s.label}</p>
              <p className={`text-lg font-bold ${s.warn ? "text-red-400" : ""}`}>{s.value}</p>
            </div>
          ))}
        </div>
      </div>

      <PackStatsSection stats={packStats} />

      <PackTabs data={data} initialGames={initialGames} />
    </div>
  );
}
