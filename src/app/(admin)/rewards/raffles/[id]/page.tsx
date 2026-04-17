import { notFound } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  Ticket,
  Users as UsersIcon,
  Gift,
  Info,
} from "lucide-react";
import { getRaffleDetail } from "@/lib/queries/raffles";
import { requirePageAccess } from "@/lib/dal";
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
import type { EnrichedPrize } from "@/lib/queries/raffles";
import { CancelRaffleButton } from "./cancel-raffle-button";
import { EditRaffleButton } from "../edit-raffle-button";
import { PageHero, SectionHeading, KpiTile } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";

export const metadata = { title: "Raffle Detail" };

const STATUS_COLORS: Record<string, string> = {
  active: "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30",
  completed: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  cancelled: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
};

export default async function RaffleDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/rewards/raffles");
  const { id } = await params;
  const sp = await searchParams;
  const entriesPage = Number(sp.page) || 1;
  const entriesPerPage = Number(sp.perPage) || 20;

  const data = await getRaffleDetail(id, { page: entriesPage, perPage: entriesPerPage });

  if (!data) notFound();

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex items-center gap-4 flex-wrap">
          <Link
            href="/rewards/raffles"
            className="inline-flex size-9 items-center justify-center rounded-md hover:bg-accent hover:text-accent-foreground shrink-0"
          >
            <ArrowLeft className="size-4" />
          </Link>
          <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10 shrink-0">
            <Ticket className="size-5 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-2xl font-bold leading-tight">{data.name}</h1>
              <Badge variant="outline" className={STATUS_COLORS[data.status] ?? ""}>
                {data.status}
              </Badge>
            </div>
            {data.description && (
              <p className="text-sm text-muted-foreground mt-0.5">{data.description}</p>
            )}
          </div>
          {data.status === "active" && (
            <div className="flex items-center gap-2">
              <EditRaffleButton
                raffleId={data.id}
                name={data.name}
                description={data.description}
                startsAt={data.startsAt}
                endsAt={data.endsAt}
                minPointsPerEntry={data.minPointsPerEntry}
                maxPointsPerEntry={data.maxPointsPerEntry}
                prizes={data.prizes as EnrichedPrize[]}
              />
              <CancelRaffleButton raffleId={data.id} />
            </div>
          )}
        </div>
      </PageHero>

      {/* KPI strip */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <KpiTile
          label="Total Entries"
          value={formatNumber(data.totalEntries)}
          icon={Ticket}
          accent="blue"
        />
        <KpiTile
          label="Participants"
          value={formatNumber(data.participantCount)}
          icon={UsersIcon}
          accent="emerald"
        />
        <KpiTile
          label="Prizes"
          value={String(Array.isArray(data.prizes) ? data.prizes.length : 0)}
          icon={Gift}
          accent="amber"
        />
      </div>

      <div className="space-y-3">
        <SectionHeading icon={Info} title="Details" />
        <FadeIn>
          <div className="rounded-2xl border bg-card/60 p-5 space-y-3">
            <InfoRow label="Total Entries">{formatNumber(data.totalEntries)}</InfoRow>
            <InfoRow label="Participants">{formatNumber(data.participantCount)}</InfoRow>
            <InfoRow label="Starts">{formatDateTime(data.startsAt)}</InfoRow>
            <InfoRow label="Ends">{formatDateTime(data.endsAt)}</InfoRow>
            {data.completedAt && <InfoRow label="Completed">{formatDateTime(data.completedAt)}</InfoRow>}
            {data.winnerUserId && (
              <InfoRow label="Winner">
                <Link href={`/users/${data.winnerUserId}`} className="hover:underline">
                  {data.winnerUsername ?? data.winnerUserId}
                </Link>
              </InfoRow>
            )}
          </div>
        </FadeIn>
      </div>

      {Array.isArray(data.prizes) && data.prizes.length > 0 && (
        <div className="space-y-3">
          <SectionHeading icon={Gift} title="Prizes" />
          <FadeIn>
            <div className="rounded-2xl border bg-card/60 p-5">
              <div className="flex flex-wrap justify-center gap-6">
                {(data.prizes as EnrichedPrize[]).map((prize, i) => (
                  <div key={i} className="flex flex-col items-center gap-2">
                    <Badge variant="outline">#{i + 1} &middot; {prize.type} {(prize.quantity ?? 1) > 1 && `x${prize.quantity}`}</Badge>
                    {prize.imageUrl ? (
                      <img
                        src={prize.imageUrl}
                        alt={prize.name ?? "Prize"}
                        className="size-[120px] rounded-md object-contain"
                      />
                    ) : (
                      <div className="flex size-[120px] items-center justify-center rounded-md bg-muted text-xs text-muted-foreground">
                        No image
                      </div>
                    )}
                    <span className="text-center text-sm font-medium">{prize.name ?? prize.id.slice(0, 8)}</span>
                    {prize.priceUsd != null && (
                      <span className="text-xs text-muted-foreground">{formatCurrency(prize.priceUsd)}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </FadeIn>
        </div>
      )}

      <div className="space-y-3">
        <SectionHeading
          icon={UsersIcon}
          title={`Entries (${data.entries.total})`}
        />
        <FadeIn>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Points Spent</TableHead>
                  <TableHead>Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.entries.data.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell>
                      <Link href={`/users/${e.userId}`} className="hover:underline">
                        {e.username ?? e.userId.slice(0, 8)}
                      </Link>
                    </TableCell>
                    <TableCell>{formatNumber(e.pointsSpent)}</TableCell>
                    <TableCell>{formatDateTime(e.createdAt)}</TableCell>
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
          </div>
        </FadeIn>
        <DataTablePagination
          page={data.entries.page}
          totalPages={data.entries.totalPages}
          total={data.entries.total}
          perPage={data.entries.perPage}
        />
      </div>
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
