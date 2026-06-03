"use client";

import { useState, useTransition, type ElementType } from "react";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  CalendarClock,
  DollarSign,
  ExternalLink,
  Ticket,
  Users,
} from "lucide-react";
import { formatCurrency, formatDate, formatDateTime } from "@/lib/utils/format";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import type {
  PromoCodeClaimsDetail,
  PromoCodeListItem,
} from "@/lib/queries/promo-codes";
import { getPromoCodeClaimDetail } from "./actions";

// Status derived from the list-row shape (cheap, already on the client)
// so the badge in the dialog header renders instantly before the claim
// detail lazy-loads. Kept identical to the codes-table status mapping.
function codeStatus(row: PromoCodeListItem): { label: string; cls: string } {
  const isExpired = row.expiresAt && new Date(row.expiresAt) < new Date();
  const isUsedUp = row.redemptionCount >= row.maxUses;
  if (isExpired)
    return {
      label: "Expired",
      cls: "border-rose-500/30 bg-rose-500/15 text-rose-600 dark:text-rose-400",
    };
  if (isUsedUp)
    return {
      label: "Used up",
      cls: "border-amber-500/30 bg-amber-500/15 text-amber-600 dark:text-amber-400",
    };
  return {
    label: "Active",
    cls: "border-emerald-500/30 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  };
}

// Compact summary stat in the dialog header. `accent` only ever tints the
// value — House-POV is the caller's call (promo value = house cost = rose).
function SummaryStat({
  icon: Icon,
  label,
  value,
  valueClassName,
}: {
  icon: ElementType;
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <div className="rounded-lg border bg-muted/30 px-3 py-2">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <Icon className="size-3.5 shrink-0" />
        <span className="truncate text-[10px] font-semibold uppercase tracking-wider">
          {label}
        </span>
      </div>
      <p
        className={
          "mt-1 truncate text-sm font-semibold tabular-nums " +
          (valueClassName ?? "")
        }
      >
        {value}
      </p>
    </div>
  );
}

function ClaimsTable({
  claims,
  onNavigate,
}: {
  claims: PromoCodeClaimsDetail["claims"];
  onNavigate: () => void;
}) {
  return (
    <div className="max-h-[45vh] overflow-y-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>User</TableHead>
            <TableHead className="hidden sm:table-cell">IP</TableHead>
            <TableHead className="text-right">Redeemed</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {claims.map((c) => (
            <TableRow key={c.id}>
              <TableCell>
                <Link
                  href={`/users/${c.userId}`}
                  onClick={onNavigate}
                  className="group/link flex items-center gap-2 hover:underline"
                >
                  <span className="flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted">
                    {c.image &&
                    (c.image.startsWith("https://") ||
                      c.image.startsWith("http://")) ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={c.image}
                        alt=""
                        className="size-full object-cover"
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      <span className="text-[10px] font-bold text-muted-foreground">
                        {(c.username ?? c.email ?? "?")[0].toUpperCase()}
                      </span>
                    )}
                  </span>
                  <span className="truncate text-sm">
                    {c.username ?? c.email ?? c.userId.slice(0, 8)}
                  </span>
                  <ExternalLink className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/link:opacity-100" />
                </Link>
              </TableCell>
              <TableCell className="hidden font-mono text-xs text-muted-foreground sm:table-cell">
                {c.ipAddress}
              </TableCell>
              <TableCell className="text-right text-xs text-muted-foreground">
                {formatDateTime(c.redeemedAt)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * Click-through claim detail for a promo code.
 *
 * Controlled by the parent (the codes table) — `open` flips when the
 * admin clicks the code. The claim detail is fetched ON OPEN via the
 * `getPromoCodeClaimDetail` server action (capability-gated, safeQuery +
 * timeout) and cached client-side for the dialog's lifetime so re-opening
 * the same code in one session doesn't refetch. The header summary
 * (code / value / status / limits) renders immediately from the list-row
 * data while the claims stream in behind a skeleton.
 *
 * House-POV: the credited value is house-paid credit → house cost → rose.
 */
export function PromoCodeDetailDialog({
  row,
  open,
  onOpenChange,
}: {
  row: PromoCodeListItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [detail, setDetail] = useState<PromoCodeClaimsDetail | null>(null);
  const [errored, setErrored] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [isPending, startTransition] = useTransition();

  function handleOpenChange(next: boolean) {
    onOpenChange(next);
    if (next && !loaded && !isPending) {
      startTransition(async () => {
        try {
          const res = await getPromoCodeClaimDetail(row.id);
          if (res.error) {
            setErrored(true);
          } else {
            setDetail(res.data);
          }
        } catch {
          setErrored(true);
        } finally {
          setLoaded(true);
        }
      });
    }
  }

  const status = codeStatus(row);
  const codeLabel = row.code ?? row.codeHash.slice(0, 16) + "…";

  // Prefer the freshly-loaded detail; fall back to the list-row figures so
  // the header is never blank during the load.
  const totalClaims = detail?.totalClaims ?? row.redemptionCount;
  const value = detail?.value ?? row.value;
  const totalValueGiven = detail
    ? detail.totalValueGiven
    : row.value * row.redemptionCount;
  const expiresAt = detail?.expiresAt ?? row.expiresAt;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            <span className="flex size-7 items-center justify-center rounded-md bg-amber-500/10">
              <Ticket className="size-4 text-amber-500" />
            </span>
            <span className="font-mono text-sm">{codeLabel}</span>
            <Badge variant="outline" className={status.cls}>
              {status.label}
            </Badge>
            <Badge variant="outline">{row.region}</Badge>
          </DialogTitle>
        </DialogHeader>

        {/* Summary strip — renders immediately from row data, refines once
            the detail resolves. */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <SummaryStat
            icon={DollarSign}
            label="Value / claim"
            value={formatCurrency(value)}
            valueClassName="text-rose-600 dark:text-rose-400"
          />
          <SummaryStat
            icon={Users}
            label="Total claims"
            value={`${totalClaims} / ${row.maxUses}`}
          />
          <SummaryStat
            icon={DollarSign}
            label="Total given"
            value={formatCurrency(totalValueGiven)}
            valueClassName="text-rose-600 dark:text-rose-400"
          />
          <SummaryStat
            icon={CalendarClock}
            label="Expires"
            value={expiresAt ? formatDate(expiresAt) : "Never"}
            valueClassName={
              expiresAt && new Date(expiresAt) < new Date()
                ? "text-rose-600 dark:text-rose-400"
                : undefined
            }
          />
        </div>

        {detail && (
          <p className="text-[11px] text-muted-foreground">
            Created {formatDate(detail.createdAt)}
            {detail.requiresDiscord ? " · Discord required" : ""}
          </p>
        )}

        {/* Claims body */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Who claimed it
            </span>
            {detail?.truncated && (
              <span className="text-[11px] text-muted-foreground">
                showing {detail.claims.length} of {detail.totalClaims}
              </span>
            )}
          </div>

          {isPending && !loaded && (
            <div className="space-y-2 rounded-md border p-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3">
                  <Skeleton className="size-6 rounded-full" />
                  <Skeleton className="h-4 flex-1" />
                  <Skeleton className="h-4 w-24" />
                </div>
              ))}
            </div>
          )}

          {loaded && errored && (
            <EmptyState
              icon={AlertTriangle}
              accent="rose"
              title="Couldn’t load claims"
              description="The claim list timed out or failed to load. Close and reopen to try again."
              compact
            />
          )}

          {loaded && !errored && detail && detail.claims.length === 0 && (
            <EmptyState
              icon={Activity}
              title="No claims yet"
              description="Players who redeem this code will be listed here, most recent first."
              compact
            />
          )}

          {loaded && !errored && detail && detail.claims.length > 0 && (
            <ClaimsTable
              claims={detail.claims}
              onNavigate={() => onOpenChange(false)}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
