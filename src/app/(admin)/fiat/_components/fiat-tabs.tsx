import Link from "next/link";
import {
  AlertTriangle,
  CreditCard,
  DollarSign,
  Globe2,
  LockKeyhole,
  ShieldAlert,
  ShieldCheck,
  Users,
  Webhook,
} from "lucide-react";

import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { KpiTile, SectionHeading } from "@/components/modern-panels";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import { getCardPayments } from "@/lib/queries/card-payments";
import { getCountryRestrictions } from "@/lib/queries/geo-blocking";
import {
  EMPTY_FIAT_ACCESS,
  EMPTY_FIAT_OVERVIEW,
  EMPTY_FIAT_WEBHOOKS,
  getFiatAccess,
  getFiatConfig,
  getFiatOverview,
  getFiatWebhooks,
} from "@/lib/queries/fiat";
import {
  formatCurrency,
  formatDateTime,
  formatNumber,
} from "@/lib/utils/format";
import { CardPaymentsTable } from "../../transactions/deposits/card-payments-table";
import { FiatConfigCard } from "./fiat-config-card";

function QueryNotice() {
  return (
    <div className="flex gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-700 dark:text-amber-300">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      This environment&apos;s fiat data could not be loaded. Refresh to retry.
    </div>
  );
}

function valueOrMissing(value: number | null, suffix = "") {
  return value === null ? "Not configured" : `${formatNumber(value)}${suffix}`;
}

