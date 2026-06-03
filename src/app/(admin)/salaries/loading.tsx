import {
  PageHeroSkeleton,
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /salaries: hero, then the 3 KPI tiles the page renders
 * (Active Employees, Monthly Budget, Address Types) in a
 * grid-cols-2 md:grid-cols-3 strip, then the Employees register card
 * (heading + table). The page pivoted to a manual recipient registry +
 * QR codes, so there's no auto-payment wallet sidebar — the body is the
 * employees table followed by the payment log.
 */
export default function SalariesLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <KpiStripSkeleton count={3} />
      <div className="space-y-3">
        <SectionHeadingSkeleton action titleWidth={120} />
        <TableSkeleton rows={6} columns={6} />
      </div>
    </div>
  );
}
