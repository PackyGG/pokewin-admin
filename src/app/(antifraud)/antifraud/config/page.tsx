import { Suspense } from "react";
import { BadgeDollarSign, Power } from "lucide-react";

import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { Skeleton } from "@/components/ui/skeleton";
import { getFiatDepositAutomaticCreditConfig } from "@/lib/backend-api/fiat-deposit-review";
import { REWARD_QUERY_TIMEOUT_MS, safeQuery } from "@/lib/errors/safe-query";
import { hasAnyWhopFiatDepositLock } from "@/lib/fiat-jurisdiction-policy";
import { getFiatConfig } from "@/lib/queries/fiat";
import { requireAntifraudManagerPage } from "@/lib/require-antifraud-access";
import { GlobalFiatReviewCard } from "./fiat-auto-approval-card";
import { GlobalFiatAvailabilityCard } from "./fiat-availability-card";

export const metadata = { title: "Config · Antifraud" };

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
    </div>
  );
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
  try {
    const config = await getFiatDepositAutomaticCreditConfig();
    return (
      <GlobalFiatReviewCard
        initialEnabled={config.fiat_deposit_automatic_credit_enabled}
      />
    );
  } catch (error) {
    console.error("[antifraud-config] Fiat approval config read failed:", error);
    return <GlobalFiatReviewCard initialEnabled={null} />;
  }
}
