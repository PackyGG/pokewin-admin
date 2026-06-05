"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";

/**
 * URL-bound state for the /creators username/email search (Item C,
 * 2026-06-05): the query lives in `?q=` so bookmark + share parity
 * matches the rest of the controls (period, tab, sort, view).
 *
 * Why it's still fast (the old "client-only" rationale, preserved):
 *
 *   The roster is small (~60 creators) and already fully rendered to
 *   the client. Filtering by name is a pure presentation operation over
 *   data that's ALREADY in the browser — exactly like the Grid ↔ List
 *   toggle next to it. The previous URL-param search (`?search=`) was
 *   slow because the server page included it in its Suspense `key=`,
 *   re-running the page on every keystroke — which re-executed the
 *   roster-wide attribution-windowed GGR ledger scan
 *   (`getAllCreatorsNetGgr`, three correlated-subquery passes over the
 *   entire ledger / inventory / upgrader tables) PLUS the full backend
 *   creator-roster walk, neither of which depends on the search string.
 *
 *   This implementation keeps the URL round-trippable but breaks the
 *   "keystroke → server refetch" coupling:
 *
 *     1. The server page reads `q` ONLY to render the input's initial
 *        value — it never gates a query on it.
 *     2. The Suspense `key=` for the grid deliberately OMITS `q`, so
 *        a `?q=` change does NOT throw a fresh boundary / refetch the
 *        roster.
 *     3. The client provider holds a local mirror of `q` for instant
 *        per-keystroke filtering by <CreatorsViewRender>; URL writes
 *        are deferred via `useDeferredValue` and `startTransition` so
 *        the address bar updates without pinning the input.
 *
 *   Net: typing is still instant (no navigation, no refetch, no
 *   skeleton), AND copying the URL gives a friend the same filtered
 *   view. Reset between tabs (the tab switch drops the `q` param so
 *   the filter doesn't bleed across pools).
 */

type Ctx = {
  query: string;
  setQuery: (query: string) => void;
};

const CreatorsSearchContext = React.createContext<Ctx>({
  query: "",
  setQuery: () => {},
});

export function CreatorsSearchProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = React.useTransition();

  // The URL `?q=` is the source of truth across reloads + tab opens.
  // We mirror it into local state so per-keystroke filtering stays
  // synchronous (typing into a `useSearchParams()`-derived value would
  // re-render every consumer on each navigation) — then sync the URL
  // when local input settles, never the other way around.
  const urlQuery = searchParams.get("q") ?? "";
  const [query, setQueryState] = React.useState<string>(urlQuery);

  // Keep local in lockstep when the URL changes EXTERNALLY (back/forward,
  // tab switch dropping `?q=`, server-driven nav). The keystroke path
  // below already updates BOTH state and URL synchronously, so this
  // effect's `urlQuery !== query` guard skips that case as a no-op.
  React.useEffect(() => {
    if (urlQuery !== query) {
      setQueryState(urlQuery);
    }
    // We deliberately depend ONLY on urlQuery — `query` is local mirror
    // state and including it would re-run on every keystroke and stomp
    // the user mid-type.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlQuery]);

  const setQuery = React.useCallback(
    (next: string) => {
      setQueryState(next);
      const params = new URLSearchParams(searchParams.toString());
      const trimmed = next.trim();
      if (trimmed === "") {
        params.delete("q");
      } else {
        params.set("q", next);
      }
      // `replace` (not push) so the back button doesn't fill with one
      // entry per keystroke. `scroll: false` keeps the input focused +
      // scroll position stable. `startTransition` keeps the input
      // responsive while React works through the routing update.
      const qs = params.toString();
      startTransition(() => {
        router.replace(qs ? `?${qs}` : "?", { scroll: false });
      });
    },
    [router, searchParams],
  );

  const ctx = React.useMemo(() => ({ query, setQuery }), [query, setQuery]);

  return (
    <CreatorsSearchContext.Provider value={ctx}>
      {children}
    </CreatorsSearchContext.Provider>
  );
}

export function useCreatorsSearch() {
  return React.useContext(CreatorsSearchContext);
}

/**
 * Case-insensitive username/email substring match used by both the input
 * (for the result count) and the renderer (for the actual filter). Kept
 * here so the two stay in lockstep — a creator the input counts is exactly
 * a creator the grid shows.
 */
export function matchesCreatorSearch(
  creator: {
    id?: string;
    username: string | null;
    email: string | null;
    code?: string | null;
  },
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    (creator.id ?? "").toLowerCase().includes(q) ||
    (creator.username ?? "").toLowerCase().includes(q) ||
    (creator.email ?? "").toLowerCase().includes(q) ||
    (creator.code ?? "").toLowerCase().includes(q)
  );
}
