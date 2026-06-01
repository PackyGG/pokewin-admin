"use client";

import * as React from "react";

/**
 * Client-only state for the /creators Grid ↔ List switch.
 *
 * Why state (not a `?view=` URL param): the grid/list choice is pure
 * presentation over the SAME already-fetched creator data. Driving it
 * through the URL made the server component re-run on every toggle → a
 * fresh Suspense skeleton + a full re-fetch of the (heavy) creator pool.
 * Holding `view` here lets the toggle (in the toolbar) and the renderer
 * (inside the data Suspense boundary) share one state, so flipping the
 * view is an instant local re-render — no navigation, no refetch, no
 * skeleton. The provider wraps BOTH so they stay in sync; the toggle
 * keeps rendering during data refetches (it lives outside the boundary).
 *
 * Persistence without re-introducing the refetch: the choice is mirrored
 * to `localStorage` and rehydrated on mount in an effect. It is
 * deliberately NOT put in the URL — a URL change is exactly the server
 * re-run we're removing. First paint always uses "grid" (the server's
 * default render) so SSR and the first client render agree; a list-
 * preferring admin sees a one-frame grid → list flip on load, the
 * standard accepted trade-off for a hydration-safe persisted preference.
 */

export type CreatorsViewMode = "grid" | "list";

const STORAGE_KEY = "creators-view";

type Ctx = {
  view: CreatorsViewMode;
  setView: (view: CreatorsViewMode) => void;
};

const CreatorsViewContext = React.createContext<Ctx>({
  view: "grid",
  setView: () => {},
});

export function CreatorsViewProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  // Default "grid" matches the server's default render so SSR and the
  // first client render agree (no hydration mismatch). The stored
  // preference is applied after mount.
  const [view, setViewState] = React.useState<CreatorsViewMode>("grid");

  React.useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "list" || stored === "grid") {
      setViewState(stored);
    }
  }, []);

  const setView = React.useCallback((next: CreatorsViewMode) => {
    setViewState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Private-mode / storage-disabled browsers: the toggle still works
      // for the session, it just won't persist. Not worth surfacing.
    }
  }, []);

  const ctx = React.useMemo(() => ({ view, setView }), [view, setView]);

  return (
    <CreatorsViewContext.Provider value={ctx}>
      {children}
    </CreatorsViewContext.Provider>
  );
}

export function useCreatorsView() {
  return React.useContext(CreatorsViewContext);
}
