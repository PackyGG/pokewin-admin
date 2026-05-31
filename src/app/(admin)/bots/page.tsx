import { Suspense } from "react";
import { Bot, CheckCircle2, Swords, Coins } from "lucide-react";
import { getBots, getBotsListStats } from "@/lib/queries/bots";
import { requirePageAccess } from "@/lib/dal";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { Skeleton } from "@/components/ui/skeleton";
import { BotsContent } from "./bots-content";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
  KpiTile,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { formatCurrency, formatNumber } from "@/lib/utils/format";

export const metadata = { title: "Bots" };

export default async function BotsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/bots");
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;

  // Table + global stats in parallel — stats stay stable across
  // search / pagination so the strip doesn't shift on every keystroke.
  const [result, stats] = await Promise.all([
    getBots({
      page,
      perPage,
      search: params.search,
    }),
    getBotsListStats(),
  ]);

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Bot}
          title="Bots"
          subtitle="Automated opponents for battle modes — activity and aggregate play stats."
        />
      </PageHero>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiTile
          label="Total Bots"
          value={formatNumber(stats.totalBots)}
          icon={Bot}
          accent="blue"
        />
        <KpiTile
          label="Active"
          value={formatNumber(stats.activeBots)}
          icon={CheckCircle2}
          accent="emerald"
        />
        <KpiTile
          label="Battles"
          value={formatNumber(stats.totalBattles)}
          icon={Swords}
          accent="purple"
        />
        <KpiTile
          label="Wagered"
          value={formatCurrency(stats.totalWageredUsd)}
          icon={Coins}
          accent="amber"
        />
      </div>

      <div className="space-y-3">
        <SectionHeading icon={Bot} title="All Bots" />
        <FadeIn className="space-y-4">
          <Suspense fallback={<Skeleton className="h-10 w-full" />}>
            <DataTableToolbar searchPlaceholder="Search by username..." />
          </Suspense>
          <BotsContent data={result.data} />
          <DataTablePagination
            page={result.page}
            totalPages={result.totalPages}
            total={result.total}
            perPage={result.perPage}
          />
        </FadeIn>
      </div>
    </div>
  );
}
