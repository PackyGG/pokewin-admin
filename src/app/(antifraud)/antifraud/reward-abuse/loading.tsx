import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return <div className="space-y-4"><Skeleton className="h-32 rounded-xl" /><Skeleton className="h-20 rounded-xl" /><Skeleton className="h-80 rounded-xl" /></div>;
}
