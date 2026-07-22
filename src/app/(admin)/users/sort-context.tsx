"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { UserRow } from "./columns";

type Order = "asc" | "desc";
type Ctx = {
  sortBy: string;
  sortOrder: Order;
  setSort: (key: string, order: Order) => void;
};

const UsersSortContext = React.createContext<Ctx>({
  sortBy: "created_at",
  sortOrder: "desc",
  setSort: () => {},
});

// Status-as-string ordering for the in-page click feedback. Matches the
// server's `is_banned DESC, is_locked DESC` collapse ("banned" > "locked"
// > "active") when sorted descending; ascending flips it. The server is
// the canonical sort — this just keeps the rows from re-shuffling
// between the click and the new server payload.
const STATUS_RANK: Record<string, number> = {
  banned: 2,
  locked: 1,
  active: 0,
};
/**
 * Sort keys whose ORDER BY runs in SQL across the full filtered user base.
 * Never re-sort these client-side — local comparators only see the current
 * page (~20 rows) and will surface the wrong "top" users when the server
 * slice and the displayed metric disagree (netHoldings / PnL toolbar
 * shortcuts).
 */
export const SERVER_RANKED_SORTS = new Set([
  "pnl",
  "netHoldings",
  "totalWithdrawn",
  "depositCount",
]);

const COMPARATORS: Record<string, (a: UserRow, b: UserRow) => number> = {
  username: (a, b) =>
    (a.username ?? a.email ?? "").localeCompare(b.username ?? b.email ?? ""),
  created_at: (a, b) => a.createdAt.localeCompare(b.createdAt),
  totalDeposited: (a, b) => a.totalDeposited - b.totalDeposited,
  totalWithdrawn: (a, b) => a.totalWithdrawn - b.totalWithdrawn,
  totalWagered: (a, b) => a.totalWagered - b.totalWagered,
  // Combined on-site holdings — surfaces whales without having to
  // mentally sum Balance + Inventory. Server query computes the same
  // expression in SQL so client + server agree on ordering.
  netHoldings: (a, b) => a.netHoldings - b.netHoldings,
  pnl: (a, b) => a.pnl - b.pnl,
  depositCount: (a, b) => a.depositCount - b.depositCount,
  status: (a, b) =>
    (STATUS_RANK[a.status] ?? -1) - (STATUS_RANK[b.status] ?? -1),
  country: (a, b) =>
    (a.country ?? a.countryCode ?? "").localeCompare(
      b.country ?? b.countryCode ?? "",
    ),
  // No comparators for `affiliate_code`, `role` or `balance` — those three
  // columns were removed from the table (owner, 2026-07-22), so nothing can
  // request those sorts from the UI. A stale URL (`?sortBy=balance`, …) still
  // sorts server-side and simply skips the local re-sort (sortRowsLocally
  // returns rows unchanged when no comparator matches).
};

export function sortRowsLocally(
  rows: UserRow[],
  sortBy: string,
  sortOrder: Order,
): UserRow[] {
  const cmp = COMPARATORS[sortBy];
  if (!cmp) return rows;
  const sign = sortOrder === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => sign * cmp(a, b));
}

export function UsersSortProvider({
  initialRows,
  children,
}: {
  initialRows: UserRow[];
  children: (rows: UserRow[]) => React.ReactNode;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlSortBy = searchParams.get("sortBy") ?? "created_at";
  const urlSortOrder = (searchParams.get("sortOrder") ?? "desc") as Order;

  const [sortBy, setSortBy] = React.useState(urlSortBy);
  const [sortOrder, setSortOrder] = React.useState<Order>(urlSortOrder);
  const [localRows, setLocalRows] = React.useState<UserRow[]>(() =>
    SERVER_RANKED_SORTS.has(urlSortBy)
      ? initialRows
      : sortRowsLocally(initialRows, urlSortBy, urlSortOrder),
  );

  // Toolbar shortcut buttons (Top user net worth, Top losers, etc.) update
  // the URL via router.replace but do NOT call setSort, so sortBy/sortOrder
  // state would stay stale (often created_at). Always derive the active
  // sort from the URL when fresh server rows land. For SQL-ranked sorts,
  // preserve the server row order exactly — re-sorting the current page
  // client-side was the "top net worth shows pennies" bug.
  React.useEffect(() => {
    setSortBy(urlSortBy);
    setSortOrder(urlSortOrder);
    setLocalRows(
      SERVER_RANKED_SORTS.has(urlSortBy)
        ? initialRows
        : sortRowsLocally(initialRows, urlSortBy, urlSortOrder),
    );
  }, [initialRows, urlSortBy, urlSortOrder]);

  const setSort = React.useCallback(
    (key: string, order: Order) => {
      // 1) Instant client-side reorder for column sorts only. Computed
      //    sorts (netHoldings, pnl, …) must wait for the server — reordering
      //    20 rows locally hides whales on other pages.
      setSortBy(key);
      setSortOrder(order);
      if (!SERVER_RANKED_SORTS.has(key)) {
        setLocalRows((current) => sortRowsLocally(current, key, order));
      }

      // 2) In the background, ask the server for the *correct* sorted page
      //    (different users may belong on this page now). When the new data
      //    arrives, the FLIP animation in the table smooths the transition.
      //    Reset to page 1 — otherwise clicking "Balance" on page 5 keeps
      //    you on page 5 of the new sort, which made it look like the sort
      //    wasn't working (the highest-balance users show on page 1).
      const params = new URLSearchParams(searchParams.toString());
      params.set("sortBy", key);
      params.set("sortOrder", order);
      params.delete("page");
      router.replace(`?${params.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  const ctx = React.useMemo(
    () => ({ sortBy, sortOrder, setSort }),
    [sortBy, sortOrder, setSort],
  );

  return (
    <UsersSortContext.Provider value={ctx}>
      {children(localRows)}
    </UsersSortContext.Provider>
  );
}

export function useUsersSort() {
  return React.useContext(UsersSortContext);
}
