"use client";

import { useMemo } from "react";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatNumber } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

type ClicksShape = {
  total: number;
  last24h: number;
  last7d: number;
  last30d: number;
};

type SignupsShape = ClicksShape & { pending?: number };

type FtdByPeriod = Record<string, number>;

type FunnelRow = {
  key: string;
  period: string;
  clicks: number;
  signups: number;
  ftds: number;
  pendingSignups?: number;
};

const rightCell = "text-right tabular-nums";

// CVR = FTDs / Clicks. Null when clicks=0 so the UI doesn't render "0.0%"
// for creators with zero traffic (misleading) or "Infinity%" for divide-by-zero.
const formatCvr = (row: FunnelRow) => {
  if (row.clicks === 0) return "—";
  return `${((row.ftds / row.clicks) * 100).toFixed(1)}%`;
};

const columns: ColumnDef<FunnelRow>[] = [
  {
    accessorKey: "period",
    header: "Period",
    cell: ({ row }) => (
      <span className="font-medium">{row.original.period}</span>
    ),
  },
  {
    accessorKey: "clicks",
    header: () => <div className={rightCell}>Clicks</div>,
    cell: ({ row }) => (
      <div className={rightCell}>{formatNumber(row.original.clicks)}</div>
    ),
  },
  {
    accessorKey: "signups",
    header: () => <div className={rightCell}>Signups</div>,
    cell: ({ row }) => (
      <div className={rightCell}>
        {formatNumber(row.original.signups)}
        {row.original.pendingSignups ? (
          <span className="ml-1 text-[10px] text-muted-foreground">
            +{row.original.pendingSignups} pending
          </span>
        ) : null}
      </div>
    ),
  },
  {
    accessorKey: "ftds",
    header: () => <div className={rightCell}>FTDs</div>,
    cell: ({ row }) => (
      <div className={rightCell}>{formatNumber(row.original.ftds)}</div>
    ),
  },
  {
    id: "cvr",
    header: () => <div className={rightCell}>CVR</div>,
    cell: ({ row }) => (
      <div className={cn(rightCell, "text-muted-foreground")}>
        {formatCvr(row.original)}
      </div>
    ),
  },
];

type Props = {
  clicks: ClicksShape;
  signups: SignupsShape;
  ftdByPeriod: FtdByPeriod;
};

export function FunnelTable({ clicks, signups, ftdByPeriod }: Props) {
  // Stable identity across re-renders so React Table doesn't rebuild its
  // internal row model on every parent state change (sibling cards toggle,
  // dialogs open, etc.).
  const data = useMemo<FunnelRow[]>(
    () => [
      {
        key: "24h",
        period: "24h",
        clicks: clicks.last24h,
        signups: signups.last24h,
        ftds: ftdByPeriod["1d"] ?? 0,
        pendingSignups: signups.pending,
      },
      {
        key: "7d",
        period: "7d",
        clicks: clicks.last7d,
        signups: signups.last7d,
        ftds: ftdByPeriod["7d"] ?? 0,
      },
      {
        key: "30d",
        period: "30d",
        clicks: clicks.last30d,
        signups: signups.last30d,
        ftds: ftdByPeriod["30d"] ?? 0,
      },
      {
        key: "all",
        period: "All-time",
        clicks: clicks.total,
        signups: signups.total,
        ftds: ftdByPeriod.all ?? 0,
      },
    ],
    [clicks, signups, ftdByPeriod],
  );

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (r) => r.key,
  });

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-card-title">Acquisition funnel</CardTitle>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Clicks → Signups → Depositors
        </p>
      </CardHeader>
      <CardContent className="pt-0">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id}>
                {hg.headers.map((header) => (
                  <TableHead key={header.id}>
                    {header.isPlaceholder
                      ? null
                      : flexRender(
                          header.column.columnDef.header,
                          header.getContext(),
                        )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.map((row) => (
              <TableRow key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
