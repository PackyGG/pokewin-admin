import { notFound } from "next/navigation";
import Link from "next/link";
import {
  CloudRain,
  Coins,
  DollarSign,
  Users,
  Trophy,
  Info,
  Gift,
  Ticket,
} from "lucide-react";
import { getRainDetail } from "@/lib/queries/rain";
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
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
  KpiTile,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { RainDetailsCard } from "./rain-detail-cards";

export const metadata = { title: "Rain Detail" };

const STATUS_COLORS: Record<string, string> = {
  active: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
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
      <PageHero>
        <PageHeroIdentity
          icon={CloudRain}
          accent="blue"
          backHref="/rain"
          title="Rain"
          badges={
            <Badge variant="outline" className={STATUS_COLORS[data.status] ?? ""}>
              {data.status}
            </Badge>
          }
          subtitle={`${data.id.slice(0, 8)}…`}
          subtitleClassName="font-mono"
        />
      </PageHero>

      {/* Rain payouts go FROM us TO the winning user → user wins → ROSE.
          Tips that fund the pool come FROM users (deposits/wagers feeding
          the pool) → emerald. Participation count is neutral → blue. */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiTile
          label="Total Pool"
          value={formatCurrency(data.totalPoolUsd)}
          sub="Paid to winner"
          icon={DollarSign}
          accent="rose"
        />
        <KpiTile
          label="Tips"
          value={formatCurrency(data.tipAmountUsd)}
          sub={`${data.tips.length} tipper${data.tips.length === 1 ? "" : "s"}`}
          icon={Coins}
          accent="emerald"
        />
        <KpiTile
          label="Participants"
          value={formatNumber(data.participantCount)}
          icon={Users}
          accent="blue"
        />
        <KpiTile
          label="Winner"
          value={
            data.winnerUsername ??
            (data.winnerUserId ? data.winnerUserId.slice(0, 8) : "—")
          }
          icon={Trophy}
          accent="amber"
        />
      </div>

      <div className="space-y-3">
        <SectionHeading icon={Info} title="Details" />
        <FadeIn className="rounded-2xl border bg-card p-5 space-y-3">
          <InfoRow label="Status">
            <Badge variant="outline" className={STATUS_COLORS[data.status] ?? ""}>
              {data.status}
            </Badge>
          </InfoRow>
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
        </FadeIn>
      </div>

      <div className="space-y-3">
        <SectionHeading
          icon={Gift}
          title={`Tips (${data.tips.length})`}
        />
        <FadeIn className="rounded-md border overflow-hidden">
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
                  {/* Tips fund the pool — money flows FROM user TO us
                      → emerald (house keeps it until winner takes it). */}
                  <TableCell className="text-emerald-600 dark:text-emerald-400 tabular-nums">
                    {formatCurrency(tip.amountUsd)}
                  </TableCell>
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
        </FadeIn>
      </div>

      <div className="space-y-3">
        <SectionHeading
          icon={Ticket}
          title={`Entries (${data.entries.total})`}
        />
        <FadeIn className="space-y-4">
          <div className="rounded-md border overflow-hidden">
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
          </div>
          <DataTablePagination
            page={data.entries.page}
            totalPages={data.entries.totalPages}
            total={data.entries.total}
            perPage={data.entries.perPage}
          />
        </FadeIn>
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
