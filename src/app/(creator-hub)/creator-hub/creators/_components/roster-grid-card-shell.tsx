"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

import { useRosterSelection } from "./roster-selection-context";

/** Grid card chrome — compare checkbox + selected ring around server card. */
export function RosterGridCardShell({
  creatorId,
  username,
  children,
}: {
  creatorId: string;
  username: string | null;
  children: React.ReactNode;
}) {
  const { isSelected, toggle, atMax } = useRosterSelection();
  const selected = isSelected(creatorId);
  const disabled = atMax && !selected;

  return (
    <div
      className={cn(
        "relative",
        selected && "rounded-2xl ring-1 ring-pink-500/30",
      )}
    >
      <div className="absolute right-3 top-3 z-10">
        <Checkbox
          checked={selected}
          disabled={disabled}
          onCheckedChange={() => toggle(creatorId)}
          aria-label={`Select ${username ?? "creator"} for compare`}
          className="bg-background shadow-sm"
        />
      </div>
      {children}
    </div>
  );
}
