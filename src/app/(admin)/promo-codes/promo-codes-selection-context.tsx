"use client";

import * as React from "react";
import type { RowSelectionState } from "@tanstack/react-table";

/**
 * Client-only state for the /promo-codes table row-selection, shared
 * between the table (inside the data Suspense boundary) and the
 * Quick-select buttons (in the toolbar, OUTSIDE the boundary).
 *
 * Why a provider that wraps both: the Quick-select buttons ("Select
 * used-up" / "Select expired") now live in the same toolbar row as the
 * search input + status filter, so they render OUTSIDE the keyed table
 * Suspense (keeping the toolbar mounted/focused while the table streams
 * — see the comment in page.tsx). But they drive the table's
 * `rowSelection` and need the set of exhausted / expired ids the table
 * derives from its already-fetched page data. Holding both pieces here
 * lets the toolbar buttons and the table share one selection state, the
 * same pattern as CreatorsViewProvider / CreatorsSearchProvider, which
 * wrap the toolbar control + the in-boundary renderer for exactly this
 * reason.
 *
 * The table is the single source of the candidate id sets: it registers
 * `exhaustedIds` / `expiredIds` (computed purely from the loaded rows —
 * no extra query) via `setCandidates` and clears them on unmount, so a
 * navigation that swaps the page doesn't leave stale counts on the
 * buttons while the next table streams in.
 *
 * Deliberately NOT persisted: a selection is a transient "act on these
 * rows now" action, not a durable preference. It resets on reload.
 */

type Candidates = {
  exhaustedIds: string[];
  expiredIds: string[];
};

const EMPTY_CANDIDATES: Candidates = { exhaustedIds: [], expiredIds: [] };

type Ctx = {
  rowSelection: RowSelectionState;
  setRowSelection: React.Dispatch<React.SetStateAction<RowSelectionState>>;
  candidates: Candidates;
  setCandidates: (candidates: Candidates) => void;
  /** Replace the selection with EXACTLY the given ids (not a merge). */
  selectExactly: (ids: string[]) => void;
};

const PromoCodesSelectionContext = React.createContext<Ctx>({
  rowSelection: {},
  setRowSelection: () => {},
  candidates: EMPTY_CANDIDATES,
  setCandidates: () => {},
  selectExactly: () => {},
});

export function PromoCodesSelectionProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [rowSelection, setRowSelection] = React.useState<RowSelectionState>({});
  const [candidates, setCandidates] =
    React.useState<Candidates>(EMPTY_CANDIDATES);

  // Replace the selection with exactly the given ids so the count in the
  // bulk-action bar matches what the button promises (replace, not merge).
  const selectExactly = React.useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    setRowSelection(Object.fromEntries(ids.map((id) => [id, true])));
  }, []);

  const ctx = React.useMemo(
    () => ({
      rowSelection,
      setRowSelection,
      candidates,
      setCandidates,
      selectExactly,
    }),
    [rowSelection, candidates, selectExactly],
  );

  return (
    <PromoCodesSelectionContext.Provider value={ctx}>
      {children}
    </PromoCodesSelectionContext.Provider>
  );
}

export function usePromoCodesSelection() {
  return React.useContext(PromoCodesSelectionContext);
}
