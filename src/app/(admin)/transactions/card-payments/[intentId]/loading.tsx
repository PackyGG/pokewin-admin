import { DetailHeroSkeleton, KpiStripSkeleton, SectionHeadingSkeleton } from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

export default function CardPaymentDetailLoading() {
  return <div className="space-y-6"><DetailHeroSkeleton /><KpiStripSkeleton count={4} /><div className="space-y-3"><SectionHeadingSkeleton titleWidth={180} /><div className="grid gap-3 lg:grid-cols-2">{Array.from({ length: 2 }).map((_, card) => <div key={card} className="space-y-3 rounded-2xl border p-5"><Skeleton className="h-4 w-32" />{Array.from({ length: 8 }).map((__, row) => <div key={row} className="flex justify-between gap-4"><Skeleton className="h-3.5 w-24" /><Skeleton className="h-3.5 w-36" /></div>)}</div>)}</div></div></div>;
}
