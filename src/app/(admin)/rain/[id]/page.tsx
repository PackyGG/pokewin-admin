import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getRainDetail } from "@/lib/queries/rain";
import { requirePageAccess } from "@/lib/dal";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { formatCurrency, formatDateTime, formatNumber } from "@/lib/utils/format";
import { RainDetailsCard } from "./rain-detail-cards";

export const metadata = { title: "Rain Detail" };

const STATUS_COLORS: Record<string, string> = {
  active: "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30",
  drawing: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
  completed: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  cancelled: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
};

export default async function RainDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/rain");
  const { id } = await params;
  const sp = await searchParams;
  const entriesPage = Number(sp.page) || 1;
  const entriesPerPage = Number(sp.perPage) || 20;

  const data = await getRainDetail(id, { page: entriesPage, perPage: entriesPerPage });

  if (!data) notFound();

  const isActive = data.status === "active";

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link
          href="/rain"
          className="inline-flex size-9 items-center justify-center rounded-md hover:bg-accent hover:text-accent-foreground"
        >
          <ArrowLeft className="size-4" />
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold">Rain</h1>
            <Badge variant="outline" className={STATUS_COLORS[data.status] ?? ""}>
              {data.status}
            </Badge>
          </div>
        </div>
      </div>

      {/* Details Card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <InfoRow label="Status">{data.status}</InfoRow>
          <RainDetailsCard
            rainId={data.id}
            baseAmountUsd={data.baseAmountUsd}
            isActive={isActive}
          />
          <InfoRow label="Tip Amount">{formatCurrency(data.tipAmountUsd)}</InfoRow>
          <InfoRow label="Total Pool">{formatCurrency(data.totalPoolUsd)}</InfoRow>
          <InfoRow label="Participants">{formatNumber(data.participantCount)}</InfoRow>
          <InfoRow label="Starts">{formatDateTime(data.startsAt)}</InfoRow>
          <InfoRow label="Ends">{formatDateTime(data.endsAt)}</InfoRow>
          {data.completedAt && (
            <InfoRow label="Completed">{formatDateTime(data.completedAt)}</InfoRow>
          )}
          {data.winnerUserId && (
            <InfoRow label="Winner">
              <Link href={`/users/${data.winnerUserId}`} className="hover:underline">
                {data.winnerUsername ?? data.winnerUserId.slice(0, 8)}
              </Link>
            </InfoRow>
          )}
        </CardContent>
      </Card>

      {/* Tips Card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">
            Tips ({data.tips.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Team</TableHead>
                <TableHead>Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.tips.map((tip) => (
                <TableRow key={tip.id}>
                  <TableCell>
                    <Link href={`/users/${tip.userId}`} className="hover:underline">
                      {tip.username ?? tip.userId.slice(0, 8)}
                    </Link>
                  </TableCell>
                  <TableCell>{formatCurrency(tip.amountUsd)}</TableCell>
                  <TableCell>
                    {tip.isTeamMember && (
                      <Badge variant="outline" className="bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30">
                        Team
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>{formatDateTime(tip.createdAt)}</TableCell>
                </TableRow>
              ))}
              {data.tips.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                    No tips yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Entries Card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">
            Entries ({data.entries.total})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Verified At</TableHead>
                <TableHead>Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.entries.data.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell>
                    <Link href={`/users/${entry.userId}`} className="hover:underline">
                      {entry.username ?? entry.userId.slice(0, 8)}
                    </Link>
                  </TableCell>
                  <TableCell>{formatDateTime(entry.turnstileVerifiedAt)}</TableCell>
                  <TableCell>{formatDateTime(entry.createdAt)}</TableCell>
                </TableRow>
              ))}
              {data.entries.data.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} className="h-24 text-center text-muted-foreground">
                    No entries yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          <DataTablePagination
            page={data.entries.page}
            totalPages={data.entries.totalPages}
            total={data.entries.total}
            perPage={data.entries.perPage}
          />
        </CardContent>
      </Card>
    </div>
  );
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-muted-foreground">{label}:</span>
      <span className="text-sm">{children}</span>
    </div>
  );
}