export async function FiatOverviewTab() {
  const result = await safeQuery(
    getFiatOverview,
    EMPTY_FIAT_OVERVIEW,
    "fiat.overview",
    REWARD_QUERY_TIMEOUT_MS,
  );
  const data = result.data;

  return (
    <div className="space-y-6">
      {result.error && <QueryNotice />}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile
          label="Gross customer credit"
          value={formatCurrency(data.grossCreditedUsd)}
          sub="Completed ledger credits"
          icon={DollarSign}
          accent="emerald"
        />
        <KpiTile
          label="Completed payments"
          value={formatNumber(data.completed)}
          icon={CreditCard}
          accent="blue"
        />
        <KpiTile
          label="Customers"
          value={formatNumber(data.customers)}
          icon={Users}
          accent="purple"
        />
        <KpiTile
          label="Last 24h credit"
          value={formatCurrency(data.last24HoursCompletedUsd)}
          sub={`${formatNumber(data.last24HoursIntents)} intents`}
          icon={DollarSign}
          accent="orange"
        />
      </div>

      <section className="space-y-3">
        <SectionHeading icon={DollarSign} title="Recorded money flow" />
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Provider reconciliation</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Control
                label="Customer paid"
                value={formatCurrency(data.customerPaidUsd)}
              />
              <Control
                label="Gross balance credited"
                value={formatCurrency(data.grossCreditedUsd)}
              />
              <Control
                label="Refunded or disputed credit"
                value={`−${formatCurrency(data.reversedCreditUsd)}`}
              />
              <Control
                label="Net retained credit"
                value={formatCurrency(data.netRetainedCreditUsd)}
              />
              <Control
                label="Provider net"
                value={formatCurrency(data.providerNetUsd)}
              />
              <Control
                label="Recorded provider fees"
                value={formatCurrency(data.providerFeesUsd)}
              />
              <Control
                label="Provider net minus retained credit"
                value={formatCurrency(
                  data.providerNetUsd - data.netRetainedCreditUsd,
                )}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Pipeline freshness</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Control
                label="Intents in last 24h"
                value={formatNumber(data.last24HoursIntents)}
              />
              <Control
                label="Latest intent"
                value={
                  data.latestIntentAt
                    ? formatDateTime(data.latestIntentAt)
                    : "No events"
                }
              />
              <Control
                label="Webhook events"
                value={formatNumber(data.webhooks)}
              />
              <Control
                label="Failed webhooks"
                value={formatNumber(data.failedWebhooks)}
              />
              <Control
                label="Latest webhook"
                value={
                  data.latestWebhookAt
                    ? formatDateTime(data.latestWebhookAt)
                    : "No events"
                }
              />
            </CardContent>
          </Card>
        </div>
        <p className="text-xs text-muted-foreground">
          These are independently recorded ledger and provider fields. A
          difference is an investigation signal, not automatically revenue or
          loss.
        </p>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Active controls</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Control
              label="Maximum card deposit"
              value={valueOrMissing(data.cardDepositMaxUsd, " USD")}
            />
            <Control
              label="Automatic withdrawal hold"
              value={valueOrMissing(
                data.withdrawalHoldThresholdUsd,
                " USD lifetime",
              )}
            />
            <Control
              label="Site-locked fiat methods"
              value={
                data.lockedMethods.length
                  ? data.lockedMethods.join(", ")
                  : "None"
              }
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Lifecycle health</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3 text-sm">
            <Control label="All intents" value={formatNumber(data.intents)} />
            <Control
              label="Checkout ready"
              value={formatNumber(data.checkoutReady)}
            />
            <Control label="Review" value={formatNumber(data.review)} />
            <Control label="Failed" value={formatNumber(data.failed)} />
            <Control label="Refunded" value={formatNumber(data.refunded)} />
            <Control label="Disputed" value={formatNumber(data.disputed)} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">What triggers a lock</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>
            The configured lifetime completed-deposit threshold triggers a
            withdrawal-only account hold. A missing value means that automatic
            threshold is not configured in the selected environment.
          </p>
          <p>
            Refunds and disputes can trigger fraud locks that block both
            deposits and withdrawals. User, location, KYC, and site-wide method
            restrictions are summarized under Access &amp; holds.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function Control({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border p-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}

export async function FiatConfigurationTab({ canEdit }: { canEdit: boolean }) {
  const [configResult, restrictionsResult] = await Promise.all([
    safeQuery(
      getFiatConfig,
      [],
      "fiat.configuration",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      getCountryRestrictions,
      [],
      "fiat.configuration-jurisdictions",
      REWARD_QUERY_TIMEOUT_MS,
    ),
  ]);
  return (
    <div className="space-y-4">
      {(configResult.error || restrictionsResult.error) && <QueryNotice />}
      <FiatConfigCard
        rows={configResult.data}
        restrictions={restrictionsResult.data}
        canEdit={canEdit}
      />
    </div>
  );
}

export async function FiatPaymentsTab({
  page,
  perPage,
  search,
  status,
}: {
  page: number;
  perPage: number;
  search?: string;
  status?: string;
}) {
  const empty = {
    data: [],
    total: 0,
    page,
    perPage,
    totalPages: 0,
  } satisfies Awaited<ReturnType<typeof getCardPayments>>;
  const result = await safeQuery(
    () => getCardPayments({ page, perPage, search, status }),
    empty,
    "fiat.payments",
    REWARD_QUERY_TIMEOUT_MS,
  );
  return (
    <div className="space-y-4">
      <DataTableToolbar
        searchPlaceholder="Search user, intent, checkout, or payment ID..."
        filters={[
          {
            name: "Status",
            paramKey: "status",
            options: [
              "created",
              "checkout_creating",
              "checkout_ready",
              "pending",
              "completed",
              "review",
              "failed",
              "canceled",
              "partially_refunded",
              "refunded",
              "disputed",
            ].map((value) => ({ label: value.replaceAll("_", " "), value })),
          },
        ]}
      />
      <SectionHeading icon={CreditCard} title="Whop card payments" />
      {result.error && <QueryNotice />}
      <CardPaymentsTable data={result.data.data} />
      <DataTablePagination
        page={result.data.page}
        totalPages={result.data.totalPages}
        total={result.data.total}
        perPage={result.data.perPage}
        degraded={result.error !== null}
      />
    </div>
  );
}

export async function FiatAccessTab() {
  const result = await safeQuery(
    getFiatAccess,
    EMPTY_FIAT_ACCESS,
    "fiat.access",
    REWARD_QUERY_TIMEOUT_MS,
  );
  const data = result.data;
  return (
    <div className="space-y-6">
      {result.error && <QueryNotice />}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile
          label="Fiat-locked users"
          value={formatNumber(data.fiatLockedUsers)}
          icon={LockKeyhole}
          accent="rose"
        />
        <KpiTile
          label="Fiat-locked locations"
          value={formatNumber(data.fiatLockedLocations)}
          icon={Globe2}
          accent="orange"
        />
        <KpiTile
          label="KYC required"
          value={formatNumber(data.kycRequiredUsers)}
          icon={ShieldCheck}
          accent="blue"
        />
        <KpiTile
          label="Withdrawal locks"
          value={formatNumber(data.withdrawalLockedUsers)}
          icon={ShieldAlert}
          accent="purple"
        />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">KYC status</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Control
              label="Pending"
              value={formatNumber(data.kycPendingUsers)}
            />
            <Control
              label="Approved"
              value={formatNumber(data.kycApprovedUsers)}
            />
            <Control
              label="Rejected"
              value={formatNumber(data.kycRejectedUsers)}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">
              Location and site controls
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Control
              label="Restriction rows"
              value={formatNumber(data.restrictionRows)}
            />
            <Control
              label="Fully blocked locations"
              value={formatNumber(data.blockedLocations)}
            />
            <Control
              label="Locked methods"
              value={data.siteLockedMethods.join(", ") || "None"}
            />
            <Link
              href="/system/geo-blocking"
              className="inline-flex text-xs font-medium text-primary hover:underline"
            >
              Open geo-blocking controls
            </Link>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export async function FiatWebhooksTab() {
  const result = await safeQuery(
    getFiatWebhooks,
    EMPTY_FIAT_WEBHOOKS,
    "fiat.webhooks",
    REWARD_QUERY_TIMEOUT_MS,
  );
  return (
    <div className="space-y-6">
      {result.error && <QueryNotice />}
      <SectionHeading icon={Webhook} title="Webhook processing" />
      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th className="p-3">Event</th>
              <th className="p-3">Status</th>
              <th className="p-3">Events</th>
              <th className="p-3">Errors</th>
              <th className="p-3">Latest</th>
            </tr>
          </thead>
          <tbody>
            {result.data.summary.map((row) => (
              <tr
                key={`${row.eventType}-${row.processingStatus}`}
                className="border-t"
              >
                <td className="p-3 font-medium">{row.eventType}</td>
                <td className="p-3">
                  <Badge variant="outline">{row.processingStatus}</Badge>
                </td>
                <td className="p-3 tabular-nums">{formatNumber(row.events)}</td>
                <td className="p-3 tabular-nums">
                  {formatNumber(row.withError)}
                </td>
                <td className="p-3 text-muted-foreground">
                  {row.latestAt ? formatDateTime(row.latestAt) : "—"}
                </td>
              </tr>
            ))}
            {result.data.summary.length === 0 && (
              <tr>
                <td
                  colSpan={5}
                  className="p-8 text-center text-muted-foreground"
                >
                  No webhook events in this environment.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Recent failures</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {result.data.recentFailures.map((failure, index) => (
            <div
              key={`${failure.eventType}-${failure.receivedAt}-${index}`}
              className="rounded-lg border p-3 text-xs"
            >
              <div className="flex justify-between gap-3">
                <strong>{failure.eventType}</strong>
                <span>{formatDateTime(failure.receivedAt)}</span>
              </div>
              <p className="mt-2 break-words text-muted-foreground">
                {failure.error}
              </p>
              <p className="mt-1 text-muted-foreground">
                Attempts: {failure.attempts}
              </p>
            </div>
          ))}
          {result.data.recentFailures.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No recent failed webhooks.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
