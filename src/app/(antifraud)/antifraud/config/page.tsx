import { Suspense } from "react";
import { BadgeDollarSign, Power, Users } from "lucide-react";

import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { Skeleton } from "@/components/ui/skeleton";
import { getFiatDepositAutomaticCreditConfig } from "@/lib/backend-api/fiat-deposit-review";
import {
  REWARD_QUERY_TIMEOUT_MS,
  safeQuery,
  safeQueryOrNull,
} from "@/lib/errors/safe-query";
import { hasAnyWhopFiatDepositLock } from "@/lib/fiat-jurisdiction-policy";
import { getFiatConfig } from "@/lib/queries/fiat";
import { requireAntifraudManagerPage } from "@/lib/require-antifraud-access";
import { getFiatAccessControlStatus } from "@/lib/antifraud/monitor-api";
import { GlobalFiatReviewCard } from "./fiat-auto-approval-card";
import { GlobalFiatAvailabilityCard } from "./fiat-availability-card";
import { FiatDepositAccessControlCard } from "./fiat-deposit-access-control-card";

export const metadata = { title: "Config · Antifraud" };

const BACKEND_CONFIG_TIMEOUT_MS = 5_000;

export default async function AntifraudConfigPage() {
  await requireAntifraudManagerPage();

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity />
      </PageHero>

      <section className="space-y-3">
        <SectionHeading icon={Power} title="Fiat availability" />
        <Suspense fallback={<Skeleton className="h-56 w-full rounded-xl" />}>
          <GlobalFiatAvailabilityData />
        </Suspense>
      </section>

      <section className="space-y-3">
        <SectionHeading icon={BadgeDollarSign} title="Fiat credit" />
        <Suspense fallback={<Skeleton className="h-52 w-full rounded-xl" />}>
          <GlobalFiatCreditData />
        </Suspense>
      </section>

      <section className="space-y-3">
        <SectionHeading icon={Users} title="Per-account Fiat access" />
        <Suspense fallback={<Skeleton className="h-72 w-full rounded-xl" />}>
          <FiatDepositAccessControlData />
        </Suspense>
      </section>
    </div>
  );
}

async function FiatDepositAccessControlData() {
  const result = await getFiatAccessControlStatus();
  return <FiatDepositAccessControlCard initialStatus={result.data} />;
}

async function GlobalFiatAvailabilityData() {
  const result = await safeQuery(
    getFiatConfig,
    [],
    "antifraud.config.fiat-availability",
    REWARD_QUERY_TIMEOUT_MS,
  );
  const row = result.data.find(({ key }) => key === "locked_deposits_fiat");
  if (result.error || !row) {
    return <GlobalFiatAvailabilityCard initialAllowed={null} />;
  }

  try {
    const parsed: unknown = JSON.parse(row.value);
    if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
      return <GlobalFiatAvailabilityCard initialAllowed={null} />;
    }
    return (
      <GlobalFiatAvailabilityCard
        initialAllowed={!hasAnyWhopFiatDepositLock(parsed)}
      />
    );
  } catch {
    return <GlobalFiatAvailabilityCard initialAllowed={null} />;
  }
}

async function GlobalFiatCreditData() {
  const result = await safeQueryOrNull(
    getFiatDepositAutomaticCreditConfig,
    "antifraud.config.fiat-credit",
    BACKEND_CONFIG_TIMEOUT_MS,
  );
  return (
    <GlobalFiatReviewCard
      initialEnabled={
        result.data?.fiat_deposit_automatic_credit_enabled ?? null
      }
    />
  );
}
