import { Suspense } from "react";
import { notFound } from "next/navigation";
import Link from "next/link";
import {
  Ticket,
  DollarSign,
  Users,
  Calendar,
  ShieldCheck,
  Activity,
} from "lucide-react";
import {
  getPromoCodeDetail,
  getPromoCodeRedemptionRows,
} from "@/lib/queries/promo-codes";
import { requirePageAccess } from "@/lib/dal";
import { isUuid } from "@/lib/utils/ids";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCurrency, formatDate, formatDateTime } from "@/lib/utils/format";
import { DeletePromoCodeButton } from "./delete-button";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
  KpiTile,
  StatPanel,
  PanelRow,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import {
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";
import { InlineError } from "@/components/entity-surface/inline-error";
import { safeQueryOrNull } from "@/lib/errors/safe-query";

export const metadata = { title: "Promo Code Detail" };

/**
 * Both reads on this route are indexed single-code lookups, so the bound only
 * guards a hung connection / mirror pool starvation — the failure mode that
 * used to throw the WHOLE route into `error.tsx`.
 */
const DETAIL_TIMEOUT_MS = 10_000;

/**
 * Shell-first (CLAUDE.md §2): the hero + back/delete controls paint from the
 * route params alone, and every DB read lives in an async child behind its own
 * <Suspense>. Nothing is awaited in this body.
 *
 * `DeletePromoCodeButton` takes the route id rather than `data.id`: the detail
 * row is looked up by `id = $1::uuid`, so the two are the same code, and the
 * delete action compares as `uuid` (case/format-insensitive). Passing the route
 * id keeps the control off the read's critical path.
 */
export default async function PromoCodeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePageAccess("/promo-codes");
  const { id } = await params;
  // Shape-check UUID before any DB call — see src/lib/utils/ids.ts.
  if (!isUuid(id)) notFound();

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          backHref="/rewards?tab=promo-codes"
          action={<DeletePromoCodeButton promoCodeId={id} />}
        />
      </PageHero>

      <Suspense fallback={<PromoCodeDetailBodySkeleton />}>
        <PromoCodeDetailBody id={id} />
      </Suspense>
    </div>
  );
}

/**
 * The config + REAL redemption count. Wrapped in `safeQueryOrNull` so a slow /
 * failing lookup degrades to a retryable band instead of throwing this route
 * into `error.tsx` — and, critically, so a transient DB failure can no longer
 * masquerade as a 404. Only a clean `null` (the code genuinely does not exist)
 * is a Not Found.
 */
