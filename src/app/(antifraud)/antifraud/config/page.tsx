import { Suspense } from "react";
import { Settings2 } from "lucide-react";

import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { Skeleton } from "@/components/ui/skeleton";
import { getFiatDepositAutomaticCreditConfig } from "@/lib/backend-api/fiat-deposit-review";
import { requireAntifraudManagerPage } from "@/lib/require-antifraud-access";
import { GlobalFiatReviewCard } from "./fiat-auto-approval-card";

export const metadata = { title: "Config · Antifraud" };

export default async function AntifraudConfigPage() {
  await requireAntifraudManagerPage();

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity />
      </PageHero>

      <section className="space-y-3">
        <SectionHeading icon={Settings2} title="Global Fiat review" />
        <Suspense fallback={<Skeleton className="h-52 w-full rounded-xl" />}>
          <GlobalFiatReviewData />
        </Suspense>
      </section>
    </div>
  );
}

async function GlobalFiatReviewData() {
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
