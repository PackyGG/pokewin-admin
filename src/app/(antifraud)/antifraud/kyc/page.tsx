import { Suspense } from "react";
import {
  BadgeCheck,
  CheckCircle2,
  Clock3,
  Fingerprint,
  LockKeyhole,
  ShieldX,
  UserCheck,
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
  type KycFilter,
} from "@/lib/antifraud/kyc";
import { safeQueryOrNull } from "@/lib/errors/safe-query";
import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";
import { cn } from "@/lib/utils";
import { formatDateTime, formatRelative } from "@/lib/utils/format";
import { RequireKycDialog } from "./_components/require-kyc-dialog";
import { ReviewKycControls } from "./_components/review-kyc-controls";

export const metadata = { title: "KYC Review · Antifraud" };

const QUERY_TIMEOUT_MS = 10_000;

const FILTER_LABELS: Record<KycFilter, string> = {
  all: "History",
  required: "Withdrawals locked",
  awaiting_review: "Decision open",
  provider_pending: "Waiting on Sumsub",
  approved: "Sumsub approved",
  rejected: "Rejected / failed",
  cleared: "Cleared by admin",
};

const FILTER_TITLES: Record<KycFilter, string> = {
  all: "KYC record history",
  required: "Accounts currently requiring KYC",
  awaiting_review: "Open KYC decisions",
  provider_pending: "Accounts waiting on Sumsub",
  approved: "Accounts approved by Sumsub",
  rejected: "Rejected KYC records",
  cleared: "Cleared KYC history",
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
  const status = isKycFilter(params.status) ? params.status : "required";
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
            <h1 className="text-xl font-semibold tracking-tight">KYC review</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              See who is waiting, what Sumsub found, and whether withdrawals
              can be unlocked
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
          aria-label="Search verification records"
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
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <KpiTile
          label="Open decisions"
          value={String(stats.awaitingReview)}
          sub="admin has not closed the cycle"
          icon={LockKeyhole}
          accent="rose"
        />
        <KpiTile
          label="Waiting on Sumsub"
          value={String(stats.providerPending)}
          sub="provider check is not final"
          icon={Clock3}
          accent="amber"
        />
        <KpiTile
          label="Sumsub approved"
          value={String(stats.approved)}
          sub="provider result, not admin clearance"
          icon={BadgeCheck}
          accent="emerald"
        />
        <KpiTile
          label="Cleared by admin"
          value={String(stats.cleared)}
          sub="completed historical cycles"
          icon={UserCheck}
          accent="cyan"
        />
      </div>

      <p className="text-xs text-muted-foreground">
        {stats.required} currently locked · {stats.total} historical verification
        records ·{" "}
        {stats.rejected} rejected · {stats.withApplicant} linked to a Sumsub
        applicant
      </p>

      <AccountList
        accounts={result.data.accounts}
        canManage={canManage}
        filter={status}
      />
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
            {FILTER_TITLES[filter]}
            <span className="text-xs font-normal text-muted-foreground">
              ({accounts.length} shown · {FILTER_LABELS[filter]})
            </span>
          </>
        }
      />

      {accounts.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/70 bg-card/40 px-4 py-12 text-center">
          <CheckCircle2 className="mx-auto size-5 text-muted-foreground" />
          <p className="mt-2 text-sm font-semibold">
            {filter === "required"
              ? "No accounts currently require KYC"
              : "No accounts match this view"}
          </p>
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
  const presentation = getAccountPresentation(account);

  return (
    <details className="group overflow-hidden rounded-lg border border-border/70 bg-card">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-3 px-3 py-3 outline-none hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-4">
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-semibold">{label}</span>
            <KycStateBadge presentation={presentation} />
          </span>
          <span className="mt-1 block text-xs text-muted-foreground">
            {presentation.summary}
          </span>
          <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">
            {account.userId}
          </span>
        </span>

        <span className="flex shrink-0 items-center gap-3 text-[11px] text-muted-foreground">
          <span className="hidden max-w-52 text-right lg:inline">
            Next: {presentation.nextStep}
          </span>
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
        <div
          className={cn(
            "mb-4 rounded-md border px-3 py-2.5",
            presentation.panelClassName,
          )}
        >
          <p className="text-xs font-semibold">{presentation.label}</p>
          <p className="mt-0.5 text-xs">{presentation.summary}</p>
          <p className="mt-1 text-[11px] opacity-80">
            <span className="font-semibold">Next:</span>{" "}
            {presentation.nextStep}
          </p>
        </div>
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
          <InfoGroup title="Why KYC was required">
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
              label="Admin decision"
              value={adminDecisionLabel(account.adminDecision)}
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

          <InfoGroup title="What Sumsub reported">
            <InfoRow label="Applicant ID" value={account.applicantId ?? "—"} mono />
            <InfoRow
              label="Level"
              value={account.levelName ?? "Backend default"}
            />
            <InfoRow
              label="Provider status"
              value={providerStatusLabel(account.status)}
            />
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

type AccountPresentation = {
  label: string;
  summary: string;
  nextStep: string;
  badgeClassName: string;
  panelClassName: string;
};

function getAccountPresentation(account: KycAccount): AccountPresentation {
  if (!account.kycRequired && account.adminDecision === "safe") {
    return {
      label: "Cleared by admin",
      summary: "This verification cycle is complete and withdrawals are unlocked.",
      nextStep: "No action needed unless a new KYC cycle is required.",
      badgeClassName:
        "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
      panelClassName:
        "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    };
  }

  if (account.adminDecision === "rejected") {
    return {
      label: "Rejected by admin",
      summary: "The current cycle was rejected and withdrawals remain locked.",
      nextStep: "Review the reason before requiring a new verification cycle.",
      badgeClassName:
        "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400",
      panelClassName:
        "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
    };
  }

  if (account.kycRequired && account.adminDecision === "pending") {
    if (account.status === "approved") {
      return {
        label: "Ready for admin decision",
        summary: "Sumsub approved the identity check, but withdrawals are still locked.",
        nextStep: "Review the evidence, then mark this cycle safe or reject it.",
        badgeClassName:
          "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
        panelClassName:
          "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
      };
    }
    if (account.status === "rejected") {
      return {
        label: "Sumsub rejected",
        summary: "The provider did not approve the identity check. Withdrawals are locked.",
        nextStep: "Review the rejection evidence and record the admin decision.",
        badgeClassName:
          "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400",
        panelClassName:
          "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
      };
    }
    if (account.status === "pending" || account.status === "on_hold") {
      return {
        label: account.status === "on_hold" ? "Sumsub on hold" : "Waiting on Sumsub",
        summary: "The provider check is not final and withdrawals remain locked.",
        nextStep: "Wait for a final provider result, or reject if other evidence requires it.",
        badgeClassName:
          "border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400",
        panelClassName:
          "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
      };
    }
    return {
      label: "Verification not started",
      summary: "KYC is required, but no Sumsub applicant or result exists yet.",
      nextStep: "The player must start the identity check. Withdrawals stay locked.",
      badgeClassName:
        "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
      panelClassName:
        "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    };
  }

  if (account.kycRequired) {
    return {
      label: "KYC required",
      summary: "A current verification cycle is active and withdrawals are locked.",
      nextStep: "Review the current cycle state before taking action.",
      badgeClassName:
        "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
      panelClassName:
        "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    };
  }

  return {
    label: "No KYC action",
    summary:
      "This account has a verification record but does not currently require verification.",
    nextStep: "No action needed.",
    badgeClassName: "text-muted-foreground",
    panelClassName: "border-border/70 bg-muted/30 text-foreground",
  };
}

function KycStateBadge({
  presentation,
}: {
  presentation: AccountPresentation;
}) {
  return (
    <Badge
      variant="outline"
      className={cn("h-5 text-[10px]", presentation.badgeClassName)}
    >
      {presentation.label}
    </Badge>
  );
}

function adminDecisionLabel(decision: KycAccount["adminDecision"]): string {
  if (decision === "safe") return "Safe — withdrawals unlocked";
  if (decision === "rejected") return "Rejected — withdrawals locked";
  return "Open — no admin decision yet";
}

function providerStatusLabel(status: KycAccount["status"]): string {
  if (status === "approved") return "Approved by Sumsub";
  if (status === "rejected") return "Rejected by Sumsub";
  if (status === "on_hold") return "On hold at Sumsub";
  if (status === "pending") return "Pending at Sumsub";
  return "No provider result";
}

function shortId(value: string): string {
  return value.length > 18
    ? `${value.slice(0, 9)}…${value.slice(-7)}`
    : value;
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-24 rounded-lg" />
        ))}
      </div>
      <Skeleton className="h-80 rounded-lg" />
      <Skeleton className="h-16 rounded-lg" />
    </div>
  );
}
