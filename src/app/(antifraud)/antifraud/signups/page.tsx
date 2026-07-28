import { Suspense } from "react";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Fingerprint,
  MapPin,
  Network,
  RadioTower,
  ScanSearch,
  ShieldCheck,
  UserRound,
  UserRoundSearch,
  Users,
} from "lucide-react";

import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";
import {
  listAntifraudSignups,
  type AntifraudSignup,
} from "@/lib/antifraud/signups";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { HostLink } from "@/components/host-link";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { ReviewSeverityBadge } from "../_components/badges";
import {
  NetworkRiskBadges,
  networkRiskLabels,
} from "../_components/network-risk-badges";
import { RiskScoreBar } from "../_components/risk-score-bar";

export const metadata = { title: "Signups · Antifraud" };

export default async function AntifraudSignupsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  await requireAntifraudPageAccess();
  const rawPage = Number((await searchParams).page ?? "1");
  const page =
    Number.isInteger(rawPage) && rawPage > 0 ? Math.min(rawPage, 10_000) : 1;

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={UserRoundSearch}
          accent="cyan"
          title="Signups"
          subtitle="Every new account with its signup risk assessment and provider checks"
        />
      </PageHero>

      <Suspense key={page} fallback={<SignupsSkeleton />}>
        <SignupsData page={page} />
      </Suspense>
    </div>
  );
}

