import { Suspense } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Search,
  ShieldAlert,
  UserRoundSearch,
} from "lucide-react";

import { HostLink } from "@/components/host-link";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  listCreatorFraud,
  type CreatorFraudAssessment,
  type CreatorWindow,
} from "@/lib/antifraud/network-api";
import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";
import { formatCurrency } from "@/lib/utils/format";
import { RiskScoreBar } from "../_components/risk-score-bar";
import { ScanPoller } from "../networks/scan-poller";

export const metadata = { title: "Creator Fraud · Antifraud" };

const WINDOWS: Array<{ key: CreatorWindow; label: string }> = [
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "90d", label: "90 days" },
  { key: "lifetime", label: "Lifetime" },
];

export default async function CreatorFraudPage({
  searchParams,
}: {
  searchParams: Promise<{ window?: string; page?: string; search?: string }>;
}) {
  await requireAntifraudPageAccess();
  const params = await searchParams;
  const window = WINDOWS.some((item) => item.key === params.window)
    ? (params.window as CreatorWindow)
    : "30d";
  const rawPage = Number(params.page ?? "1");
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const search = params.search?.trim().slice(0, 100) ?? "";
  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={ShieldAlert}
          accent="cyan"
          title="Creator fraud"
          subtitle="Affiliate-code behavior, connected accounts, and economic risk"
          backHref="/antifraud"
        />
      </PageHero>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-1.5">
          {WINDOWS.map((item) => (
            <Button
              key={item.key}
              size="sm"
              variant={item.key === window ? "default" : "outline"}
              render={
                <HostLink
                  href={`/antifraud/creator-fraud?window=${item.key}${search ? `&search=${encodeURIComponent(search)}` : ""}`}
                />
              }
            >
              {item.label}
            </Button>
          ))}
        </div>
        <form className="flex gap-2" action="/antifraud/creator-fraud">
          <input type="hidden" name="window" value={window} />
          <Input
            name="search"
            defaultValue={search}
            placeholder="Creator, ID, or code"
            maxLength={100}
            aria-label="Search creators"
          />
          <Button type="submit" variant="outline">
            <Search className="size-4" />
          </Button>
        </form>
      </div>

      <Suspense key={`${window}-${page}-${search}`} fallback={<CreatorFraudSkeleton />}>
        <CreatorFraudContent window={window} page={page} search={search} />
      </Suspense>
    </div>
  );
}

