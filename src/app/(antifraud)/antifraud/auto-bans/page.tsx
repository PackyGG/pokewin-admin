import { Suspense } from "react";
import Link from "next/link";
import {
  Ban,
  CircleAlert,
  Clock3,
  ExternalLink,
  ShieldCheck,
  ShieldX,
} from "lucide-react";

import { HostLink } from "@/components/host-link";
import { KpiTile, PageHero, PageHeroIdentity, SectionHeading } from "@/components/modern-panels";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { listWhopAutoBans, type WhopAutoBanRow } from "@/lib/antifraud/auto-bans";
import { safeQueryOrNull } from "@/lib/errors/safe-query";
import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";
import { formatDateTime, formatRelative } from "@/lib/utils/format";
import { ListSearchForm } from "../_components/list-search-form";
import {
  AutoBansKpiSkeleton,
  AutoBansListSkeleton,
} from "./auto-bans-skeleton";

export const metadata = { title: "Auto Bans · Antifraud" };

const QUERY_TIMEOUT_MS = 10_000;

type SearchParams = Promise<{
  page?: string;
  search?: string;
  status?: string;
}>;

type AutoBansResult = Awaited<ReturnType<typeof listWhopAutoBans>>;
type AutoBansRead = { data: AutoBansResult | null };

function statusBadge(status: WhopAutoBanRow["status"]) {
  if (status === "applied") return <Badge variant="destructive">Banned</Badge>;
  if (status === "failed") return <Badge className="bg-amber-600">Retrying</Badge>;
  if (status === "skipped") return <Badge variant="outline">Skipped</Badge>;
  return <Badge variant="secondary">Pending</Badge>;
}

/**
 * Shell for the Whop-history auto-ban log.
 *
 * The body does the CHEAP work only — the access gate and the `?page` /
 * `?search` / `?status` parse — then paints the hero and the static search
 * panel immediately. The three admin reads live behind `<Suspense>`, and both
 * data regions await the SAME in-flight promise so the split boundary (needed
 * to keep the static search panel between the KPI strip and the list) still
 * costs exactly one round of queries. `safeQueryOrNull` never rejects, so
 * holding the promise unawaited here cannot raise an unhandled rejection — and
 * a slow or failing read now degrades to a panel instead of taking the whole
 * route to `error.tsx`.
 */
export default async function AutoBansPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requireAntifraudPageAccess();
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const search = params.search;
  const status = params.status;
  const read = safeQueryOrNull(
    () => listWhopAutoBans({ page, search, status }),
    "antifraud.auto-bans",
    QUERY_TIMEOUT_MS,
  );
  const boundaryKey = `${page}-${search ?? ""}-${status ?? ""}`;

  return (
    <div className="space-y-4">
      <PageHero>
        <PageHeroIdentity />
      </PageHero>

      <Suspense key={`kpi-${boundaryKey}`} fallback={<AutoBansKpiSkeleton />}>
        <AutoBansKpis read={read} />
      </Suspense>

      <div className="rounded-xl border border-border/60 bg-card p-3">
        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Search automatic actions
        </p>
        <ListSearchForm
          action="/antifraud/auto-bans"
          placeholder="User, payment or deposit intent ID"
          ariaLabel="Search automatic bans"
          defaultValue={params.search ?? ""}
          submitLabel="Search"
          className="flex-col gap-2 sm:flex-row"
          inputClassName="sm:max-w-md"
        />
      </div>

      <Suspense key={`list-${boundaryKey}`} fallback={<AutoBansListSkeleton />}>
        <AutoBansList read={read} search={search} status={status} />
      </Suspense>
    </div>
  );
}

async function AutoBansKpis({ read }: { read: Promise<AutoBansRead> }) {
  const { data } = await read;
  const counts = data?.counts;
  const value = (count: number | undefined) =>
    count === undefined ? "—" : String(count);

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <KpiTile label="Automatic bans" value={value(counts?.applied)} icon={Ban} accent="rose" />
      <KpiTile label="Pending" value={value(counts?.pending)} icon={Clock3} accent="orange" />
      <KpiTile label="Retrying" value={value(counts?.failed)} icon={CircleAlert} accent="orange" />
      <KpiTile label="Skipped" value={value(counts?.skipped)} icon={ShieldCheck} accent="blue" />
    </div>
  );
}

