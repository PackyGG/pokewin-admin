import { CheckCircle, Circle, XCircle } from "lucide-react";
import { formatDateTime } from "@/lib/utils/format";

type TimelineStep = {
  label: string;
  date: string | null;
  active: boolean;
  failed?: boolean;
};

export function StatusTimeline({ steps }: { steps: TimelineStep[] }) {
  return (
    <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
      {steps.map((step, i) => (
        <div key={step.label} className="flex items-center gap-1.5 sm:gap-2">
          {i > 0 && (
            <div
              className={`h-0.5 w-6 sm:w-8 ${
                step.active || step.date ? "bg-primary" : "bg-muted"
              }`}
            />
          )}
          <div className="flex flex-col items-center gap-1 min-w-[68px] sm:min-w-[80px]">
            {step.failed ? (
              <XCircle className="size-5 text-rose-400" />
            ) : step.date ? (
              <CheckCircle className="size-5 text-emerald-400" />
            ) : step.active ? (
              <Circle className="size-5 text-blue-400 fill-blue-400" />
            ) : (
              <Circle className="size-5 text-muted-foreground" />
            )}
            <span className="text-xs font-medium">{step.label}</span>
            {step.date && (
              <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                {formatDateTime(step.date)}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
