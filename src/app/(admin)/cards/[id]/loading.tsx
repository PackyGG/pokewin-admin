import {
  DetailHeaderSkeleton,
  FormCardSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

export default function CardDetailLoading() {
  return (
    <div className="space-y-6">
      <DetailHeaderSkeleton />
      <div className="grid gap-6 md:grid-cols-2">
        <Skeleton className="aspect-[3/4] rounded-xl" />
        <FormCardSkeleton rows={5} />
      </div>
    </div>
  );
}
