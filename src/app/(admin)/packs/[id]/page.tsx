import { notFound } from "next/navigation";
import {
  Package,
  DollarSign,
  Coins,
  Percent,
  TrendingUp,
  Layers,
  Boxes,
} from "lucide-react";
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
import { PageHero, KpiTile } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";

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

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex items-center gap-4 flex-wrap">
          <BackButton />
          <div className="shrink-0 hidden md:block">
            <CardImage
              src={data.imageUrl}
              alt={data.name}
              className="h-20 w-auto rounded-lg"
            />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-2xl font-bold leading-tight">{data.name}</h1>
              <Badge
                variant="outline"
                className={
                  data.active
                    ? "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30"
                    : "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30"
                }
              >
                {data.active ? "Active" : "Inactive"}
              </Badge>
              <Badge variant="outline">{data.packType}</Badge>
            </div>
            <p className="font-mono text-xs text-muted-foreground mt-0.5">{data.slug}</p>
          </div>
          <div className="flex items-center gap-2">
            <TogglePackButton packId={data.id} active={data.active} />
            <EditPackButton pack={data} />
            <DeletePackButton packId={data.id} packName={data.name} />
          </div>
        </div>
      </PageHero>

      {/* KPI strip */}
      <div className="grid gap-4 grid-cols-2 md:grid-cols-4 lg:grid-cols-8">
        <KpiTile
          label="Price"
          value={formatCurrency(data.priceUsd)}
          icon={DollarSign}
          accent="blue"
        />
        <KpiTile
          label="Openings"
          value={formatNumber(packStats.openings.all)}
          icon={Package}
          accent="cyan"
        />
        {/* Revenue = what users paid to open this pack (house gain,
            emerald). Payout = card value we handed back (house loss,
            rose). Per CLAUDE.md house-POV coloring. */}
        <KpiTile
          label="Revenue"
          value={formatCurrency(packStats.revenue.all)}
          icon={TrendingUp}
          accent="emerald"
        />
        <KpiTile
          label="Payout"
          value={formatCurrency(packStats.payout.all)}
          icon={Coins}
          accent="rose"
        />
        <KpiTile
          label="RTP"
          value={`${(rtp * 100).toFixed(2)}%`}
          icon={Percent}
          accent={rtp > 1 ? "rose" : "purple"}
        />
        <KpiTile
          label="House Edge"
          value={`${(houseEdge * 100).toFixed(2)}%`}
          icon={TrendingUp}
          accent={houseEdge < 0 ? "rose" : "emerald"}
        />
        <KpiTile
          label="Cards/Open"
          value={String(data.cardsPerOpen)}
          icon={Layers}
          accent="pink"
        />
        <KpiTile
          label="Total Cards"
          value={String(data.cards.length)}
          icon={Boxes}
          accent="orange"
        />
      </div>

      <FadeIn>
        <PackStatsSection stats={packStats} />
      </FadeIn>

      <PackTabs data={data} initialGames={initialGames} />
    </div>
  );
}
