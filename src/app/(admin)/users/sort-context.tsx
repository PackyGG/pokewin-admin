"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
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

const COMPARATORS: Record<string, (a: UserRow, b: UserRow) => number> = {
  username: (a, b) =>
    (a.username ?? a.email ?? "").localeCompare(b.username ?? b.email ?? ""),
  created_at: (a, b) => a.createdAt.localeCompare(b.createdAt),
  balance: (a, b) => a.availableBalance - b.availableBalance,
  totalDeposited: (a, b) => a.totalDeposited - b.totalDeposited,
  totalWithdrawn: (a, b) => a.totalWithdrawn - b.totalWithdrawn,
  totalWagered: (a, b) => a.totalWagered - b.totalWagered,
  pnl: (a, b) => a.pnl - b.pnl,
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
  const searchParams = useSearchParams();
  const urlSortBy = searchParams.get("sortBy") ?? "created_at";
  const urlSortOrder = (searchParams.get("sortOrder") ?? "desc") as Order;

  const [sortBy, setSortBy] = React.useState(urlSortBy);
  const [sortOrder, setSortOrder] = React.useState<Order>(urlSortOrder);
  const [localRows, setLocalRows] = React.useState<UserRow[]>(() =>
    sortRowsLocally(initialRows, urlSortBy, urlSortOrder),
  );

  // When the server returns a brand-new dataset (e.g. user navigated pages /
  // changed filters / search), reset to it sorted by current sort.
  React.useEffect(() => {
    setLocalRows(sortRowsLocally(initialRows, sortBy, sortOrder));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialRows]);

  const setSort = React.useCallback(
    (key: string, order: Order) => {
      // Instant client-side reorder. No server roundtrip — the URL is updated
      // silently so pagination/filter/refresh still pick up the right sort.
      setSortBy(key);
      setSortOrder(order);
      setLocalRows((current) => sortRowsLocally(current, key, order));

      const params = new URLSearchParams(searchParams.toString());
      params.set("sortBy", key);
      params.set("sortOrder", order);
      window.history.replaceState(null, "", `?${params.toString()}`);
    },
    [searchParams],
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
