"use client";

import { useMemo } from "react";

import {
  CreatorCardGrid,
  CreatorListView,
  type CreatorWithSocials,
} from "./creator-card-grid";
import { useCreatorsView } from "./creators-view-context";
import {
  matchesCreatorSearch,
  useCreatorsSearch,
} from "./creators-search-context";

/**
 * Renders the creator roster as cards or compact rows, switched by the
 * client `view` state from <CreatorsViewProvider>, and narrowed by the
 * client `query` from <CreatorsSearchProvider>. Both inputs are pure
 * presentation over the SAME `creators` prop the server already fetched —
 * flipping the view OR typing in the search box re-renders this in place
 * with no navigation, no refetch, and no Suspense skeleton.
 *
 * The username/email filter runs here (instead of via a `?search=` URL
 * param) so searching the ~60-creator roster is instant — see
 * creators-search-context.tsx for why the old URL-param search was slow.
 * The match is case-insensitive across username + email, memoised on the
 * query + roster so an unrelated re-render doesn't re-scan.
 *
 * Client-safe: imports only the already-client card/list renderers and
 * the view + search contexts — no server query-module value imports.
 */
export function CreatorsViewRender({
  creators,
}: {
  creators: CreatorWithSocials[];
}) {
  const { view } = useCreatorsView();
  const { query } = useCreatorsSearch();

  const filtered = useMemo(
    () =>
      query.trim()
        ? creators.filter((c) => matchesCreatorSearch(c, query))
        : creators,
    [creators, query],
  );

  // Wrap the swapped outlet in a stable container with a short opacity
  // transition so flipping grid <-> list reads as a soft cross-fade rather
  // than a hard snap (CLS). `key={view}` re-mounts the inner tree on toggle
  // so the `motion-safe` fade-in actually re-fires; reduced-motion users get
  // the final state instantly (duration-0). Pure presentation over the same
  // already-fetched `filtered` roster — no refetch, no Suspense.
  return (
    <div
      key={view}
      className="motion-safe:animate-in motion-safe:fade-in transition-opacity duration-150 motion-reduce:duration-0"
    >
      {view === "list" ? (
        <CreatorListView creators={filtered} />
      ) : (
        <CreatorCardGrid creators={filtered} />
      )}
    </div>
  );
}
