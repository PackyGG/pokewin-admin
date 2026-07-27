import { Suspense } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Fingerprint,
  Gauge,
  Network,
  Search,
  ShieldAlert,
  Users,
  Wifi,
} from "lucide-react";

import { HostLink } from "@/components/host-link";
import { KpiTile, PageHero, PageHeroIdentity, SectionHeading } from "@/components/modern-panels";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  getAccountNetwork,
  getNetworkGraph,
  searchNetworkAccounts,
} from "@/lib/antifraud/network-api";
import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";
import { formatNumber, formatRelative } from "@/lib/utils/format";
import { ReviewSeverityBadge } from "../_components/badges";
import { RiskScoreBar } from "../_components/risk-score-bar";
import { AccountNetworkMap } from "./network-map";
import { ScanPoller } from "./scan-poller";

export const metadata = { title: "Account Networks · Antifraud" };

export default async function AccountNetworksPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; user?: string; page?: string }>;
}) {
  await requireAntifraudPageAccess();
  const params = await searchParams;
  const query = params.q?.trim().slice(0, 100) ?? "";
  const userId = params.user?.trim().slice(0, 100) ?? "";
  const rawPage = Number(params.page ?? "1");
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Network}
          accent="cyan"
          title="Account networks"
          subtitle="Trace complete signup-IP and device connections across accounts"
        />
      </PageHero>

      <div className="rounded-xl border bg-card p-4">
        <div className="flex items-center gap-2.5">
          <div className="shrink-0 rounded-lg bg-cyan-500/10 p-1.5">
            <Network className="size-4 text-cyan-500" />
          </div>
          <div className="min-w-0">
            <h1 className="text-sm font-semibold tracking-tight sm:text-base">
              Account networks
            </h1>
            <p className="truncate text-xs text-muted-foreground">
              Trace complete signup-IP and device connections across accounts
            </p>
          </div>
        </div>
        <form className="mt-3 flex gap-2" action="/antifraud/networks">
          <Input
            name="q"
            defaultValue={query}
            placeholder="Search username, exact email, or user ID"
            minLength={2}
            maxLength={100}
            aria-label="Search accounts"
          />
          <Button type="submit">
            <Search className="size-4" />
            <span className="hidden sm:inline">Search</span>
          </Button>
        </form>
      </div>

      <Suspense key={`${query}-${userId}-${page}`} fallback={<NetworkSkeleton />}>
        <NetworkContent query={query} userId={userId} page={page} />
      </Suspense>
    </div>
  );
}

