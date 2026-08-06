import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return <div className="space-y-3">{Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-44 rounded-xl" />)}</div>;
}
