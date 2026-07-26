import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  REVIEW_SEVERITY_COLORS,
  REVIEW_SEVERITY_LABELS,
  REVIEW_STATUS_COLORS,
  REVIEW_STATUS_LABELS,
  isReviewSeverity,
  isReviewStatus,
} from "@/lib/antifraud/constants";

export function ReviewStatusBadge({ status }: { status: string }) {
  const known = isReviewStatus(status);
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-5 px-1.5 text-[10px] font-bold uppercase tracking-wide",
        known ? REVIEW_STATUS_COLORS[status] : "",
      )}
    >
      {known ? REVIEW_STATUS_LABELS[status] : status}
    </Badge>
  );
}

export function ReviewSeverityBadge({ severity }: { severity: string }) {
  const known = isReviewSeverity(severity);
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-5 px-1.5 text-[10px] font-bold uppercase tracking-wide",
        known ? REVIEW_SEVERITY_COLORS[severity] : "",
      )}
    >
      {known ? REVIEW_SEVERITY_LABELS[severity] : severity}
    </Badge>
  );
}
