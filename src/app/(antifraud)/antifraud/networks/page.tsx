import { Suspense } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Network,
  Search,
  ShieldAlert,
  Users,
} from "lucide-react";

import { HostLink } from "@/components/host-link";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
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
          backHref="/antifraud"
        />
      </PageHero>

      <form className="flex gap-2" action="/antifraud/networks">
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
          Search
        </Button>
      </form>

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
      <div className="space-y-2">
        {result.data.map((account) => (
          <HostLink
            key={account.id}
            href={`/antifraud/networks?user=${encodeURIComponent(account.id)}`}
            className="flex items-center gap-3 rounded-lg border border-border/70 bg-card p-3 hover:border-cyan-500/40"
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
            {account.country_code && <Badge variant="outline">{account.country_code}</Badge>}
          </HostLink>
        ))}
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
    <div className="space-y-4">
      <div className="grid grid-cols-2 overflow-hidden rounded-lg border border-border/70 bg-card lg:grid-cols-4">
        <Metric icon={Users} label="Accounts" value={snapshot.account_count} />
        <Metric icon={Network} label="IP nodes" value={snapshot.ip_count} />
        <Metric icon={Network} label="Devices" value={snapshot.device_count} />
        <div className="border-border/70 p-3 [&:not(:last-child)]:border-r">
          <div className="mb-1 flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Network risk</span>
            <span className="font-semibold tabular-nums">{snapshot.score}/100</span>
          </div>
          <RiskScoreBar score={snapshot.score} />
          <p className="mt-1 text-[10px] text-muted-foreground">
            Raw {snapshot.raw_score} pts
          </p>
        </div>
      </div>

      {snapshot.signals.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {snapshot.signals.map((signal) => (
            <Badge key={signal.key} variant="outline" className="border-rose-500/25 text-rose-600 dark:text-rose-400">
              {signal.title} +{signal.points}
            </Badge>
          ))}
        </div>
      )}

      {snapshot.truncated && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
          This unusually large component reached the 50,000-account safety
          boundary. The displayed network is marked partial.
        </div>
      )}

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

function Metric({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Network;
  label: string;
  value: number;
}) {
  return (
    <div className="flex items-center gap-2.5 border-border/70 p-3 [&:not(:last-child)]:border-r">
      <Icon className="size-4 text-cyan-500" />
      <span>
        <span className="block text-[11px] text-muted-foreground">{label}</span>
        <span className="block text-sm font-semibold tabular-nums">{value}</span>
      </span>
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
    <div className="space-y-4">
      <Skeleton className="h-20 rounded-lg" />
      <Skeleton className="h-[560px] rounded-xl" />
    </div>
  );
}
