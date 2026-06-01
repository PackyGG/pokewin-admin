"use client";

import {
  CreatorCardGrid,
  CreatorListView,
  type CreatorWithSocials,
} from "./creator-card-grid";
import { useCreatorsView } from "./creators-view-context";

/**
 * Renders the creator roster as cards or compact rows, switched by the
 * client `view` state from <CreatorsViewProvider>. Both branches receive
 * the SAME `creators` prop the server already fetched — flipping the
 * toggle re-renders this in place with no navigation or refetch.
 *
 * Client-safe: imports only the already-client card/list renderers and
 * the view context — no server query-module value imports.
 */
export function CreatorsViewRender({
  creators,
}: {
  creators: CreatorWithSocials[];
}) {
  const { view } = useCreatorsView();

  return view === "list" ? (
    <CreatorListView creators={creators} />
  ) : (
    <CreatorCardGrid creators={creators} />
  );
}
