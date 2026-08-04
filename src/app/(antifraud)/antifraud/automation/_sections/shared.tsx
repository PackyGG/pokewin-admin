import type { ReactNode } from "react";
import { RadioTower } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** Shared atoms for the Automation control-center tabs. */

export function EmptyState({ text }: { text: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-border/70 bg-card/40 px-4 py-12 text-center text-sm text-muted-foreground">
      {text}
    </div>
  );
}

export function Unavailable({ text }: { text: string }) {
  return (
    <div className="rounded-xl border border-dashed border-border/70 bg-card/40 px-4 py-14 text-center">
      <RadioTower
        className="mx-auto mb-3 size-6 text-muted-foreground"
        aria-hidden
      />
      <p className="text-sm text-muted-foreground">{text}</p>
    </div>
  );
}

export function ModeBadge({ mode }: { mode: "editable" | "mixed" | "fixed" }) {
  const label =
    mode === "editable"
      ? "Editable"
      : mode === "mixed"
        ? "Editable + fixed safety"
        : "Fixed safety policy";
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-5 text-[10px]",
        mode === "editable" &&
          "border-emerald-500/30 text-emerald-600 dark:text-emerald-400",
        mode === "mixed" && "border-cyan-500/30 text-cyan-600 dark:text-cyan-400",
        mode === "fixed" &&
          "border-amber-500/30 text-amber-600 dark:text-amber-400",
      )}
    >
      {label}
    </Badge>
  );
}

export function StatusBadge({ enabled }: { enabled: boolean }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-5 text-[10px]",
        enabled
          ? "border-emerald-500/30 text-emerald-600 dark:text-emerald-400"
          : "border-amber-500/30 text-amber-600 dark:text-amber-400",
      )}
    >
      {enabled ? "Active" : "Disabled"}
    </Badge>
  );
}
