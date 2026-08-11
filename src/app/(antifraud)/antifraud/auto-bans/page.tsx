import Link from "next/link";
import {
  Ban,
  CircleAlert,
  Clock3,
  ExternalLink,
  ShieldCheck,
} from "lucide-react";

import { HostLink } from "@/components/host-link";
import { KpiTile, PageHero, PageHeroIdentity, SectionHeading } from "@/components/modern-panels";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { listWhopAutoBans, type WhopAutoBanRow } from "@/lib/antifraud/auto-bans";
import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";
import { formatRelative } from "@/lib/utils/format";
import { ListSearchForm } from "../_components/list-search-form";

export const metadata = { title: "Auto Bans · Antifraud" };

type SearchParams = Promise<{
  page?: string;
  search?: string;
  status?: string;
}>;

function statusBadge(status: WhopAutoBanRow["status"]) {
  if (status === "applied") return <Badge variant="destructive">Banned</Badge>;
  if (status === "failed") return <Badge className="bg-amber-600">Retrying</Badge>;
  if (status === "skipped") return <Badge variant="outline">Skipped</Badge>;
  return <Badge variant="secondary">Pending</Badge>;
}

export default async function AutoBansPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requireAntifraudPageAccess();
  const params = await searchParams;
  const result = await listWhopAutoBans({
    page: Number(params.page) || 1,
    search: params.search,
    status: params.status,
  });
  const base = new URLSearchParams();
  if (params.search) base.set("search", params.search);
  if (params.status) base.set("status", params.status);
  const pageHref = (page: number) => {
    const query = new URLSearchParams(base);
    query.set("page", String(page));
    return `/antifraud/auto-bans?${query}`;
  };

  return (
    <div className="space-y-4">
      <PageHero>
        <PageHeroIdentity />
      </PageHero>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile label="Automatic bans" value={String(result.counts.applied)} icon={Ban} accent="rose" />
        <KpiTile label="Pending" value={String(result.counts.pending)} icon={Clock3} accent="orange" />
        <KpiTile label="Retrying" value={String(result.counts.failed)} icon={CircleAlert} accent="orange" />
        <KpiTile label="Skipped" value={String(result.counts.skipped)} icon={ShieldCheck} accent="blue" />
      </div>

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
                    {row.appliedAt && <span>Applied {formatRelative(row.appliedAt)}</span>}
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
    </div>
  );
}
