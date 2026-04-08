"use client";

import * as React from "react";

type Ctx = {
  pending: boolean;
  setPending: (v: boolean) => void;
};

const TablePendingContext = React.createContext<Ctx>({
  pending: false,
  setPending: () => {},
});

export function TablePendingProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [pending, setPending] = React.useState(false);
  const value = React.useMemo(() => ({ pending, setPending }), [pending]);
  return (
    <TablePendingContext.Provider value={value}>
      {children}
    </TablePendingContext.Provider>
  );
}

export function useTablePending() {
  return React.useContext(TablePendingContext);
}
