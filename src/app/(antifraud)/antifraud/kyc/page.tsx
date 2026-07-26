import { Suspense } from "react";
import {
  BadgeCheck,
  Check,
  CheckCircle2,
  Clock3,
  Database,
  Fingerprint,
  KeyRound,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  ShieldX,
  UserCheck,
  Webhook,
  X,
} from "lucide-react";

import { HostLink } from "@/components/host-link";
import { KpiTile, SectionHeading } from "@/components/modern-panels";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { canManageAntifraud } from "@/lib/antifraud/access";
import {
  getKycDashboard,
  isKycFilter,
  type KycAccount,
  type KycDashboard,
  type KycFilter,
} from "@/lib/antifraud/kyc";
import { safeQueryOrNull } from "@/lib/errors/safe-query";
import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";
import { cn } from "@/lib/utils";
import { formatDateTime, formatRelative } from "@/lib/utils/format";
import { RequireKycDialog } from "./_components/require-kyc-dialog";
import { ReviewKycControls } from "./_components/review-kyc-controls";

export const metadata = { title: "Home · KYC · Antifraud" };

const QUERY_TIMEOUT_MS = 10_000;

const FILTER_LABELS: Record<KycFilter, string> = {
  all: "All",
  required: "Required",
  awaiting_review: "Needs review",
  provider_pending: "Provider pending",
  approved: "Sumsub approved",
  rejected: "Rejected",
  cleared: "Cleared",
};

type SearchParams = {
  status?: string;
  q?: string;
};

export default async function AntifraudKycPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await requireAntifraudPageAccess();
  const params = await searchParams;
  const status = isKycFilter(params.status) ? params.status : "all";
  const search = params.q?.trim() || undefined;
  const canManage = canManageAntifraud(session);
  const contentKey = `${status}-${search ?? ""}`;

  return (
    <div className="w-full min-w-0 space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border/60 pb-4">
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-cyan-500/10 text-cyan-500">
            <Fingerprint className="size-4" />
          </span>
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight">Home</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Internal verification cycles, Sumsub evidence, and operating
              configuration
            </p>
          </div>
        </div>
        {canManage && <RequireKycDialog />}
      </header>

      <FilterBar status={status} search={search} />

      <Suspense key={contentKey} fallback={<DashboardSkeleton />}>
        <KycDashboardContent
          status={status}
          search={search}
          canManage={canManage}
        />
      </Suspense>
    </div>
  );
}

function buildHref(
  next: Partial<SearchParams>,
  current: SearchParams,
): string {
  const merged = { ...current, ...next };
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(merged)) {
    if (value) query.set(key, value);
  }
  const suffix = query.toString();
  return suffix ? `/antifraud/kyc?${suffix}` : "/antifraud/kyc";
}

