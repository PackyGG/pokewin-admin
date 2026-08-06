import { RadioTower } from "lucide-react";

import { EmptyState as SharedEmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** Shared atoms for the Automation control-center tabs. */

/**
 * Thin wrappers over the canonical `@/components/empty-state` primitive so the
 * Automation tabs render the same empty state as the rest of the admin. The
 * dashed container is kept — it is what visually separates an empty section
 * from the solid `bg-card` panels around it.
 */
export function EmptyState({ text }: { text: string }) {
  return (
    <div className="rounded-xl border border-dashed border-border/70 bg-card/40">
      <SharedEmptyState title={text} />
    </div>
  );
}

export function Unavailable({ text }: { text: string }) {
  return (
    <div className="rounded-xl border border-dashed border-border/70 bg-card/40">
      <SharedEmptyState icon={RadioTower} title={text} />
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
