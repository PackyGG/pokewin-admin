"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";

/**
 * Grid / List render-mode for the Hub roster, URL-bound to `?view=` for
 * bookmark + share parity. Pure presentation over the SAME already-fetched
 * rows (the roster Suspense key omits `view`), so switching is an instant
 * in-place re-render — no refetch, no skeleton.
 */

export type RosterViewMode = "grid" | "list";

type Ctx = {
  view: RosterViewMode;
  setView: (view: RosterViewMode) => void;
};

const RosterViewContext = React.createContext<Ctx>({
  view: "grid",
  setView: () => {},
});

function readView(value: string | null): RosterViewMode {
  return value === "list" ? "list" : "grid";
}

export function RosterViewProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = React.useTransition();

  const urlView = readView(searchParams.get("view"));
  const [view, setViewState] = React.useState<RosterViewMode>(urlView);

  React.useEffect(() => {
    if (urlView !== view) setViewState(urlView);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlView]);

  const setView = React.useCallback(
    (next: RosterViewMode) => {
      setViewState(next);
      const params = new URLSearchParams(searchParams.toString());
      // grid is the default → drop the param so the canonical URL is bare.
      if (next === "grid") params.delete("view");
      else params.set("view", next);
      const qs = params.toString();
      startTransition(() => {
        router.replace(qs ? `?${qs}` : "?", { scroll: false });
      });
    },
    [router, searchParams],
  );

  const ctx = React.useMemo(() => ({ view, setView }), [view, setView]);

  return (
    <RosterViewContext.Provider value={ctx}>
      {children}
    </RosterViewContext.Provider>
  );
}

export function useRosterView() {
  return React.useContext(RosterViewContext);
}
