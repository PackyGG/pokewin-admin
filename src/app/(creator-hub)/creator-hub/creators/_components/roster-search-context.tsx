"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";

/**
 * URL-bound instant search for the Creator Hub roster.
 *
 * The query lives in `?q=` (bookmark + share parity with the sort/period
 * chips), but it NEVER gates a server query: the page reads `q` only to seed
 * the input's initial value, and the roster's Suspense boundary omits `q`, so
 * a keystroke does not refetch the roster. This provider holds a local mirror
 * of `q` for synchronous per-keystroke filtering and writes the URL via
 * `router.replace(..., { scroll: false })` inside a transition so the address
 * bar updates without pinning the input.
 *
 * Mirrors the proven `/creators` search-context pattern, kept local to the
 * Hub roster folder (collision-safe — no edits to the legacy file).
 */

type Ctx = {
  query: string;
  setQuery: (query: string) => void;
};

const RosterSearchContext = React.createContext<Ctx>({
  query: "",
  setQuery: () => {},
});

export function RosterSearchProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = React.useTransition();

  const urlQuery = searchParams.get("q") ?? "";
  const [query, setQueryState] = React.useState<string>(urlQuery);

  // Keep local state in lockstep when the URL changes EXTERNALLY (back /
  // forward, a sort change preserving but not touching `q`). The keystroke
  // path updates both synchronously, so the guard skips that as a no-op.
  React.useEffect(() => {
    if (urlQuery !== query) setQueryState(urlQuery);
    // Depend ONLY on urlQuery — including `query` would re-run per keystroke
    // and stomp the user mid-type.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlQuery]);

  const setQuery = React.useCallback(
    (next: string) => {
      setQueryState(next);
      const params = new URLSearchParams(searchParams.toString());
      if (next.trim() === "") params.delete("q");
      else params.set("q", next);
      const qs = params.toString();
      startTransition(() => {
        router.replace(qs ? `?${qs}` : "?", { scroll: false });
      });
    },
    [router, searchParams],
  );

  const ctx = React.useMemo(() => ({ query, setQuery }), [query, setQuery]);

  return (
    <RosterSearchContext.Provider value={ctx}>
      {children}
    </RosterSearchContext.Provider>
  );
}

export function useRosterSearch() {
  return React.useContext(RosterSearchContext);
}

/**
 * Case-insensitive username / email / code substring match. Used by both the
 * input (for the result count) and the grid (for the filter) so a creator the
 * count includes is exactly one the grid shows.
 */
export function matchesRosterSearch(
  creator: {
    id: string;
    username: string | null;
    email: string | null;
    code: string | null;
  },
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    creator.id.toLowerCase().includes(q) ||
    (creator.username ?? "").toLowerCase().includes(q) ||
    (creator.email ?? "").toLowerCase().includes(q) ||
    (creator.code ?? "").toLowerCase().includes(q)
  );
}
