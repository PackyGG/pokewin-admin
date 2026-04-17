import { notFound } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  Ticket,
  DollarSign,
  Users,
  Calendar,
  ShieldCheck,
  Activity,
} from "lucide-react";
import { getPromoCodeDetail } from "@/lib/queries/promo-codes";
import { requirePageAccess } from "@/lib/dal";
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
  SectionHeading,
  KpiTile,
  StatPanel,
  PanelRow,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";

export const metadata = { title: "Promo Code Detail" };

export default async function PromoCodeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePageAccess("/promo-codes");
  const { id } = await params;
  const data = await getPromoCodeDetail(id);

  if (!data) notFound();

  const isExpired = data.expiresAt && new Date(data.expiresAt) < new Date();
  const redemptionsLeft = Math.max(0, data.maxUses - data.redemptions.length);

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <Link
              href="/promo-codes"
              className="inline-flex size-9 items-center justify-center rounded-md hover:bg-accent hover:text-accent-foreground"
            >
              <ArrowLeft className="size-4" />
            </Link>
            <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10">
              <Ticket className="size-5 text-primary" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-2xl font-bold leading-tight">
                  {data.code ?? "Promo Code"}
                </h1>
                <Badge variant="outline">{data.region}</Badge>
                {isExpired && (
                  <Badge
                    variant="outline"
                    className="bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30"
                  >
                    Expired
                  </Badge>
                )}
              </div>
              <p className="text-xs font-mono text-muted-foreground mt-0.5">
                {data.codeHash}
              </p>
            </div>
          </div>
          <DeletePromoCodeButton promoCodeId={data.id} />
        </div>
      </PageHero>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiTile
          label="Value"
          value={formatCurrency(data.value)}
          icon={DollarSign}
          accent="emerald"
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
                    ? "bg-green-500/15 text-green-400 border-green-500/30"
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
        </StatPanel>
      </div>

      <div className="space-y-3">
        <SectionHeading
          icon={Activity}
          title={`Redemptions (${data.redemptions.length})`}
        />
        <FadeIn className="rounded-2xl border bg-card/60">
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
                <TableRow>
                  <TableCell
                    colSpan={3}
                    className="h-24 text-center text-muted-foreground"
                  >
                    No redemptions yet.
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