function FilterBar({
  status,
  search,
}: {
  status: KycFilter;
  search?: string;
}) {
  const current: SearchParams = { status, q: search };
  return (
    <div className="space-y-2.5 rounded-lg border border-border/70 bg-card p-3">
      <nav aria-label="KYC status filters" className="flex flex-wrap gap-1.5">
        {Object.entries(FILTER_LABELS).map(([value, label]) => (
          <HostLink
            key={value}
            href={buildHref({ status: value, q: search }, current)}
            className={cn(
              "rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
              status === value
                ? "border-cyan-500/40 bg-cyan-500/10 text-cyan-600 dark:text-cyan-300"
                : "border-border/60 bg-muted/40 text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </HostLink>
        ))}
      </nav>

      <form className="flex gap-2">
        <input type="hidden" name="status" value={status} />
        <input
          type="search"
          name="q"
          defaultValue={search ?? ""}
          placeholder="Search player, email, user ID, or applicant ID…"
          className="h-8 min-w-0 flex-1 rounded-md border border-border/60 bg-background px-2.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <button
          type="submit"
          className="h-8 shrink-0 rounded-md border border-border/60 bg-muted/40 px-3 text-xs font-medium transition-colors hover:bg-muted"
        >
          Search
        </button>
      </form>
    </div>
  );
}

async function KycDashboardContent({
  status,
  search,
  canManage,
}: {
  status: KycFilter;
  search?: string;
  canManage: boolean;
}) {
  const result = await safeQueryOrNull(
    () => getKycDashboard({ status, search }),
    "antifraud.kyc-dashboard",
    QUERY_TIMEOUT_MS,
  );

  if (!result.data) {
    return (
      <div className="rounded-lg border border-dashed border-border/70 bg-card/40 px-4 py-12 text-center">
        <ShieldX className="mx-auto size-5 text-muted-foreground" />
        <p className="mt-2 text-sm font-semibold">KYC data could not be loaded</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Nothing was changed. Refresh to retry the read-only dashboard.
        </p>
      </div>
    );
  }

  const { stats } = result.data;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        <KpiTile
          label="Tracked"
          value={String(stats.total)}
          sub={`${stats.withApplicant} applicants`}
          icon={Database}
          accent="blue"
        />
        <KpiTile
          label="Required"
          value={String(stats.required)}
          sub="withdrawals locked"
          icon={LockKeyhole}
          accent="rose"
        />
        <KpiTile
          label="Needs review"
          value={String(stats.awaitingReview)}
          sub="admin decision pending"
          icon={Clock3}
          accent="amber"
        />
        <KpiTile
          label="Provider pending"
          value={String(stats.providerPending)}
          sub="pending or on hold"
          icon={RefreshCw}
          accent="orange"
        />
        <KpiTile
          label="Approved"
          value={String(stats.approved)}
          sub="Sumsub result"
          icon={BadgeCheck}
          accent="emerald"
        />
        <KpiTile
          label="Cleared"
          value={String(stats.cleared)}
          sub={`${stats.rejected} rejected`}
          icon={UserCheck}
          accent="cyan"
        />
      </div>

      <Configuration dashboard={result.data} />
      <AccountList
        accounts={result.data.accounts}
        canManage={canManage}
        filter={status}
      />
      <WebhookEvents dashboard={result.data} />
    </div>
  );
}

function Configuration({ dashboard }: { dashboard: KycDashboard }) {
  const { config, stats } = dashboard;
  const integrationRows = [
    {
      label: "Backend admin API URL",
      ready: config.backendUrlConfigured,
      note: "Routes status reads and every KYC mutation to the backend.",
    },
    {
      label: "Backend admin API key",
      ready: config.backendKeyConfigured,
      note: "Server-only credential. Its value is never exposed here.",
    },
    {
      label: "Cloudflare service access",
      ready: config.cloudflareAccessConfigured,
      note: "Optional service-token pair for protected backend deployments.",
    },
    {
      label: "Sumsub activity",
      ready: stats.withApplicant > 0 || stats.webhookEvents > 0,
      note: `${stats.withApplicant} applicants · ${stats.webhookEvents} webhook events`,
    },
  ];

  return (
    <section className="space-y-3">
      <SectionHeading icon={KeyRound} title="Configuration and policy" />
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="overflow-hidden rounded-lg border border-border/70 bg-card">
          <div className="border-b border-border/60 px-4 py-3">
            <p className="text-sm font-semibold">Integration health</p>
            <p className="text-xs text-muted-foreground">
              {config.env.toUpperCase()} environment · presence checks only
            </p>
          </div>
          <ul className="divide-y divide-border/60">
            {integrationRows.map((row) => (
              <li key={row.label} className="flex items-start gap-3 px-4 py-3">
                <span
                  className={cn(
                    "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md",
                    row.ready
                      ? "bg-emerald-500/10 text-emerald-500"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  {row.ready ? (
                    <Check className="size-3" />
                  ) : (
                    <X className="size-3" />
                  )}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{row.label}</span>
                  <span className="block text-xs text-muted-foreground">
                    {row.note}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="overflow-hidden rounded-lg border border-border/70 bg-card">
          <div className="border-b border-border/60 px-4 py-3">
            <p className="text-sm font-semibold">Decision contract</p>
            <p className="text-xs text-muted-foreground">
              The rules enforced by the internal KYC state machine
            </p>
          </div>
          <dl className="divide-y divide-border/60 text-xs">
            <ConfigRow label="Provider" value={config.provider} />
            <ConfigRow
              label="Default Sumsub level"
              value="Backend environment"
            />
            <ConfigRow
              label="Per-account override"
              value={
                stats.usedLevels.length
                  ? stats.usedLevels.join(", ")
                  : "None used"
              }
            />
            <ConfigRow
              label="Provider result"
              value="Informational; never auto-unlocks"
            />
            <ConfigRow
              label="Unlock authority"
              value="Owner/admin marks current cycle safe"
            />
            <ConfigRow
              label="Stale decision protection"
              value="Verification-cycle compare-and-set"
            />
            <ConfigRow
              label="Stored provider payload"
              value="Database only; raw PII hidden from this page"
            />
          </dl>
        </div>
      </div>
    </section>
  );
}

function ConfigRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-2.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="max-w-[60%] text-right font-medium">{value}</dd>
    </div>
  );
}

function AccountList({
  accounts,
  canManage,
  filter,
}: {
  accounts: KycAccount[];
  canManage: boolean;
  filter: KycFilter;
}) {
  return (
    <section className="space-y-3">
      <SectionHeading
        icon={Fingerprint}
        title={
          <>
            Accounts
            <span className="text-xs font-normal text-muted-foreground">
              ({accounts.length} shown · {FILTER_LABELS[filter]})
            </span>
          </>
        }
      />

      {accounts.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/70 bg-card/40 px-4 py-12 text-center">
          <CheckCircle2 className="mx-auto size-5 text-muted-foreground" />
          <p className="mt-2 text-sm font-semibold">No matching KYC accounts</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Change the filter or search, or require KYC for an account.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {accounts.map((account) => (
            <AccountCard
              key={account.userId}
              account={account}
              canManage={canManage}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function AccountCard({
  account,
  canManage,
}: {
  account: KycAccount;
  canManage: boolean;
}) {
  const label =
    account.displayUsername ?? account.username ?? account.email ?? account.userId;
  const awaitingReview =
    account.kycRequired && account.adminDecision === "pending";

  return (
    <details className="group overflow-hidden rounded-lg border border-border/70 bg-card">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-3 px-3 py-3 outline-none hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-4">
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-semibold">{label}</span>
            <RequiredBadge required={account.kycRequired} />
            <DecisionBadge decision={account.adminDecision} />
            <ProviderBadge status={account.status} />
            {account.reviewAnswer && (
              <Badge variant="outline" className="h-5 text-[10px]">
                {account.reviewAnswer}
              </Badge>
            )}
          </span>
          <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">
            {account.userId}
          </span>
        </span>

        <span className="flex shrink-0 items-center gap-3 text-[11px] text-muted-foreground">
          <span className="hidden sm:inline">
            cycle {account.verificationCycle}
          </span>
          <span title={formatDateTime(account.updatedAt)}>
            {formatRelative(account.updatedAt)}
          </span>
          <span className="transition-transform group-open:rotate-180">⌄</span>
        </span>
      </summary>

      <div className="border-t border-border/60 px-3 py-4 sm:px-4">
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
          <InfoGroup title="Account and internal control">
            <InfoRow label="Email" value={account.email ?? "—"} />
            <InfoRow label="Country" value={account.countryCode ?? "—"} />
            <InfoRow
              label="Account created"
              value={formatDateTime(account.accountCreatedAt)}
            />
            <InfoRow
              label="Required at"
              value={
                account.kycRequiredAt
                  ? formatDateTime(account.kycRequiredAt)
                  : "—"
              }
            />
            <InfoRow
              label="Required by"
              value={
                account.kycRequiredByLabel ??
                account.kycRequiredBy ??
                "—"
              }
            />
            <InfoRow
              label="Reason"
              value={account.kycRequiredReason ?? "—"}
              wrap
            />
            <InfoRow
              label="Reviewed at"
              value={
                account.adminReviewedAt
                  ? formatDateTime(account.adminReviewedAt)
                  : "—"
              }
            />
            <InfoRow
              label="Reviewed by"
              value={
                account.adminReviewedByLabel ??
                account.adminReviewedBy ??
                "—"
              }
            />
          </InfoGroup>

          <InfoGroup title="Sumsub provider evidence">
            <InfoRow label="Applicant ID" value={account.applicantId ?? "—"} mono />
            <InfoRow
              label="Level"
              value={account.levelName ?? "Backend default"}
            />
            <InfoRow label="Provider status" value={account.status} />
            <InfoRow
              label="Review answer"
              value={account.reviewAnswer ?? "—"}
            />
            <InfoRow label="Reject type" value={account.rejectType ?? "—"} />
            <InfoRow
              label="Moderation comment"
              value={account.moderationComment ?? "—"}
              wrap
            />
            <InfoRow
              label="Last provider event"
              value={
                account.lastWebhookCreatedAt
                  ? formatDateTime(account.lastWebhookCreatedAt)
                  : "—"
              }
            />
            <InfoRow
              label="Event digest"
              value={
                account.lastWebhookDigest
                  ? shortId(account.lastWebhookDigest)
                  : "—"
              }
              mono
            />
          </InfoGroup>

          <div className="flex min-w-40 flex-col items-start gap-2 xl:items-end">
            <HostLink
              href={`/users/${account.userId}?tab=kyc`}
              className="text-xs font-medium text-cyan-600 hover:underline dark:text-cyan-400"
            >
              Open full player profile
            </HostLink>
            {canManage && (
              <>
                <RequireKycDialog
                  account={account.userId}
                  accountLabel={label}
                  compact
                />
                {awaitingReview && (
                  <ReviewKycControls
                    userId={account.userId}
                    label={label}
                    verificationCycle={account.verificationCycle}
                  />
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </details>
  );
}

function InfoGroup({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
      <dl className="space-y-1.5">{children}</dl>
    </div>
  );
}

function InfoRow({
  label,
  value,
  mono = false,
  wrap = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  wrap?: boolean;
}) {
  return (
    <div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-2 text-xs">
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "font-medium",
          mono && "font-mono text-[11px]",
          wrap ? "whitespace-pre-wrap break-words" : "truncate",
        )}
        title={wrap ? undefined : value}
      >
        {value}
      </dd>
    </div>
  );
}

function RequiredBadge({ required }: { required: boolean }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-5 text-[10px]",
        required
          ? "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400"
          : "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
      )}
    >
      {required ? "KYC required" : "Not required"}
    </Badge>
  );
}

function DecisionBadge({
  decision,
}: {
  decision: KycAccount["adminDecision"];
}) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-5 text-[10px]",
        decision === "safe" &&
          "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
        decision === "pending" &&
          "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
        decision === "rejected" &&
          "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400",
      )}
    >
      admin: {decision}
    </Badge>
  );
}

function ProviderBadge({ status }: { status: KycAccount["status"] }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-5 text-[10px]",
        status === "approved" &&
          "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
        (status === "pending" || status === "on_hold") &&
          "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
        status === "rejected" &&
          "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400",
        status === "none" && "text-muted-foreground",
      )}
    >
      provider: {status}
    </Badge>
  );
}

function WebhookEvents({ dashboard }: { dashboard: KycDashboard }) {
  return (
    <section className="space-y-3">
      <SectionHeading
        icon={Webhook}
        title={
          <>
            Sumsub webhook evidence
            <span className="text-xs font-normal text-muted-foreground">
              ({dashboard.stats.processedWebhookEvents}/
              {dashboard.stats.webhookEvents} processed)
            </span>
          </>
        }
      />

      {dashboard.events.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/70 bg-card/40 px-4 py-10 text-center">
          <Webhook className="mx-auto size-5 text-muted-foreground" />
          <p className="mt-2 text-sm font-semibold">
            No Sumsub webhook events recorded
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            The storage is ready, but this environment has no provider evidence
            yet.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border/70 bg-card">
          <table className="w-full min-w-[760px] text-left text-xs">
            <thead className="border-b border-border/60 bg-muted/30 text-[10px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Event</th>
                <th className="px-3 py-2 font-medium">Applicant</th>
                <th className="px-3 py-2 font-medium">External user</th>
                <th className="px-3 py-2 font-medium">Provider time</th>
                <th className="px-3 py-2 font-medium">Received</th>
                <th className="px-3 py-2 font-medium">Processed</th>
                <th className="px-3 py-2 font-medium">Digest</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {dashboard.events.map((event) => (
                <tr key={event.digest}>
                  <td className="px-3 py-2 font-medium">{event.eventType}</td>
                  <td className="px-3 py-2 font-mono text-[11px]">
                    {event.applicantId ?? "—"}
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px]">
                    {event.externalUserId ?? "—"}
                  </td>
                  <td className="px-3 py-2">
                    {formatDateTime(event.providerCreatedAt)}
                  </td>
                  <td className="px-3 py-2">
                    {formatDateTime(event.receivedAt)}
                  </td>
                  <td className="px-3 py-2">
                    {event.processedAt ? (
                      <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                        <ShieldCheck className="size-3" />
                        {formatDateTime(event.processedAt)}
                      </span>
                    ) : (
                      <span className="text-amber-600 dark:text-amber-400">
                        Pending
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px]">
                    {shortId(event.digest)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[11px] text-muted-foreground">
        Raw webhook payloads can contain identity documents and provider PII.
        They remain in the protected database and are intentionally not
        rendered in the dashboard.
      </p>
    </section>
  );
}

function shortId(value: string): string {
  return value.length > 18
    ? `${value.slice(0, 9)}…${value.slice(-7)}`
    : value;
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-24 rounded-lg" />
        ))}
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <Skeleton className="h-64 rounded-lg" />
        <Skeleton className="h-64 rounded-lg" />
      </div>
      <Skeleton className="h-80 rounded-lg" />
    </div>
  );
}