async function AutoBansList({
  read,
  search,
  status,
}: {
  read: Promise<AutoBansRead>;
  search?: string;
  status?: string;
}) {
  const { data: result } = await read;

  if (!result) {
    return (
      <div className="rounded-xl border border-dashed border-border/70 bg-card/40 px-4 py-14 text-center">
        <ShieldX className="mx-auto mb-3 size-6 text-muted-foreground" />
        <p className="text-sm font-semibold">Automatic bans could not be loaded</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Nothing was changed. Refresh to retry the read-only log.
        </p>
      </div>
    );
  }

  const base = new URLSearchParams();
  if (search) base.set("search", search);
  if (status) base.set("status", status);
  const pageHref = (page: number) => {
    const query = new URLSearchParams(base);
    query.set("page", String(page));
    return `/antifraud/auto-bans?${query}`;
  };

  return (
    <section className="overflow-hidden rounded-xl border border-border/60 bg-card">
      <div className="border-b border-border/60 px-4 py-3">
        <SectionHeading
          icon={Ban}
          title="Whop-history automatic bans"
          action={
            <span className="text-[10px] font-semibold uppercase tracking-wide tabular-nums text-muted-foreground">
              {result.pagination.total} actions
            </span>
          }
        />
      </div>
      {result.data.length === 0 ? (
        <div className="px-4 py-12 text-center text-sm text-muted-foreground">
          No Whop-history automatic bans match this search.
        </div>
      ) : (
        <div className="divide-y divide-border/60">
          {result.data.map((row) => (
            <article key={row.id} className="grid gap-3 px-4 py-4 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-center">
              <div className="min-w-0 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <HostLink href={`/users/${encodeURIComponent(row.userId)}`} className="font-semibold hover:underline">
                    {row.username ?? row.userId}
                  </HostLink>
                  {statusBadge(row.status)}
                  {row.providerRiskScore !== null && (
                    <Badge variant="outline">Whop risk {row.providerRiskScore}</Badge>
                  )}
                </div>
                <p className="text-sm">
                  Whop reported <strong>{row.priorDisputes}</strong> prior dispute(s) and{" "}
                  <strong>{row.priorRefunds}</strong> prior refund(s).
                </p>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>{row.priorFraudDeclines} fraud decline(s)</span>
                  <span>{row.highRiskSessions} high-risk session(s)</span>
                  <span>{row.paymentStatus ?? "Payment status unavailable"}</span>
                  {row.declineCode && <span>{row.declineCode}</span>}
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                  <span>Payment: {row.paymentId ?? "Unavailable"}</span>
                  <span>Intent: {row.depositIntentId ?? "Unavailable"}</span>
                  <span>Detected {formatRelative(row.detectedAt)}</span>
                  {row.appliedAt && (
                    <span>Banned {formatDateTime(row.appliedAt)}</span>
                  )}
                  <span>{row.attempts} containment attempt(s)</span>
                </div>
                {row.error && (
                  <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-700 dark:text-amber-300">
                    {row.error}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {row.reviewId && (
                  <Button
                    nativeButton={false}
                    size="sm"
                    variant="outline"
                    render={<HostLink href={`/antifraud/reviews/${row.reviewId}`} />}
                  >
                    Review <ExternalLink className="size-3.5" />
                  </Button>
                )}
                <Button
                  nativeButton={false}
                  size="sm"
                  variant="outline"
                  render={<HostLink href={`/users/${encodeURIComponent(row.userId)}`} />}
                >
                  Account <ExternalLink className="size-3.5" />
                </Button>
              </div>
            </article>
          ))}
        </div>
      )}
      {result.pagination.pages > 1 && (
        <div className="flex items-center justify-between border-t border-border/60 px-4 py-3">
          <Button
            nativeButton={false}
            size="sm"
            variant="outline"
            disabled={result.pagination.page <= 1}
            render={<Link href={pageHref(Math.max(1, result.pagination.page - 1))} />}
          >
            Previous
          </Button>
          <span className="text-xs text-muted-foreground">
            Page {result.pagination.page} of {result.pagination.pages}
          </span>
          <Button
            nativeButton={false}
            size="sm"
            variant="outline"
            disabled={result.pagination.page >= result.pagination.pages}
            render={<Link href={pageHref(Math.min(result.pagination.pages, result.pagination.page + 1))} />}
          >
            Next
          </Button>
        </div>
      )}
    </section>
  );
}
