import { Suspense } from "react";
import { Bot, CheckCircle2, Swords, Coins } from "lucide-react";
import { getBots } from "@/lib/queries/bots";
import { requirePageAccess } from "@/lib/dal";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { Skeleton } from "@/components/ui/skeleton";
import { BotsContent } from "./bots-content";
import {
  PageHero,
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

  const result = await getBots({
    page,
    perPage,
    search: params.search,
  });

  const activeBots = result.data.filter((b) => b.isActive).length;
  const pageWagered = result.data.reduce((s, b) => s + b.totalWageredUsd, 0);
  const pageBattles = result.data.reduce((s, b) => s + b.battlesPlayed, 0);

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10">
            <Bot className="size-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold leading-tight">Bots</h1>
            <p className="text-sm text-muted-foreground">
              Automated opponents for battle modes — activity and aggregate
              play stats.
            </p>
          </div>
        </div>
      </PageHero>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiTile
          label="Total Bots"
          value={formatNumber(result.total)}
          icon={Bot}
          accent="blue"
        />
        <KpiTile
          label="Active (page)"
          value={formatNumber(activeBots)}
          icon={CheckCircle2}
          accent="emerald"
        />
        <KpiTile
          label="Battles (page)"
          value={formatNumber(pageBattles)}
          icon={Swords}
          accent="purple"
        />
        <KpiTile
          label="Wagered (page)"
          value={formatCurrency(pageWagered)}
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
