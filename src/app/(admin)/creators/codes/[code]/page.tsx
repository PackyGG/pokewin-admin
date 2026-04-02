import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getCodeAnalytics } from "@/lib/queries/creators";
import { requirePageAccess } from "@/lib/dal";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCurrency, formatDateTime, formatNumber } from "@/lib/utils/format";
import { CodeAnalyticsCharts } from "./charts";

export default async function CodeAnalyticsPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  await requirePageAccess("/creators/codes");
  const { code } = await params;
  const data = await getCodeAnalytics(code);

  if (!data) notFound();

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/creators/codes" className="inline-flex size-9 items-center justify-center rounded-md hover:bg-accent hover:text-accent-foreground">
          <ArrowLeft className="size-4" />
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold font-mono">{data.code}</h1>
            <Badge
              variant="outline"
              className={
                data.isActive
                  ? "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30"
                  : "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30"
              }
            >
              {data.isActive ? "Active" : "Inactive"}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            Owner:{" "}
            <Link href={`/creators/${data.ownerUserId}`} className="hover:underline">
              {data.ownerUsername ?? data.ownerUserId.slice(0, 8)}
            </Link>
          </p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard label="Total Referrals" value={formatNumber(data.totalReferrals)} />
        <StatCard label="Total Deposits" value={formatCurrency(data.totalDeposits)} />
        <StatCard label="Total Wagers" value={formatCurrency(data.totalWagers)} />
        <StatCard label="Commission Earned" value={formatCurrency(data.totalCommission)} />
        <StatCard label="Total Clicks" value={formatNumber(data.totalClicks)} />
      </div>

      {data.daily.length > 0 && <CodeAnalyticsCharts data={data.daily} />}

      <Card>
        <CardContent className="pt-6">
          <h3 className="mb-4 text-sm font-medium">Recent Referrals</h3>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Deposit</TableHead>
                <TableHead>Wager</TableHead>
                <TableHead>Commission</TableHead>
                <TableHead>Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.recentReferrals.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <Link href={`/users/${r.referredUserId}`} className="hover:underline">
                      {r.referredUsername ?? r.referredUserId.slice(0, 8)}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{r.usageType}</Badge>
                  </TableCell>
                  <TableCell>{formatCurrency(r.depositAmountUsd)}</TableCell>
                  <TableCell>{formatCurrency(r.wagerAmountUsd)}</TableCell>
                  <TableCell className="text-green-400">{formatCurrency(r.referrerCutUsd)}</TableCell>
                  <TableCell>{formatDateTime(r.createdAt)}</TableCell>
                </TableRow>
              ))}
              {data.recentReferrals.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                    No referrals yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent>
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="text-2xl font-bold">{value}</p>
      </CardContent>
    </Card>
  );
}
