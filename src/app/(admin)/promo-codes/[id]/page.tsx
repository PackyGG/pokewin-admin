import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getPromoCodeDetail } from "@/lib/queries/promo-codes";
import { requirePageAccess } from "@/lib/dal";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/promo-codes" className="inline-flex size-9 items-center justify-center rounded-md hover:bg-accent hover:text-accent-foreground">
          <ArrowLeft className="size-4" />
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold">Promo Code</h1>
            <Badge variant="outline">{data.region}</Badge>
            {isExpired && (
              <Badge variant="outline" className="bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30">
                Expired
              </Badge>
            )}
          </div>
          <p className="font-mono text-xs text-muted-foreground">{data.codeHash}</p>
        </div>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-sm font-medium">Details</CardTitle>
          <DeletePromoCodeButton promoCodeId={data.id} />
        </CardHeader>
        <CardContent>
          <div className="flex justify-between">
            <InfoItem label="Value">{formatCurrency(data.value)}</InfoItem>
            <InfoItem label="Region">{data.region}</InfoItem>
            <InfoItem label="Min Level">{data.minimumLevel}</InfoItem>
            <InfoItem label="Min Wager">{formatCurrency(data.minimumWagerAmount)}</InfoItem>
            <InfoItem label="Wager Period">{data.wagerPeriodDays} days</InfoItem>
            <InfoItem label="Max Uses">{data.maxUses}</InfoItem>
            <InfoItem label="Redemptions">{data.redemptions.length}</InfoItem>
            <InfoItem label="Expires">
              {data.expiresAt ? formatDate(data.expiresAt) : "Never"}
            </InfoItem>
            <InfoItem label="Created">{formatDate(data.createdAt)}</InfoItem>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">
            Redemptions ({data.redemptions.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
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
                    <Link href={`/users/${r.userId}`} className="hover:underline">
                      {r.username ?? r.email ?? r.userId}
                    </Link>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{r.ipAddress}</TableCell>
                  <TableCell>{formatDateTime(r.redeemedAt)}</TableCell>
                </TableRow>
              ))}
              {data.redemptions.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} className="h-24 text-center text-muted-foreground">
                    No redemptions yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function InfoItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="text-xs text-muted-foreground">{label}</span>
      <p className="text-sm font-medium">{children}</p>
    </div>
  );
}