async function SignupsData({ page }: { page: number }) {
  const result = await listAntifraudSignups(page);
  if (!result.configured) {
    return <EmptyState text="The monitor service is not configured." />;
  }
  if (result.error || !result.data) {
    return <EmptyState text="Signup assessments could not be loaded." />;
  }

  const { data, pagination, summary } = result.data;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Summary label="All signups" value={summary.total} icon={Users} />
        <Summary
          label="Risk checked"
          value={summary.assessed}
          icon={ShieldCheck}
          tone="text-emerald-600 dark:text-emerald-400"
        />
        <Summary
          label="Needs attention"
          value={summary.attention}
          icon={AlertTriangle}
          tone="text-rose-600 dark:text-rose-400"
        />
        <Summary
          label="Monitoring now"
          value={summary.monitoring}
          icon={RadioTower}
          tone="text-cyan-600 dark:text-cyan-400"
        />
      </div>

      {data.length === 0 ? (
        <EmptyState text="No signups have been assessed yet." />
      ) : (
        <div className="space-y-3">
          {data.map((signup) => (
            <SignupRow key={signup.user_id} signup={signup} />
          ))}
        </div>
      )}

      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>
          Page {pagination.page} of {pagination.pages} · {pagination.total} signups
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={pagination.page <= 1}
            render={
              pagination.page > 1 ? (
                <HostLink href={`/antifraud/signups?page=${pagination.page - 1}`} />
              ) : undefined
            }
          >
            <ChevronLeft className="size-3.5" />
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={pagination.page >= pagination.pages}
            render={
              pagination.page < pagination.pages ? (
                <HostLink href={`/antifraud/signups?page=${pagination.page + 1}`} />
              ) : undefined
            }
          >
            Next
            <ChevronRight className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function SignupRow({ signup }: { signup: AntifraudSignup }) {
  const initials = (signup.username ?? signup.email ?? "?")
    .slice(0, 2)
    .toUpperCase();
  const location = [signup.city, signup.state, signup.country_code]
    .filter(Boolean)
    .join(", ");
  const signals = signup.signals.filter((signal) => signal.points !== 0);
  const networkSignals = [
    ...signup.fingerprint_signals,
    ...signup.proxycheck_signals,
  ];
  const networkLabels = networkRiskLabels(networkSignals);

  return (
    <article className="rounded-xl border border-border/70 bg-card p-3 shadow-sm sm:p-4">
      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(320px,1.2fr)_minmax(240px,1fr)] lg:items-center xl:grid-cols-[minmax(350px,1.45fr)_minmax(190px,0.7fr)_minmax(230px,1fr)_auto]">
        <div className="min-w-0 space-y-2.5">
          <div className="flex min-w-0 items-center gap-3">
            <Avatar className="size-10 shrink-0">
              {signup.avatar_url && (
                <AvatarImage src={signup.avatar_url} alt={signup.username ?? "User"} />
              )}
              <AvatarFallback className="bg-cyan-500/10 text-xs font-semibold text-cyan-600 dark:text-cyan-400">
                {initials}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">
                {signup.username ?? "Unnamed account"}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {signup.email ?? signup.user_id}
              </p>
              <div
                className="mt-1 inline-flex max-w-full items-center gap-1.5 rounded-md border border-cyan-500/25 bg-cyan-500/[0.07] px-1.5 py-0.5"
                title={`Signed up ${formatDate(signup.source_created_at)}`}
              >
                <Clock3 className="size-3 shrink-0 text-cyan-600 dark:text-cyan-400" />
                <span className="truncate text-[11px] font-medium text-cyan-700 dark:text-cyan-300">
                  Signed up {formatSignupAge(signup.source_created_at)}
                </span>
              </div>
            </div>
            <div className="w-36 shrink-0 sm:w-40">
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <ReviewSeverityBadge severity={signup.severity} />
                <span className="text-xs font-semibold tabular-nums">
                  {signup.score} pts
                </span>
              </div>
              <RiskScoreBar score={signup.score} />
            </div>
          </div>

          <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 pl-[52px] text-xs">
            <Info icon={MapPin} value={location || "Location unavailable"} />
            <Info icon={Network} value={signup.signup_ip ?? "IP unavailable"} mono />
          </div>
        </div>

        <div className="grid min-w-0 gap-1.5 text-xs sm:grid-cols-2 lg:grid-cols-1">
          <Info
            icon={ScanSearch}
            value={
              signup.affiliate_code
                ? `Affiliate ${signup.affiliate_code}`
                : "No affiliate code"
            }
          />
          <Info
            icon={ShieldCheck}
            value={signup.referred_by ? "Referred signup" : "Direct signup"}
          />
          {signals.length > 0 && (
            <div className="flex min-w-0 flex-wrap gap-1 sm:col-span-2 lg:col-span-1">
              {signals.slice(0, 3).map((signal) => (
                <span
                  key={signal.key}
                  title={signal.title}
                  className={cn(
                    "inline-flex h-5 max-w-40 items-center gap-1 rounded-md border px-1.5 text-[10px]",
                    signal.points > 0
                      ? "border-rose-500/25 bg-rose-500/8 text-rose-600 dark:text-rose-400"
                      : "border-emerald-500/25 bg-emerald-500/8 text-emerald-600 dark:text-emerald-400",
                  )}
                >
                  <span className="truncate">{signal.title}</span>
                  <span className="shrink-0 font-bold tabular-nums">
                    {signal.points > 0 ? "+" : ""}
                    {signal.points}
                  </span>
                </span>
              ))}
              {signals.length > 3 && (
                <span className="inline-flex h-5 items-center rounded-md border border-border/60 px-1.5 text-[10px] text-muted-foreground">
                  +{signals.length - 3}
                </span>
              )}
            </div>
          )}
        </div>

        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <ProviderCheck
              icon={Fingerprint}
              label="Fingerprint"
              status={signup.fingerprint_status}
              score={signup.fingerprint_score}
              signalCount={signup.fingerprint_signals.length}
            />
            <ProviderCheck
              icon={Network}
              label="IP check"
              status={signup.proxycheck_status}
              score={signup.proxycheck_score}
              signalCount={signup.proxycheck_signals.length}
            />
          </div>
          {networkLabels.length > 0 && (
            <div className="flex flex-wrap gap-1">
              <NetworkRiskBadges signals={networkSignals} />
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            render={<HostLink href={`/users/${signup.user_id}`} />}
          >
            <UserRound className="size-3.5" />
            User profile
          </Button>
          <Button
            variant="outline"
            size="sm"
            render={
              <HostLink
                href={`/antifraud/networks?user=${encodeURIComponent(signup.user_id)}`}
              />
            }
          >
            <Network className="size-3.5" />
            Network
          </Button>
          {signup.case_id ? (
            <Button
              variant="outline"
              size="sm"
              render={<HostLink href={`/antifraud/reviews/${signup.case_id}`} />}
            >
              {signup.monitor_status === "active" && (
                <RadioTower className="size-3.5 text-cyan-500" />
              )}
              Open case
            </Button>
          ) : (
            <Badge variant="outline" className="text-[10px] text-muted-foreground">
              Cleared
            </Badge>
          )}
        </div>
      </div>
    </article>
  );
}

function ProviderCheck({
  icon: Icon,
  label,
  status,
  score,
  signalCount,
}: {
  icon: typeof Fingerprint;
  label: string;
  status: string | null;
  score: number | null;
  signalCount: number;
}) {
  const checked = status === "success";
  const result = checked
    ? signalCount > 0
      ? `${signalCount} signal${signalCount === 1 ? "" : "s"}`
      : "Clean"
    : status === "skipped" && signalCount > 0
      ? `${signalCount} signal${signalCount === 1 ? "" : "s"}`
      : status
        ? status[0]?.toUpperCase() + status.slice(1)
        : "Pending";
  return (
    <div className="min-w-0 rounded-md border border-border/60 bg-muted/20 px-2.5 py-2">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Icon className="size-3.5 shrink-0" />
        <span className="truncate">{label}</span>
      </div>
      <p className="mt-1 truncate text-xs font-medium">
        {result}
        {score != null ? ` · ${Math.round(score)}` : ""}
      </p>
    </div>
  );
}

function Info({
  icon: Icon,
  value,
  mono = false,
}: {
  icon: typeof MapPin;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
      <Icon className="size-3.5 shrink-0" />
      <span className={cn("truncate", mono && "font-mono text-[11px]")}>{value}</span>
    </div>
  );
}

function Summary({
  label,
  value,
  icon: Icon,
  tone = "text-muted-foreground",
}: {
  label: string;
  value: number;
  icon: typeof Users;
  tone?: string;
}) {
  return (
    <div className="rounded-xl border border-border/70 bg-card p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <Icon className={cn("size-4", tone)} />
      </div>
      <p className="mt-2 text-2xl font-semibold tabular-nums">
        {value.toLocaleString()}
      </p>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="rounded-xl border border-dashed border-border/70 bg-card/40 px-4 py-14 text-center">
      <UserRoundSearch className="mx-auto mb-3 size-6 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">{text}</p>
    </div>
  );
}

function SignupsSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-24 rounded-xl" />
        ))}
      </div>
      <div className="space-y-3">
        {Array.from({ length: 6 }).map((_, index) => (
          <div
            key={index}
            className="flex items-center gap-3 rounded-xl border border-border/70 bg-card p-4 shadow-sm"
          >
            <Skeleton className="size-10 shrink-0 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-44" />
              <Skeleton className="h-3 w-72 max-w-full" />
            </div>
            <Skeleton className="h-6 w-20" />
          </div>
        ))}
      </div>
    </div>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Berlin",
  }).format(new Date(value));
}

function formatSignupAge(value: string, now = Date.now()): string {
  const createdAt = new Date(value).getTime();
  if (!Number.isFinite(createdAt)) return "Unknown";

  const elapsedSeconds = Math.max(0, Math.floor((now - createdAt) / 1_000));
  if (elapsedSeconds < 60) return "Just now";

  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} ${days === 1 ? "day" : "days"} ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months} mo ago`;

  const years = Math.floor(days / 365);
  return `${years} ${years === 1 ? "yr" : "yrs"} ago`;
}