async function NetworkContent({
  query,
  userId,
  page,
}: {
  query: string;
  userId: string;
  page: number;
}) {
  if (!userId && query.length < 2) {
    return <Empty text="Search for an account to build or open its connected network." />;
  }
  if (!userId) {
    const result = await searchNetworkAccounts(query);
    if (!result.configured) return <Empty text="The monitor service is not configured." />;
    if (result.error) return <Empty text="Account search could not be loaded." />;
    if (result.data.length === 0) return <Empty text="No matching accounts found." />;
    return (
      <div className="space-y-3">
        <SectionHeading
          icon={Users}
          title={
            <>
              Matching accounts
              <span className="text-xs font-normal text-muted-foreground">
                {result.data.length} result
                {result.data.length === 1 ? "" : "s"}
              </span>
            </>
          }
        />
        <div className="divide-y overflow-hidden rounded-xl border bg-card">
          {result.data.map((account) => (
            <HostLink
              key={account.id}
              href={`/antifraud/networks?user=${encodeURIComponent(account.id)}`}
              className="flex items-center gap-3 p-3 transition-colors hover:bg-accent/50"
            >
              <Avatar className="size-9">
                {account.image && <AvatarImage src={account.image} alt="" />}
                <AvatarFallback>{(account.username ?? "?").slice(0, 2)}</AvatarFallback>
              </Avatar>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">
                  {account.username ?? "Unnamed account"}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {account.email ?? account.id}
                </span>
              </span>
              {account.country_code && (
                <Badge variant="outline" className="shrink-0">
                  {account.country_code}
                </Badge>
              )}
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
            </HostLink>
          ))}
        </div>
      </div>
    );
  }

  const network = await getAccountNetwork(userId);
  if (!network.configured) return <Empty text="The monitor service is not configured." />;
  if (network.notFound) return <Empty text="That account does not exist." />;
  if (network.error) return <Empty text="The account network could not be loaded." />;
  if (network.queued || !network.data) {
    return (
      <Empty text="The account network is being calculated. This page refreshes every 30 seconds.">
        <ScanPoller />
      </Empty>
    );
  }
  const graph = await getNetworkGraph(network.data.id, page);
  if (!graph) return <Empty text="The network graph could not be loaded." />;
  const snapshot = graph.data.snapshot;
  return (
    <div className="space-y-5">
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.4fr)]">
        <div className="grid grid-cols-3 gap-3">
          <KpiTile
            icon={Users}
            accent="cyan"
            label="Accounts"
            value={formatNumber(snapshot.account_count)}
            sub="in this component"
          />
          <KpiTile
            icon={Wifi}
            accent="amber"
            label="IP nodes"
            value={formatNumber(snapshot.ip_count)}
            sub="shared signup IPs"
          />
          <KpiTile
            icon={Fingerprint}
            accent="purple"
            label="Devices"
            value={formatNumber(snapshot.device_count)}
            sub="shared fingerprints"
          />
        </div>

        <div className="rounded-lg border bg-card px-3 py-2.5 sm:px-4 sm:py-3">
          <div className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-2">
              <Gauge className="size-3.5 shrink-0 text-rose-500 sm:size-4" />
              <span className="truncate text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                Network risk
              </span>
            </span>
            <ReviewSeverityBadge severity={snapshot.severity} />
          </div>
          <p className="mt-1.5 text-xl font-bold leading-tight tracking-tight tabular-nums text-rose-600 dark:text-rose-400 sm:text-2xl">
            {snapshot.score}
            <span className="text-sm font-medium text-muted-foreground">
              /100
            </span>
          </p>
          <RiskScoreBar score={snapshot.score} className="mt-2" />
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            Raw {snapshot.raw_score} pts · scanned{" "}
            {formatRelative(snapshot.scanned_at)}
          </p>
        </div>
      </div>

      {snapshot.signals.length > 0 && (
        <div className="space-y-2">
          <SectionHeading
            icon={ShieldAlert}
            title={
              <>
                Risk signals
                <span className="text-xs font-normal text-muted-foreground">
                  {snapshot.signals.length} triggered
                </span>
              </>
            }
          />
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {snapshot.signals.map((signal) => (
              <div
                key={signal.key}
                className="rounded-lg border bg-card p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 text-xs font-semibold">
                    {signal.title}
                  </p>
                  <span className="shrink-0 rounded-md bg-rose-500/10 px-1.5 py-0.5 text-[11px] font-bold tabular-nums text-rose-600 dark:text-rose-400">
                    +{signal.points}
                  </span>
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                  {signal.detail}
                </p>
                <p className="mt-1.5 text-[10px] uppercase tracking-[0.12em] text-muted-foreground/70">
                  {signal.category} · {signal.value} vs {signal.threshold}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {snapshot.truncated && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" />
          <span>
            This unusually large component reached the 50,000-account safety
            boundary. The displayed network is marked partial.
          </span>
        </div>
      )}

      <SectionHeading
        icon={Network}
        title={
          <>
            Connection map
            <span className="text-xs font-normal text-muted-foreground">
              {formatNumber(snapshot.node_count)} nodes ·{" "}
              {formatNumber(snapshot.edge_count)} links
            </span>
          </>
        }
      />

      <AccountNetworkMap
        snapshotId={snapshot.id}
        rootUserId={userId}
        nodes={graph.data.nodes}
        edges={graph.data.edges}
      />

      {graph.pagination.pages > 1 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>Graph page {graph.pagination.page} of {graph.pagination.pages}</span>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={page <= 1}
              render={page > 1 ? <HostLink href={`/antifraud/networks?user=${encodeURIComponent(userId)}&page=${page - 1}`} /> : undefined}
            >
              <ChevronLeft className="size-3.5" />
              Previous
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={page >= graph.pagination.pages}
              render={page < graph.pagination.pages ? <HostLink href={`/antifraud/networks?user=${encodeURIComponent(userId)}&page=${page + 1}`} /> : undefined}
            >
              Next
              <ChevronRight className="size-3.5" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Empty({
  text,
  children,
}: {
  text: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-dashed border-border/70 bg-card/40 px-4 py-14 text-center">
      <ShieldAlert className="mx-auto mb-3 size-6 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">{text}</p>
      {children}
    </div>
  );
}

function NetworkSkeleton() {
  return (
    <div className="space-y-5">
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.4fr)]">
        <div className="grid grid-cols-3 gap-3">
          <Skeleton className="h-[86px] rounded-lg" />
          <Skeleton className="h-[86px] rounded-lg" />
          <Skeleton className="h-[86px] rounded-lg" />
        </div>
        <Skeleton className="h-[126px] rounded-lg lg:h-[86px]" />
      </div>
      <Skeleton className="h-9 w-56 rounded-lg" />
      <Skeleton className="h-[620px] rounded-xl" />
    </div>
  );
}