async function CreatorFraudContent({
  window,
  page,
  search,
}: {
  window: CreatorWindow;
  page: number;
  search: string;
}) {
  const result = await listCreatorFraud({ window, page, search: search || undefined });
  if (!result.configured) return <Empty text="The monitor service is not configured." />;
  if (result.error) return <Empty text="Creator assessments could not be loaded." />;
  if (result.data.length === 0) {
    return (
      <Empty text="Creator assessments are being prepared. This page refreshes every 30 seconds.">
        <ScanPoller />
      </Empty>
    );
  }
  return (
    <div className="space-y-4">
      <div className="hidden overflow-x-auto rounded-xl border border-border/70 bg-card lg:block">
        <table className="w-full text-sm">
          <thead className="border-b border-border/70 bg-muted/30 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">Creator</th>
              <th className="px-3 py-3 font-medium">Codes</th>
              <th className="px-3 py-3 text-right font-medium">Accounts</th>
              <th className="px-3 py-3 text-right font-medium">Network</th>
              <th className="px-3 py-3 text-right font-medium">Deposits</th>
              <th className="px-3 py-3 text-right font-medium">Wager</th>
              <th className="min-w-40 px-4 py-3 font-medium">Risk</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {result.data.map((assessment) => (
              <CreatorRow key={assessment.creator_user_id} assessment={assessment} window={window} />
            ))}
          </tbody>
        </table>
      </div>
      <div className="space-y-3 lg:hidden">
        {result.data.map((assessment) => (
          <CreatorCard key={assessment.creator_user_id} assessment={assessment} window={window} />
        ))}
      </div>
      {result.pagination && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            Page {result.pagination.page} of {result.pagination.pages} ·{" "}
            {result.pagination.total} creators
          </span>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={page <= 1}
              render={page > 1 ? <HostLink href={creatorListHref(window, page - 1, search)} /> : undefined}
            >
              <ChevronLeft className="size-3.5" />
              Previous
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={page >= result.pagination.pages}
              render={page < result.pagination.pages ? <HostLink href={creatorListHref(window, page + 1, search)} /> : undefined}
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

function CreatorRow({
  assessment,
  window,
}: {
  assessment: CreatorFraudAssessment;
  window: CreatorWindow;
}) {
  const metrics = creatorMetrics(assessment);
  return (
    <tr className="hover:bg-muted/20">
      <td className="px-4 py-3">
        <CreatorIdentity assessment={assessment} />
      </td>
      <td className="px-3 py-3">
        <div className="flex max-w-52 flex-wrap gap-1">
          {assessment.codes.slice(0, 3).map((code) => (
            <Badge key={code} variant="outline" className="font-mono text-[10px]">
              {code}
            </Badge>
          ))}
          {assessment.codes.length > 3 && <Badge variant="outline">+{assessment.codes.length - 3}</Badge>}
        </div>
      </td>
      <td className="px-3 py-3 text-right tabular-nums">{metrics.cohortSize}</td>
      <td className="px-3 py-3 text-right tabular-nums">{metrics.connectedAccounts}</td>
      <td className="px-3 py-3 text-right font-medium text-emerald-600 dark:text-emerald-400">
        {formatCurrency(metrics.depositsUsd)}
      </td>
      <td className="px-3 py-3 text-right font-medium text-emerald-600 dark:text-emerald-400">
        {formatCurrency(metrics.wagerUsd)}
      </td>
      <td className="px-4 py-3">
        <HostLink href={`/antifraud/creator-fraud/${assessment.creator_user_id}?window=${window}`} className="block">
          <div className="mb-1 flex justify-between text-xs">
            <span className="capitalize">{assessment.severity}</span>
            <span className="font-semibold tabular-nums">{assessment.score}/100</span>
          </div>
          <RiskScoreBar score={assessment.score} />
        </HostLink>
      </td>
    </tr>
  );
}

function CreatorCard({
  assessment,
  window,
}: {
  assessment: CreatorFraudAssessment;
  window: CreatorWindow;
}) {
  const metrics = creatorMetrics(assessment);
  return (
    <HostLink
      href={`/antifraud/creator-fraud/${assessment.creator_user_id}?window=${window}`}
      className="block rounded-xl border border-border/70 bg-card p-4"
    >
      <CreatorIdentity assessment={assessment} />
      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <Mini label="Accounts" value={String(metrics.cohortSize)} />
        <Mini label="Connected" value={String(metrics.connectedAccounts)} />
        <Mini label="Deposits" value={formatCurrency(metrics.depositsUsd)} />
        <Mini label="Wager" value={formatCurrency(metrics.wagerUsd)} />
      </div>
      <div className="mt-3">
        <div className="mb-1 flex justify-between text-xs">
          <span className="capitalize">{assessment.severity}</span>
          <span className="font-semibold">{assessment.score}/100</span>
        </div>
        <RiskScoreBar score={assessment.score} />
      </div>
    </HostLink>
  );
}

function CreatorIdentity({ assessment }: { assessment: CreatorFraudAssessment }) {
  const creator = assessment.creator;
  const name =
    creator?.display_username ??
    creator?.username ??
    assessment.creator_user_id;
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <Avatar className="size-9">
        {creator?.image && <AvatarImage src={creator.image} alt="" />}
        <AvatarFallback>{name.slice(0, 2).toUpperCase()}</AvatarFallback>
      </Avatar>
      <span className="min-w-0">
        <span className="block truncate font-semibold">{name}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {assessment.creator_user_id}
        </span>
      </span>
    </div>
  );
}

function creatorMetrics(assessment: CreatorFraudAssessment) {
  const value = (key: string) => {
    const parsed = Number(assessment.metrics[key] ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return {
    cohortSize: value("cohortSize"),
    connectedAccounts: value("connectedAccounts"),
    depositsUsd: value("depositsUsd"),
    wagerUsd: value("wagerUsd"),
  };
}

function creatorListHref(window: CreatorWindow, page: number, search: string) {
  return `/antifraud/creator-fraud?window=${window}&page=${page}${search ? `&search=${encodeURIComponent(search)}` : ""}`;
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <span className="rounded-md bg-muted/40 p-2">
      <span className="block text-[10px] text-muted-foreground">{label}</span>
      <span className="block font-semibold tabular-nums">{value}</span>
    </span>
  );
}

function Empty({ text, children }: { text: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-border/70 bg-card/40 px-4 py-14 text-center">
      <UserRoundSearch className="mx-auto mb-3 size-6 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">{text}</p>
      {children}
    </div>
  );
}

function CreatorFraudSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-16 rounded-lg" />
      <Skeleton className="h-80 rounded-xl" />
    </div>
  );
}
