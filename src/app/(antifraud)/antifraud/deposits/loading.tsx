import { Skeleton } from "@/components/ui/skeleton";

export default function DepositsLoading() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 5 }).map((_, index) => (
        <Skeleton key={index} className="h-52 w-full rounded-xl" />
      ))}
    </div>
  );
}
