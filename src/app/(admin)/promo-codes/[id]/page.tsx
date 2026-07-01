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
import { getPromoCodeDetail } from "@/lib/queries/promo-codes";
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

export const metadata = { title: "Promo Code Detail" };

export default async function PromoCodeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePageAccess("/promo-codes");
  const { id } = await params;
  // Shape-check UUID before any DB call — see src/lib/utils/ids.ts.
  if (!isUuid(id)) notFound();
  const data = await getPromoCodeDetail(id);

  if (!data) notFound();

  const isExpired = data.expiresAt && new Date(data.expiresAt) < new Date();
  const redemptionsLeft = Math.max(0, data.maxUses - data.redemptions.length);

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Ticket}
          backHref="/rewards?tab=promo-codes"
          title={data.code ?? "Promo Code"}
          titleClassName="truncate"
          badges={
            <>
              <Badge variant="outline">{data.region}</Badge>
              {isExpired && (
                <Badge
                  variant="outline"
                  className="bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30"
                >
                  Expired
                </Badge>
              )}
            </>
          }
          subtitle={data.codeHash}
          subtitleClassName="font-mono truncate"
          action={<DeletePromoCodeButton promoCodeId={data.id} />}
        />
      </PageHero>

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
          value={`${data.redemptions.length} / ${data.maxUses}`}
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
            value={`${data.redemptions.length} / ${data.maxUses}`}
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
          title={`Redemptions (${data.redemptions.length})`}
        />
        <FadeIn className="rounded-2xl border bg-card/60 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>IP Address</TableHead>
                <TableHead>Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.redemptions.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <Link
                      href={`/users/${r.userId}`}
                      className="hover:underline"
                    >
                      {r.username ?? r.email ?? r.userId}
                    </Link>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {r.ipAddress}
                  </TableCell>
                  <TableCell>{formatDateTime(r.redeemedAt)}</TableCell>
                </TableRow>
              ))}
              {data.redemptions.length === 0 && (
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
      </div>
    </div>
  );
}
