import { Suspense } from "react";
import { notFound } from "next/navigation";
import Link from "next/link";
import {
  Coins,
  DollarSign,
  Users,
  Trophy,
  Info,
  Gift,
  Ticket,
  AlertTriangle,
} from "lucide-react";
import type { SafeQueryFailureKind } from "@/lib/errors/safe-query";
import {
  getRainEntries,
  type RainEntryItem,
  type RainTipItem,
} from "@/lib/queries/rain";
import {
  getRainHeaderCached,
  getRainTipsCached,
} from "@/lib/queries/rain-detail-cache";
import { safeQueryOrNull } from "@/lib/errors/safe-query";
import { requirePageAccess } from "@/lib/dal";
import { isUuid } from "@/lib/utils/ids";
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
import {
  SectionHeadingSkeleton,
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";
import { formatCurrency, formatDateTime, formatNumber } from "@/lib/utils/format";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
  KpiTile,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { RainDetailsCard } from "./rain-detail-cards";

export const metadata = { title: "Rain Detail" };

const STATUS_COLORS: Record<string, string> = {
  active: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  drawing: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
  completed: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  cancelled: "bg-muted text-muted-foreground border-border",
};

const SECTION_TIMEOUT_MS = 10_000;

export default async function RainDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/rain");
  const { id } = await params;
  // Shape-check UUID before any DB call — see src/lib/utils/ids.ts.
  if (!isUuid(id)) notFound();
  const sp = await searchParams;
  const entriesPage = Number(sp.page) || 1;
  const entriesPerPage = Number(sp.perPage) || 20;

  // Header is the only critical-path read: it decides 404 and feeds the
  // hero + KPI strip + Details panel. It is cached (prod-only, see
  // rain-detail-cache.ts) so it resolves from the warmed entry on every
  // entries `?page=` change instead of re-querying the summary boxes. The
  // heavier tips list + paginated entries stream independently below.
  const data = await getRainHeaderCached(id);

  if (!data) notFound();

  const isActive = data.status === "active";

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity backHref="/rewards?tab=rain" />
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
          sub={`${data.tipCount} tipper${data.tipCount === 1 ? "" : "s"}`}
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

      {/* Tips stream independently of the entries cursor — no re-fetch on
          pagination. */}
      <Suspense
        fallback={
          <div className="space-y-3">
            <SectionHeadingSkeleton titleWidth={100} />
            <TableSkeleton rows={6} columns={4} />
          </div>
        }
      >
        <TipsSection id={id} />
      </Suspense>

      {/* Entries are server-side paginated; the Suspense key re-renders ONLY
          this section as the admin pages. */}
      <Suspense
        key={`${entriesPage}|${entriesPerPage}`}
        fallback={
          <div className="space-y-3">
            <SectionHeadingSkeleton titleWidth={100} />
            <TableSkeleton rows={10} columns={3} />
            <PaginationSkeleton />
          </div>
        }
      >
        <EntriesSection id={id} page={entriesPage} perPage={entriesPerPage} />
      </Suspense>
    </div>
  );
}

async function TipsSection({ id }: { id: string }) {
  const { data: tips, error, kind } = await safeQueryOrNull(
    () => getRainTipsCached(id),
    "rain.detail.tips",
    SECTION_TIMEOUT_MS,
  );

  // Distinguish a real failure (data === null WITH an error) from a genuinely
  // empty tip list (data === [] with no error). A failure renders a rose
  // error/retry band; a real empty list keeps the neutral empty state.
  if (error) {
    return (
      <div className="space-y-3">
        <SectionHeading icon={Gift} title="Tips" />
        <SectionErrorBand
          kind={kind}
          what="tips"
          description={
            kind === "timeout"
              ? "The tips list took too long to load."
              : "The tips list failed to load."
          }
        />
      </div>
    );
  }

  const list: RainTipItem[] = tips ?? [];

  return (
    <div className="space-y-3">
      <SectionHeading icon={Gift} title={`Tips (${list.length})`} />
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
            {list.map((tip) => (
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
            {list.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={4} className="p-0">
                  <EmptyState
                    icon={Gift}
                    title="No tips yet"
                    description="Tips that fund this rain pool will appear here."
                    compact
                  />
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </FadeIn>
    </div>
  );
}

async function EntriesSection({
  id,
  page,
  perPage,
}: {
  id: string;
  page: number;
  perPage: number;
}) {
  const { data: entries, error, kind } = await safeQueryOrNull(
    () => getRainEntries(id, page, perPage),
    "rain.detail.entries",
    SECTION_TIMEOUT_MS,
  );

  // Real failure → rose error/retry band; a genuinely empty entries page keeps
  // the neutral empty state below.
  if (error) {
    return (
      <div className="space-y-3">
        <SectionHeading icon={Ticket} title="Entries" />
        <SectionErrorBand
          kind={kind}
          what="entries"
          description={
            kind === "timeout"
              ? "The entries list took too long to load."
              : "The entries list failed to load."
          }
        />
      </div>
    );
  }

  const result = entries ?? {
    data: [] as RainEntryItem[],
    total: 0,
    page,
    perPage,
    totalPages: 0,
  };

  return (
    <div className="space-y-3">
      <SectionHeading icon={Ticket} title={`Entries (${result.total})`} />
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
              {result.data.map((entry) => (
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
              {result.data.length === 0 && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={3} className="p-0">
                    <EmptyState
                      icon={Ticket}
                      title="No entries yet"
                      description="Players who join this rain will be listed here."
                      compact
                    />
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        <DataTablePagination
          page={result.page}
          totalPages={result.totalPages}
          total={result.total}
          perPage={result.perPage}
        />
      </FadeIn>
    </div>
  );
}

/**
 * Rose error/retry band for a rain detail section (Tips / Entries) whose
 * safeQueryOrNull read FAILED — as opposed to the neutral empty state shown
 * when the read succeeded but returned no rows. Distinguishing the two is the
 * whole point: a failure must not masquerade as "no tips yet". Rose because
 * it's an operational error band (House-POV money colors don't apply here —
 * this is chrome, not a money value). These are server components, so the
 * retry is a page refresh (link back to this rain), not a client onClick.
 */
function SectionErrorBand({
  kind,
  what,
  description,
}: {
  kind?: SafeQueryFailureKind | null;
  what: string;
  description: string;
}) {
  return (
    <div className="rounded-md border border-rose-500/30 bg-rose-500/5">
      <EmptyState
        icon={AlertTriangle}
        accent="rose"
        title={
          kind === "timeout" ? `Couldn’t load ${what} in time` : `Couldn’t load ${what}`
        }
        description={`${description} Refresh the page to retry — nothing was changed.`}
        compact
      />
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
