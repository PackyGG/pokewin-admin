import { Suspense } from "react";
import {
  BadgeCheck,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Fingerprint,
  LockKeyhole,
  ShieldX,
  TriangleAlert,
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
import { FilterButton, FilterGroup } from "../_components/list-page";
import { RequireKycDialog } from "./_components/require-kyc-dialog";
import { ReviewKycControls } from "./_components/review-kyc-controls";

export const metadata = { title: "KYC Review · Antifraud" };

const QUERY_TIMEOUT_MS = 10_000;

const FILTER_LABELS: Record<KycFilter, string> = {
  active: "Active / Waiting",
  history: "History / Finished",
};

const FILTER_TITLES: Record<KycFilter, string> = {
  active: "Active and waiting KYC reviews",
  history: "Finished KYC history",
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
  const status = isKycFilter(params.status) ? params.status : "active";
  const search = params.q?.trim() || undefined;
  const canManage = canManageAntifraud(session);
  const contentKey = `${status}-${search ?? ""}`;

  return (
    <div className="w-full min-w-0 space-y-6">
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
    <div className="space-y-3 rounded-xl border border-border/60 bg-card p-3 sm:p-4">
      <nav aria-label="KYC status filters">
        <FilterGroup label="View">
          {Object.entries(FILTER_LABELS).map(([value, label]) => (
            <FilterButton
              key={value}
              label={label}
              active={status === value}
              href={buildHref({ status: value, q: search }, current)}
            />
          ))}
        </FilterGroup>
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
      <div className="rounded-xl border border-dashed border-border/70 bg-card/40 px-4 py-14 text-center">
        <ShieldX className="mx-auto mb-3 size-6 text-muted-foreground" />
        <p className="text-sm font-semibold">KYC data could not be loaded</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Nothing was changed. Refresh to retry the read-only dashboard.
        </p>
      </div>
    );
  }

  const { stats } = result.data;
  const countryMismatches = result.data.accounts.filter(
    (account) => account.countryReview?.countryMatch === "mismatch",
  ).length;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
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

      <p className="text-xs tabular-nums text-muted-foreground">
        {stats.required} currently locked · {stats.total} historical verification
        records ·{" "}
        {stats.rejected} rejected · {stats.withApplicant} linked to a Sumsub
        applicant ·{" "}
        <span
          className={cn(
            countryMismatches > 0 &&
              "font-semibold text-rose-600 dark:text-rose-400",
          )}
        >
          {countryMismatches} saved country mismatch
          {countryMismatches === 1 ? "" : "es"} in this view
        </span>
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
        <div className="rounded-xl border border-dashed border-border/70 bg-card/40 px-4 py-14 text-center">
          <CheckCircle2 className="mx-auto mb-3 size-6 text-muted-foreground" />
          <p className="text-sm font-semibold">
            {filter === "active"
              ? "No KYC checks are currently active or waiting"
              : "No finished KYC records match this view"}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Change the view or search, or require KYC for an eligible locked
            account.
          </p>
        </div>
      ) : (
        <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60 bg-card">
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
    <details className="group">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-3 px-3 py-2.5 outline-none hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-4">
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-semibold">{label}</span>
            <KycStateBadge presentation={presentation} />
            {account.countryReview?.countryMatch === "mismatch" && (
              <Badge
                variant="outline"
                className="h-5 border-rose-500/40 bg-rose-500/10 text-[10px] text-rose-600 dark:text-rose-400"
              >
                <TriangleAlert className="mr-1 size-3" />
                Country mismatch
              </Badge>
            )}
          </span>
          <span className="mt-1 block text-xs text-muted-foreground">
            {presentation.summary}
          </span>
          <AccountRowEvidence account={account} />
          <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
            <span>
              Country:{" "}
              <span className="font-medium text-foreground">
                {account.countryCode?.toUpperCase() ?? "Unknown"}
              </span>
            </span>
            <span className="truncate font-mono">{account.userId}</span>
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
          <ChevronDown
            aria-hidden
            className="size-4 shrink-0 transition-transform group-open:rotate-180 motion-reduce:transition-none"
          />
        </span>
      </summary>

      <div className="border-t border-border/60 px-3 py-4 sm:px-4">
        <div
          className={cn(
            "mb-4 rounded-lg border px-3 py-2.5",
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
            <InfoRow
              label="Verified country"
              value={account.countryReview?.verifiedCountry ?? "—"}
            />
            <InfoRow
              label="Document countries"
              value={
                account.countryReview?.documentCountries.join(", ") || "—"
              }
            />
            <InfoRow
              label="Country check"
              value={countryReviewLabel(account)}
            />
            <InfoRow
              label="Country evidence saved"
              value={
                account.countryReview
                  ? formatDateTime(new Date(account.countryReview.checkedAt))
                  : "—"
              }
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

function AccountRowEvidence({ account }: { account: KycAccount }) {
  const evidence: Array<{ label: string; value: string }> = [];
  const providerReviewOpen =
    account.status === "pending" || account.status === "on_hold";
  const providerDeclined = account.status === "rejected";
  const readyForAdminReview =
    account.kycRequired &&
    account.adminDecision === "pending" &&
    account.status === "approved";

  if (providerReviewOpen) {
    evidence.push({
      label: "Provider",
      value: providerStatusLabel(account.status),
    });
    if (account.lastWebhookCreatedAt) {
      evidence.push({
        label: "Last event",
        value: formatRelative(account.lastWebhookCreatedAt),
      });
    }
  }

  if (providerDeclined) {
    evidence.push({
      label: "Answer",
      value: account.reviewAnswer ?? "Declined",
    });
    if (account.rejectType) {
      evidence.push({ label: "Decline type", value: account.rejectType });
    }
  }

  if (readyForAdminReview) {
    evidence.push({
      label: "Provider",
      value: account.reviewAnswer ?? "Approved",
    });
    if (account.lastWebhookCreatedAt) {
      evidence.push({
        label: "Approved",
        value: formatRelative(account.lastWebhookCreatedAt),
      });
    }
  }

  if (account.adminDecision === "rejected") {
    evidence.push({
      label: "Admin review",
      value:
        account.adminReviewedByLabel ??
        account.adminReviewedBy ??
        "Rejected",
    });
    if (account.adminReviewedAt) {
      evidence.push({
        label: "Reviewed",
        value: formatRelative(account.adminReviewedAt),
      });
    }
  }

  if (
    evidence.length === 0 &&
    !(providerDeclined && account.moderationComment)
  ) {
    return null;
  }

  return (
    <span className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
      {evidence.map((item) => (
        <span
          key={`${item.label}-${item.value}`}
          className="inline-flex min-w-0 items-baseline gap-1"
        >
          <span className="text-muted-foreground">{item.label}:</span>
          <span className="max-w-56 truncate font-medium text-foreground">
            {item.value}
          </span>
        </span>
      ))}
      {providerDeclined && account.moderationComment && (
        <span
          className="basis-full truncate text-rose-600 dark:text-rose-400"
          title={account.moderationComment}
        >
          <span className="font-semibold">Provider note:</span>{" "}
          {account.moderationComment}
        </span>
      )}
    </span>
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
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
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
  if (account.countryReview?.countryMatch === "mismatch") {
    return {
      label: "Country mismatch",
      summary: `The account country ${account.countryReview.accountCountry ?? "is unknown"}, but the completed KYC evidence is from ${account.countryReview.verifiedCountry ?? "another country"}.`,
      nextStep: "Review the saved country evidence before treating this cycle as safe.",
      badgeClassName:
        "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400",
      panelClassName:
        "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
    };
  }

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

function countryReviewLabel(account: KycAccount): string {
  const review = account.countryReview;
  if (!review || review.countryMatch === "unknown") {
    return "Not enough country evidence";
  }
  if (review.countryMatch === "match") {
    return `Match — account and KYC are ${review.accountCountry}`;
  }
  return `Mismatch — account ${review.accountCountry ?? "unknown"}, KYC ${review.verifiedCountry ?? "unknown"}`;
}

function shortId(value: string): string {
  return value.length > 18
    ? `${value.slice(0, 9)}…${value.slice(-7)}`
    : value;
}

function DashboardSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-24 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-80 rounded-xl" />
      <Skeleton className="h-16 rounded-xl" />
    </div>
  );
}
