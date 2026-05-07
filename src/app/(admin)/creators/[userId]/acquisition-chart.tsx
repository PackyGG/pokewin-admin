"use client";

import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { ChevronDown } from "lucide-react";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/lib/utils/format";

type Bucket = { bucket: string; clicks: number; signups: number };

type Props = {
  hourly: Bucket[];
  daily: Bucket[];
};

const chartConfig = {
  clicks: { label: "Clicks", color: "var(--chart-1)" },
  signups: { label: "Signups", color: "var(--chart-4)" },
} satisfies ChartConfig;

const formatHourLabel = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:00`;
};

const formatDayLabel = (iso: string) => {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric" });
};

const formatFullHour = (iso: string) => {
  const d = new Date(iso);
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${String(d.getHours()).padStart(2, "0")}:00`;
};

const formatFullDay = (iso: string) => {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
};

type TableRowShape = {
  key: string;
  label: string;
  clicks: number;
  signups: number;
};

const rightCell = "text-right tabular-nums";

// CVR = signups / clicks for this single bucket. Bucket granularity is
// naturally noisy (a single click into signup = 100% CVR in a quiet hour),
// so "—" is more honest than a huge % when clicks are zero or very small.
const bucketCvr = (row: TableRowShape): string => {
  if (row.clicks === 0) return "—";
  return `${((row.signups / row.clicks) * 100).toFixed(1)}%`;
};

const tableColumns: ColumnDef<TableRowShape>[] = [
  {
    accessorKey: "label",
    header: "Bucket",
    cell: ({ row }) => (
      <span className="text-sm font-medium tabular-nums">
        {row.original.label}
      </span>
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
      <div className={rightCell}>{formatNumber(row.original.signups)}</div>
    ),
  },
  {
    id: "cvr",
    header: () => <div className={rightCell}>CVR</div>,
    cell: ({ row }) => (
      <div className={cn(rightCell, "text-muted-foreground")}>
        {bucketCvr(row.original)}
      </div>
    ),
  },
];

export function AcquisitionChart({ hourly, daily }: Props) {
  const [range, setRange] = useState<"24h" | "7d">("24h");
  const [expanded, setExpanded] = useState(false);

  const chartData = useMemo(() => {
    const source = range === "24h" ? hourly : daily;
    const format = range === "24h" ? formatHourLabel : formatDayLabel;
    return source.map((b) => ({ ...b, label: format(b.bucket) }));
  }, [range, hourly, daily]);

  // Table uses the more explicit full-date label so a bucket like "23:00"
  // isn't ambiguous across days when the user scans the breakdown. Chart
  // keeps the short label because axis space is tight.
  const tableRows: TableRowShape[] = useMemo(() => {
    const source = range === "24h" ? hourly : daily;
    const format = range === "24h" ? formatFullHour : formatFullDay;
    // Reverse so the most recent bucket sits at the top of the breakdown —
    // admins usually want the freshest numbers first.
    return source
      .map((b) => ({
        key: b.bucket,
        label: format(b.bucket),
        clicks: b.clicks,
        signups: b.signups,
      }))
      .reverse();
  }, [range, hourly, daily]);

  const totals = useMemo(() => {
    return chartData.reduce(
      (acc, b) => ({
        clicks: acc.clicks + b.clicks,
        signups: acc.signups + b.signups,
      }),
      { clicks: 0, signups: 0 },
    );
  }, [chartData]);

  const table = useReactTable({
    data: tableRows,
    columns: tableColumns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (r) => r.key,
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-4 pb-2">
        <div>
          <CardTitle className="text-card-title">Acquisition</CardTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {range === "24h" ? "Hourly — last 24h" : "Daily — last 7d"} ·{" "}
            {totals.clicks} clicks · {totals.signups} signups
          </p>
        </div>
        <div className="inline-flex items-center rounded-md border bg-background/60 p-0.5">
          {(["24h", "7d"] as const).map((r) => (
            <Button
              key={r}
              size="sm"
              variant="ghost"
              onClick={() => setRange(r)}
              className={cn(
                "h-7 px-2.5 text-xs",
                range === r
                  ? "bg-accent text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {r}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        <ChartContainer config={chartConfig} className="aspect-auto h-[220px] w-full">
          <ResponsiveContainer>
            <BarChart data={chartData} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
              <CartesianGrid vertical={false} strokeDasharray="3 3" className="stroke-border/50" />
              <XAxis
                dataKey="label"
                tickLine={false}
                axisLine={false}
                tickMargin={6}
                fontSize={11}
                interval={range === "24h" ? 2 : 0}
                className="fill-muted-foreground"
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                tickMargin={4}
                fontSize={11}
                width={28}
                allowDecimals={false}
                className="fill-muted-foreground"
              />
              <ChartTooltip
                cursor={{ fill: "var(--accent)", opacity: 0.3 }}
                content={<ChartTooltipContent indicator="dot" />}
              />
              <Bar
                dataKey="clicks"
                fill="var(--color-clicks)"
                radius={[3, 3, 0, 0]}
                animationDuration={700}
                animationEasing="ease-out"
              />
              <Bar
                dataKey="signups"
                fill="var(--color-signups)"
                radius={[3, 3, 0, 0]}
                animationDuration={700}
                animationEasing="ease-out"
              />
            </BarChart>
          </ResponsiveContainer>
        </ChartContainer>

        <div className="mt-3 border-t pt-3">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronDown
              className={cn(
                "size-3.5 transition-transform",
                expanded && "rotate-180",
              )}
            />
            {expanded ? "Hide" : "Show"} breakdown ({tableRows.length} buckets)
          </button>

          {expanded ? (
            <div className="mt-3 overflow-hidden rounded-md border">
              <Table>
                <TableHeader>
                  {table.getHeaderGroups().map((hg) => (
                    <TableRow key={hg.id}>
                      {hg.headers.map((header) => (
                        <TableHead key={header.id} className="h-9">
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
                        <TableCell key={cell.id} className="py-1.5">
                          {flexRender(
                            cell.column.columnDef.cell,
                            cell.getContext(),
                          )}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
