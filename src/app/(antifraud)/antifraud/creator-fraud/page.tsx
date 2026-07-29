import { Suspense } from "react";
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Search,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
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
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils/format";
import { RiskScoreBar } from "../_components/risk-score-bar";

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
        <PageHeroIdentity />
      </PageHero>

      <div className="rounded-xl border border-border/70 bg-card p-3">
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
          <form className="flex w-full gap-2 sm:w-auto" action="/antifraud/creator-fraud">
            <input type="hidden" name="window" value={window} />
            <Input
              name="search"
              defaultValue={search}
              placeholder="Creator, ID, or code"
              maxLength={100}
              aria-label="Search creators"
              className="min-w-0 sm:w-64"
            />
            <Button type="submit" variant="outline" aria-label="Search">
              <Search className="size-4" />
            </Button>
          </form>
        </div>
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
  if (result.error) return <Empty text="Affiliate cohort assessments could not be loaded." />;
  if (result.data.length === 0) {
    return (
      <Empty
        text={
          search
            ? "No creators match that search."
            : "No creator assessments are available for this window."
        }
      />
    );
  }
  return (
    <div className="space-y-4">
      <div className="space-y-3">
        {result.data.map((assessment) => (
          <CreatorRow key={assessment.creator_user_id} assessment={assessment} window={window} />
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
  const severity = severityStyle(assessment.score);
  const SeverityIcon = severity.icon;
  const creator = assessment.creator;
  const name =
    creator?.display_username ?? creator?.username ?? assessment.creator_user_id;
  return (
    <article className="rounded-xl border border-border/70 bg-card p-4 shadow-sm">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <Avatar className="size-10">
            {creator?.image && <AvatarImage src={creator.image} alt="" />}
            <AvatarFallback>{name.slice(0, 2).toUpperCase()}</AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="truncate font-semibold">{name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {assessment.creator_user_id}
            </p>
          </div>
          <div className="flex max-w-56 flex-wrap gap-1">
            {assessment.codes.slice(0, 3).map((code) => (
              <Badge key={code} variant="outline" className="font-mono text-[10px]">
                {code}
              </Badge>
            ))}
            {assessment.codes.length > 3 && (
              <Badge variant="outline">+{assessment.codes.length - 3}</Badge>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 xl:justify-end">
          <RowStat label="Referred" value={metrics.cohortSize.toLocaleString()} />
          <RowStat label="Connected" value={metrics.connectedAccounts.toLocaleString()} />
          <RowStat
            label="Deposits"
            value={formatCurrency(metrics.depositsUsd)}
            tone="text-emerald-600 dark:text-emerald-400"
          />
          <RowStat
            label="Wager"
            value={formatCurrency(metrics.wagerUsd)}
            tone="text-emerald-600 dark:text-emerald-400"
          />
          <div className={cn("min-w-40 rounded-lg border px-3 py-2", severity.box)}>
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className={cn("flex items-center gap-1.5 text-sm font-semibold capitalize", severity.text)}>
                <SeverityIcon className="size-4" />
                {assessment.severity}
              </span>
              <span className="text-xs font-semibold tabular-nums">
                {assessment.score}/100
              </span>
            </div>
            <RiskScoreBar score={assessment.score} />
          </div>
          <Button
            size="sm"
            render={
              <HostLink
                href={`/antifraud/creator-fraud/${assessment.creator_user_id}?window=${window}`}
              />
            }
          >
            Open assessment
            <ArrowRight className="size-3.5" />
          </Button>
        </div>
      </div>
    </article>
  );
}

function RowStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className="min-w-20">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className={cn("text-sm font-semibold tabular-nums", tone)}>{value}</p>
    </div>
  );
}

function severityStyle(score: number) {
  if (score >= 60) {
    return {
      icon: ShieldAlert,
      text: "text-rose-600 dark:text-rose-400",
      box: "border-rose-500/25 bg-rose-500/5",
    };
  }
  if (score >= 30) {
    return {
      icon: TriangleAlert,
      text: "text-amber-600 dark:text-amber-400",
      box: "border-amber-500/25 bg-amber-500/5",
    };
  }
  return {
    icon: ShieldCheck,
    text: "text-emerald-600 dark:text-emerald-400",
    box: "border-emerald-500/25 bg-emerald-500/5",
  };
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
      {Array.from({ length: 4 }).map((_, index) => (
        <Skeleton key={index} className="h-24 rounded-xl" />
      ))}
    </div>
  );
}
