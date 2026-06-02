"use client";

import * as React from "react";

/**
 * Client-only state for the /creators username/email search.
 *
 * Why client state (not a `?search=` URL param): the roster is small
 * (~60 creators) and already fully rendered to the client. Filtering it
 * by name is a pure-presentation operation over data that's ALREADY in
 * the browser — exactly like the Grid ↔ List toggle next to it (see
 * creators-view-context.tsx for the same rationale).
 *
 * The previous `?search=` param drove the search through the URL, which
 * re-ran the page's server component on every keystroke. That re-fetch
 * re-executed the heaviest query on the page — the roster-wide
 * attribution-windowed GGR ledger scan (`getAllCreatorsNetGgr`, three
 * correlated-subquery passes over the entire ledger / inventory /
 * upgrader tables) — PLUS the full backend creator-roster walk, neither
 * of which depends on the search string. The result: typing a name kicked
 * off a full-table ledger reconstruction + a roster walk just to substring-
 * filter ~60 names. React `cache()` didn't help because every navigation
 * is a fresh request → cache miss → full recompute.
 *
 * Holding the query here makes filtering instant: the input writes to this
 * context and <CreatorsViewRender> reads it and filters the already-fetched
 * rows in place — no navigation, no refetch, no Suspense skeleton. The
 * provider wraps BOTH the input (in the toolbar) and the renderer (inside
 * the data Suspense boundary) so they share one state; the input keeps
 * rendering during any unrelated data refetch (it lives outside the
 * boundary, same as the view toggle).
 *
 * Deliberately NOT persisted (unlike the view mode): a search term is a
 * transient "find this creator right now" action, not a durable
 * preference. It resets to empty on reload, which is the expected
 * behaviour for a search box.
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
  const [query, setQuery] = React.useState("");

  const ctx = React.useMemo(() => ({ query, setQuery }), [query]);

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
  creator: { username: string | null; email: string | null },
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    (creator.username ?? "").toLowerCase().includes(q) ||
    (creator.email ?? "").toLowerCase().includes(q)
  );
}