async function PromoCodeDetailBody({ id }: { id: string }) {
  const { data, error } = await safeQueryOrNull(
    () => getPromoCodeDetail(id),
    "promoCodes.detail",
    DETAIL_TIMEOUT_MS,
  );

  if (!data) {
    if (!error) notFound();
    return (
      <InlineError
        title="Promo code lookup is temporarily unavailable"
        hint="The database did not return this code within the critical-path budget. Retry the page — this is not a Not Found result."
      />
    );
  }

  const isExpired = data.expiresAt && new Date(data.expiresAt) < new Date();
  // Remaining / "n / max" derive from the REAL unbounded count, not a capped
  // row array — so they stay correct past the 100-row table cap.
  const redemptionsLeft = Math.max(0, data.maxUses - data.redemptionCount);

  return (
    <FadeIn className="space-y-6">
      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 md:grid-cols-4">
        {/* Promo codes give users credit → house pays out → rose per
            CLAUDE.md house-POV rule. */}
        <KpiTile
          label="Value"
          value={formatCurrency(data.value)}
          icon={DollarSign}
          accent="rose"
        />
        <KpiTile
          label="Redemptions"
          value={`${data.redemptionCount} / ${data.maxUses}`}
          icon={Users}
          accent="blue"
        />
        <KpiTile
          label="Remaining"
          value={String(redemptionsLeft)}
          icon={Activity}
          accent="purple"
        />
        <KpiTile
          label="Expires"
          value={data.expiresAt ? formatDate(data.expiresAt) : "Never"}
          icon={Calendar}
          accent={isExpired ? "rose" : "amber"}
        />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <StatPanel title="Details" icon={Ticket} accent="blue">
          <PanelRow label="Value" value={formatCurrency(data.value)} />
          <PanelRow label="Region" value={data.region} />
          <PanelRow label="Max Uses" value={String(data.maxUses)} />
          <PanelRow
            label="Redemptions"
            value={`${data.redemptionCount} / ${data.maxUses}`}
          />
          <PanelRow
            label="Expires"
            value={data.expiresAt ? formatDate(data.expiresAt) : "Never"}
          />
          <PanelRow label="Created" value={formatDate(data.createdAt)} />
        </StatPanel>

        <StatPanel title="Requirements" icon={ShieldCheck} accent="amber">
          <PanelRow
            label="Discord"
            value={
              <Badge
                variant="outline"
                className={
                  data.requiresDiscord
                    ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
                    : ""
                }
              >
                {data.requiresDiscord ? "Required" : "Not required"}
              </Badge>
            }
          />
          <PanelRow
            label="Min Level"
            value={data.minimumLevel ? String(data.minimumLevel) : "None"}
          />
          <PanelRow
            label="Min Wager"
            value={
              data.minimumWagerAmount > 0
                ? formatCurrency(data.minimumWagerAmount)
                : "None"
            }
          />
          <PanelRow
            label="Wager Period"
            value={
              data.wagerPeriodDays > 0
                ? `${data.wagerPeriodDays} days`
                : data.minimumWagerAmount > 0
                  ? "Lifetime"
                  : "—"
            }
          />
          <PanelRow
            label="Min Account Age"
            value={
              data.minimumAccountAgeDays > 0
                ? `${data.minimumAccountAgeDays} days`
                : "None"
            }
          />
          <PanelRow
            label="Max Account Age"
            value={
              data.maximumAccountAgeHours > 0
                ? `${data.maximumAccountAgeHours} hours (new signups only)`
                : "None"
            }
          />
          <PanelRow
            label="Min Deposit (all-time)"
            value={
              data.minimumDepositAmount > 0
                ? formatCurrency(data.minimumDepositAmount)
                : "None"
            }
          />
          <PanelRow
            label="Min Recent Deposit"
            value={
              data.minimumRecentDepositAmount > 0 &&
              data.recentDepositPeriodMinutes > 0
                ? `${formatCurrency(data.minimumRecentDepositAmount)} in last ${data.recentDepositPeriodMinutes} min`
                : "None"
            }
          />
          <PanelRow
            label="Required Affiliate Code"
            value={data.requiredAffiliateCode ?? "None"}
          />
        </StatPanel>
      </div>

      <div className="space-y-3">
        <SectionHeading
          icon={Activity}
          title={`Redemptions (${data.redemptionCount})`}
        />
        {/* Streamed behind its own Suspense so the shell + KPIs above paint
            first and the (potentially large) redemption row read never blocks
            first paint. */}
        <Suspense fallback={<TableSkeleton rows={8} columns={3} />}>
          <RedemptionsTable id={data.id} />
        </Suspense>
      </div>
    </FadeIn>
  );
}

async function RedemptionsTable({ id }: { id: string }) {
  // safeQueryOrNull, not a bare await: an unwrapped throw here escaped the
  // <Suspense> above (Suspense catches suspension, NOT errors) and took the
  // whole route to `error.tsx` — blanking the hero, KPI strip and both panels
  // that had already rendered. A failing/slow redemption read now degrades to
  // this one section.
  const { data: result, kind } = await safeQueryOrNull(
    () => getPromoCodeRedemptionRows(id),
    "promoCodes.redemptionRows",
    DETAIL_TIMEOUT_MS,
  );

  if (!result) {
    return (
      <InlineError
        compact
        title={
          kind === "timeout"
            ? "Redemptions took too long to load"
            : "Couldn't load redemptions"
        }
        hint="The counts above are unaffected. Retry to reload just this list."
      />
    );
  }

  const { rows, totalCount, truncated } = result;

  return (
    <FadeIn className="rounded-2xl border bg-card/60 overflow-x-auto">
      {truncated && (
        <p className="border-b px-4 py-2 text-xs text-muted-foreground">
          Showing the most recent {rows.length} of {totalCount} redemptions.
        </p>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>User</TableHead>
            <TableHead>IP Address</TableHead>
            <TableHead>Date</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id}>
              <TableCell>
                <Link href={`/users/${r.userId}`} className="hover:underline">
                  {r.username ?? r.email ?? r.userId}
                </Link>
              </TableCell>
              <TableCell className="font-mono text-xs">{r.ipAddress}</TableCell>
              <TableCell>{formatDateTime(r.redeemedAt)}</TableCell>
            </TableRow>
          ))}
          {rows.length === 0 && (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={3} className="p-0">
                <EmptyState
                  icon={Activity}
                  title="No redemptions yet"
                  description="Players who redeem this code will be listed here."
                  compact
                />
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </FadeIn>
  );
}

/**
 * Everything below the hero while the detail read resolves. Mirrors
 * `loading.tsx` minus the hero (which is already painted by the page body).
 */
function PromoCodeDetailBodySkeleton() {
  return (
    <div className="space-y-6">
      <KpiStripSkeleton count={4} />
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton className="h-72 rounded-2xl" />
        <Skeleton className="h-72 rounded-2xl" />
      </div>
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={140} />
        <TableSkeleton rows={8} columns={3} />
      </div>
    </div>
  );
}
