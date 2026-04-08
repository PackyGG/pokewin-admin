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
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlSortBy = searchParams.get("sortBy") ?? "created_at";
  const urlSortOrder = (searchParams.get("sortOrder") ?? "desc") as Order;

  const [sortBy, setSortBy] = React.useState(urlSortBy);
  const [sortOrder, setSortOrder] = React.useState<Order>(urlSortOrder);
  const [localRows, setLocalRows] = React.useState<UserRow[]>(() =>
    sortRowsLocally(initialRows, urlSortBy, urlSortOrder),
  );

  // When new server data arrives (after navigation, filter change, OR sort
  // refetch), merge it in. We re-sort it locally to be safe in case the server
  // ordering doesn't perfectly match what we asked for due to ties / pagination.
  React.useEffect(() => {
    setLocalRows(sortRowsLocally(initialRows, sortBy, sortOrder));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialRows]);

  const setSort = React.useCallback(
    (key: string, order: Order) => {
      // 1) Instant client-side reorder of CURRENTLY visible rows so the user
      //    sees feedback in the same frame as their click.
      setSortBy(key);
      setSortOrder(order);
      setLocalRows((current) => sortRowsLocally(current, key, order));

      // 2) In the background, ask the server for the *correct* sorted page
      //    (different users may belong on this page now). When the new data
      //    arrives, the FLIP animation in the table smooths the transition.
      const params = new URLSearchParams(searchParams.toString());
      params.set("sortBy", key);
      params.set("sortOrder", order);
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
