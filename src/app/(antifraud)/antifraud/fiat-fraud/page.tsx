
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";
import { FiatFraudContent } from "./fiat-fraud-content";

export const metadata = { title: "Fiat Fraud · Antifraud" };

const RISK_TYPES = [
  "blacklisted_domain",
  "gmail_dot_fragmentation",
  "suspicious_deposit_cluster",
] as const;
const SOURCES = ["whop_checkout", "signup"] as const;
const LOCK_STATUSES = ["locked", "pending"] as const;
const PAGE_SIZES = [10, 20, 50, 100] as const;

export default async function FiatFraudPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAntifraudPageAccess();
  const raw = await searchParams;
  const value = (key: string) =>
    typeof raw[key] === "string" ? raw[key] : undefined;
  const rawPage = Number(value("page") ?? "1");
  const rawPerPage = Number(value("perPage") ?? "20");
  const page =
    Number.isInteger(rawPage) && rawPage >= 1 && rawPage <= 10_000
      ? rawPage
      : 1;
  const perPage = PAGE_SIZES.includes(
    rawPerPage as (typeof PAGE_SIZES)[number],
  )
    ? rawPerPage
    : 20;
  const riskType = RISK_TYPES.includes(
    value("riskType") as (typeof RISK_TYPES)[number],
  )
    ? value("riskType")
    : undefined;
  const source = SOURCES.includes(value("source") as (typeof SOURCES)[number])
    ? value("source")
    : undefined;
  const lockStatus = LOCK_STATUSES.includes(
    value("lockStatus") as (typeof LOCK_STATUSES)[number],
  )
    ? value("lockStatus")
    : undefined;
  const search = value("search")?.trim().slice(0, 100) || undefined;

  return (
    <div className="space-y-4">
      <PageHero>
        <PageHeroIdentity />
      </PageHero>
      <FiatFraudContent
        page={page}
        perPage={perPage}
        params={{ search, riskType, source, lockStatus }}
      />
    </div>
  );
}
