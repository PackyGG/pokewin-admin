"use client";

import * as React from "react";

/** Max creators that can be selected for compare (matches compare page). */
export const ROSTER_COMPARE_MAX = 3;
export const ROSTER_COMPARE_MIN = 2;

type Ctx = {
  selectedIds: string[];
  toggle: (id: string) => void;
  clear: () => void;
  isSelected: (id: string) => boolean;
  atMax: boolean;
  canCompare: boolean;
};

const RosterSelectionContext = React.createContext<Ctx>({
  selectedIds: [],
  toggle: () => {},
  clear: () => {},
  isSelected: () => false,
  atMax: false,
  canCompare: false,
});

/**
 * Ephemeral multi-select for the roster → Compare flow. Selection is
 * client-only (not URL-bound) until the user clicks Compare.
 */
export function RosterSelectionProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [selectedIds, setSelectedIds] = React.useState<string[]>([]);

  const toggle = React.useCallback((id: string) => {
    setSelectedIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= ROSTER_COMPARE_MAX) return prev;
      return [...prev, id];
    });
  }, []);

  const clear = React.useCallback(() => setSelectedIds([]), []);

  const isSelected = React.useCallback(
    (id: string) => selectedIds.includes(id),
    [selectedIds],
  );

  const ctx = React.useMemo(
    () => ({
      selectedIds,
      toggle,
      clear,
      isSelected,
      atMax: selectedIds.length >= ROSTER_COMPARE_MAX,
      canCompare: selectedIds.length >= ROSTER_COMPARE_MIN,
    }),
    [selectedIds, toggle, clear, isSelected],
  );

  return (
    <RosterSelectionContext.Provider value={ctx}>
      {children}
    </RosterSelectionContext.Provider>
  );
}

export function useRosterSelection() {
  return React.useContext(RosterSelectionContext);
}
