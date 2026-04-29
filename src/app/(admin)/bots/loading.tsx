import {
  PageHeroSkeleton,
  KpiStripSkeleton,
  ToolbarSkeleton,
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /bots: hero, 4 KPI tiles (Total / Active / Battles /
 * Wagered), search toolbar (no filter dropdowns), and a 9-column
 * bots table (Username / Battles / Won / Wagered / Won $ / Lost $ /
 * PnL / House Edge / Active).
 */
export default function BotsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <KpiStripSkeleton count={4} />
      <div className="space-y-4">
        <ToolbarSkeleton filters={0} />
        <TableSkeleton rows={8} columns={9} />
        <PaginationSkeleton />
      </div>
    </div>
  );
}
