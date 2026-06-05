"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { CreatorsViewMode } from "../_lib/search-params";

/**
 * URL-bound state for the /creators Grid ↔ List switch (Item C,
 * 2026-06-05): the view lives in `?view=` so bookmark + share parity
 * matches the rest of the controls (period, tab, sort, search).
 *
 * Pre-URL implementations held this in pure client state + localStorage
 * because flipping the view used to re-run the heavy server fetch. That
 * is no longer the case here: the server page deliberately OMITS `view`
 * from its Suspense `key=`, so a `?view=` change does NOT throw a fresh
 * boundary / refetch the roster. The provider just reads from
 * `useSearchParams` and writes via `router.replace` inside a transition;
 * `<CreatorsViewRender>` re-renders the SAME already-fetched rows in
 * place — no navigation, no refetch, no skeleton. The previous local-
 * storage rehydration is dropped because the URL is now the source of
 * truth across reloads (bookmarks beat per-device storage).
 *
 * SSR / first-paint parity: a missing `?view=` resolves to "grid", which
 * is the server's default render — so there is no hydration mismatch
 * and no one-frame flicker.
 */

// Re-exported here so existing imports (`./creators-view-context`) keep
// working without touching the view toggle + render call sites. The
// canonical definition (and the Zod parser) lives in
// `_lib/search-params.ts`.
export type { CreatorsViewMode } from "../_lib/search-params";

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
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = React.useTransition();

  // Parse via the Zod enum so an out-of-range URL token can't crash the
  // provider; defaults to "grid" (matches the server's first paint).
  const rawView = searchParams.get("view");
  const parsedView = CreatorsViewMode.safeParse(rawView);
  const view: CreatorsViewMode = parsedView.success ? parsedView.data : "grid";

  const setView = React.useCallback(
    (next: CreatorsViewMode) => {
      if (next === view) return;
      const params = new URLSearchParams(searchParams.toString());
      // "grid" is the default — drop the param so the URL stays clean
      // when an admin lands back on the default view.
      if (next === "grid") {
        params.delete("view");
      } else {
        params.set("view", next);
      }
      const qs = params.toString();
      startTransition(() => {
        router.replace(qs ? `?${qs}` : "?", { scroll: false });
      });
    },
    [router, searchParams, view],
  );

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
