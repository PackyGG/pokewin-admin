"use client";

import React, { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import {
  formatCurrency,
  formatDateTime,
  formatRelative,
} from "@/lib/utils/format";
import { toggleFeatureLock } from "./actions";
import { createNote, deleteNote } from "./note-actions";
import type { UserRewards } from "@/lib/queries/users";
import type {
  AdminNote,
  BalanceHistoryPoint,
  PnlBreakdown,
  UserDetail,
} from "./user-tabs-types";
import { InfoRow, PnlValue } from "./user-tabs-shared";
import { BalanceAdjustDialog, XpAdjustDialog } from "./user-tabs-dialogs";

export const BalanceSummaryCard = React.memo(function BalanceSummaryCard({
  balances,
  userId,
  isAdmin,
  canAdjustBalance,
}: {
  balances: UserDetail["balances"];
  userId: string;
  isAdmin: boolean;
  canAdjustBalance: boolean;
}) {
  const [adjustOpen, setAdjustOpen] = useState(false);

  if (!balances) return null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-sm font-medium">Balances</CardTitle>
        {canAdjustBalance && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => setAdjustOpen(true)}
          >
            Adjust
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Available = balance + inventory + vouchers */}
        <div className="pb-2 border-b">
          <div className="flex items-baseline justify-between">
            <span className="text-sm text-muted-foreground">Available</span>
            <span className="text-2xl font-bold tabular-nums">
              {formatCurrency(
                balances.availableBalance +
                  balances.inventoryValue +
                  balances.vouchersValue,
              )}
            </span>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-md border bg-muted/30 px-2.5 py-1.5">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Balance
              </div>
              <div className="font-semibold tabular-nums">
                {formatCurrency(balances.availableBalance)}
              </div>
            </div>
            <div className="rounded-md border bg-muted/30 px-2.5 py-1.5">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Inventory
              </div>
              <div className="font-semibold tabular-nums">
                {formatCurrency(
                  balances.inventoryValue + balances.vouchersValue,
                )}
              </div>
            </div>
          </div>
        </div>
        <InfoRow
          label="Locked"
          value={formatCurrency(balances.lockedBalance)}
        />
        {balances.unlockAt && (
          <InfoRow
            label="Unlock At"
            value={formatDateTime(balances.unlockAt)}
          />
        )}
        <InfoRow
          label="Deposited"
          value={formatCurrency(balances.totalDeposited)}
        />
        <InfoRow
          label="Withdrawn"
          value={formatCurrency(balances.totalWithdrawn)}
        />
        {(() => {
          // Platform perspective: positive = we earn, negative = we lose
          const platformPnl =
            balances.totalDeposited -
            balances.totalWithdrawn -
            balances.availableBalance -
            balances.lockedBalance -
            balances.inventoryValue -
            balances.vouchersValue;
          const cls =
            platformPnl > 0
              ? "text-emerald-400"
              : platformPnl < 0
                ? "text-rose-400"
                : "text-foreground";
          return (
            <div className="flex items-center justify-between border-t pt-2">
              <span className="text-sm text-muted-foreground">P&L</span>
              <span className={`font-semibold tabular-nums ${cls}`}>
                {platformPnl >= 0 ? "+" : ""}
                {formatCurrency(platformPnl)}
              </span>
            </div>
          );
        })()}
        <InfoRow
          label="Wagered"
          value={formatCurrency(balances.totalWagered)}
        />
        <InfoRow
          label="↳ Packs"
          value={formatCurrency(balances.packsWagered)}
        />
        <InfoRow
          label="↳ Battles"
          value={formatCurrency(balances.battlesWagered)}
        />
        <InfoRow label="Won" value={formatCurrency(balances.totalWon)} />
      </CardContent>
      <BalanceAdjustDialog
        userId={userId}
        open={adjustOpen}
        onOpenChange={setAdjustOpen}
      />
    </Card>
  );
});

/**
 * Statistics: merges Platform P&L, Activity, and Rewards into a single
 * Admin-focused info panel. The P&L is the hero (bordered, big, colored)
 * because fraud/moderation reviewers need to spot red flags immediately.
 * Everything else lives in dense subsections underneath so support can
 * still answer deep questions without jumping between cards.
 */
export const PnlCard = React.memo(function PnlCard({
  pnlBreakdown: p,
  balances,
}: {
  pnlBreakdown: PnlBreakdown;
  balances: UserDetail["balances"];
}) {
  // Platform P&L = deposited − withdrawn − balance − locked − inventory
  // This already includes ALL effects (bonuses, rakeback etc. flow through
  // balance — when given they increase it, when wagered away they decrease it).
  // Costs below are informational only, NOT subtracted again.
  const platformPnl = balances
    ? balances.totalDeposited -
      balances.totalWithdrawn -
      balances.availableBalance -
      balances.lockedBalance -
      balances.inventoryValue -
      balances.vouchersValue
    : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Platform P&L</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* P&L header */}
        <div className="pb-2 border-b">
          <div className="flex items-baseline gap-3">
            <span className="text-sm text-muted-foreground">P&L</span>
            <span
              className={`text-2xl font-bold tabular-nums ${platformPnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}
            >
              {platformPnl >= 0 ? "+" : ""}
              {formatCurrency(platformPnl)}
            </span>
          </div>
          {balances && (
            <div className="mt-1 text-[10px] text-muted-foreground">
              Deposited {formatCurrency(balances.totalDeposited)} − Withdrawn{" "}
              {formatCurrency(balances.totalWithdrawn)} − Balance{" "}
              {formatCurrency(
                balances.availableBalance + balances.lockedBalance,
              )}{" "}
              − Inventory {formatCurrency(balances.inventoryValue)} − Vouchers{" "}
              {formatCurrency(balances.vouchersValue)}
            </div>
          )}
        </div>

        {/* Cost breakdown — supplementary detail */}
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground pt-1">
          Costs Given (included in P&L)
        </p>
        <InfoRow
          label="↳ Bonuses & Promos"
          value={<PnlValue value={-p.bonusesCost} />}
        />
        <InfoRow
          label="↳ Rakeback"
          value={<PnlValue value={-p.rakebackCost} />}
        />
        <InfoRow
          label="↳ Affiliate"
          value={<PnlValue value={-p.affiliateCost} />}
        />
        <div className="group relative">
          <InfoRow label="↳ Other" value={<PnlValue value={-p.otherCosts} />} />
          {p.otherCosts !== 0 && (
            <div className="invisible group-hover:visible absolute left-0 bottom-full mb-1 z-50 w-64 rounded-md border bg-popover p-3 text-popover-foreground shadow-md">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                Other Costs Breakdown
              </p>
              <div className="space-y-1.5">
                {(
                  [
                    ["Rain Win", p.otherCostsDetail.rainWin],
                    ["Race Prize", p.otherCostsDetail.racePrize],
                    ["Balance Reward", p.otherCostsDetail.balanceRewardClaim],
                    ["Creator Tip", p.otherCostsDetail.creatorTip],
                    ["Voucher Redeemed", p.otherCostsDetail.voucherRedeemed],
                    ["Voucher Exchange", p.otherCostsDetail.voucherExchange],
                    [
                      "Exchange Excess Credit",
                      p.otherCostsDetail.exchangeExcessCredit,
                    ],
                    [
                      "Exchange → Voucher",
                      p.otherCostsDetail.exchangeExcessToVoucher,
                    ],
                    [
                      "Battle → Voucher",
                      p.otherCostsDetail.battleExcessToVoucher,
                    ],
                  ] as [string, number][]
                )
                  .filter(([, v]) => v !== 0)
                  .map(([label, value]) => (
                    <div
                      key={label}
                      className="flex items-center justify-between text-xs"
                    >
                      <span className="text-muted-foreground">{label}</span>
                      <PnlValue value={-value} />
                    </div>
                  ))}
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
});

export const ActivityStatsCard = React.memo(function ActivityStatsCard({
  statistics,
  balances,
  inventoryCount,
  bonusPoints,
  avgDeposit,
  userId,
  canAdjustXp,
}: {
  statistics: UserDetail["statistics"];
  balances: UserDetail["balances"];
  inventoryCount: number;
  bonusPoints: number;
  avgDeposit: number;
  userId: string;
  canAdjustXp: boolean;
}) {
  const [xpAdjustOpen, setXpAdjustOpen] = useState(false);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-sm font-medium">Activity</CardTitle>
        {canAdjustXp && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => setXpAdjustOpen(true)}
          >
            Adjust XP
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1 pb-2 border-b">
          <div className="flex items-baseline gap-3">
            <span className="text-sm text-muted-foreground">Level</span>
            <span className="text-2xl font-bold tabular-nums">
              {statistics?.level ?? 0}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">XP</span>
            <span className="text-sm tabular-nums">{statistics?.xp ?? 0}</span>
          </div>
          {balances &&
            (() => {
              const wagerLoss = balances.totalWagered - balances.totalWon;
              return (
                <div className="flex items-center gap-3">
                  <span className="text-xs text-muted-foreground">
                    Wager Loss
                  </span>
                  <span
                    className={`text-sm tabular-nums ${wagerLoss > 0 ? "text-red-400" : wagerLoss < 0 ? "text-green-400" : "text-muted-foreground"}`}
                  >
                    {wagerLoss > 0 ? "-" : wagerLoss < 0 ? "+" : ""}
                    {formatCurrency(Math.abs(wagerLoss))}
                  </span>
                </div>
              );
            })()}
        </div>
        <InfoRow
          label="Packs Opened"
          value={String(statistics?.openedPacks ?? 0)}
        />
        <InfoRow
          label="Battles Played"
          value={String(statistics?.battlesPlayed ?? 0)}
        />
        <InfoRow label="Inventory Items" value={String(inventoryCount)} />
        <InfoRow label="Bonus Points" value={String(bonusPoints)} />
        <InfoRow label="Avg. Deposit" value={formatCurrency(avgDeposit)} />
        {(() => {
          // Avg house edge = (wagered - won) / wagered × 100. Aggregate
          // across the user's entire wagering history so it's stable and
          // meaningful unlike the per-row edge we used to show.
          const wagered = balances?.totalWagered ?? 0;
          const won = balances?.totalWon ?? 0;
          if (wagered <= 0) {
            return <InfoRow label="Avg. House Edge" value="—" />;
          }
          const edge = ((wagered - won) / wagered) * 100;
          return (
            <InfoRow
              label="Avg. House Edge"
              value={`${edge.toFixed(2)}%`}
            />
          );
        })()}
        {statistics && (
          <>
            <div className="border-t pt-2 mt-2" />
            <InfoRow
              label="Wagered Today"
              value={formatCurrency(statistics.currentDayWageredUsd)}
            />
            <InfoRow
              label="Wagered This Week"
              value={formatCurrency(statistics.currentWeekWageredUsd)}
            />
            <InfoRow
              label="Wagered This Month"
              value={formatCurrency(statistics.currentMonthWageredUsd)}
            />
            <InfoRow
              label="Weekly Wager Count"
              value={String(statistics.weeklyWagerCount)}
            />
            <InfoRow
              label="Last Wagered"
              value={
                statistics.lastWageredAt
                  ? formatRelative(statistics.lastWageredAt)
                  : "Never"
              }
            />
            <InfoRow
              label="Profile Private"
              value={statistics.isProfilePrivate ? "Yes" : "No"}
            />
          </>
        )}
      </CardContent>
      <XpAdjustDialog
        userId={userId}
        open={xpAdjustOpen}
        onOpenChange={setXpAdjustOpen}
      />
    </Card>
  );
});

export const RewardsCard = React.memo(function RewardsCard({
  rewards,
}: {
  rewards: UserRewards;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Rewards</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="rounded-md border bg-muted/30 px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Open one-time rewards
          </div>
          <div className="text-2xl font-bold tabular-nums">
            {rewards.openOneTimeCount}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-md border bg-muted/30 px-2.5 py-1.5">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Rakeback claimable
            </div>
            <div className="text-lg font-semibold tabular-nums text-emerald-400">
              {formatCurrency(rewards.rakebackClaimableUsd)}
            </div>
          </div>
          <div className="rounded-md border bg-muted/30 px-2.5 py-1.5">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Rakeback claimed
            </div>
            <div className="text-lg font-semibold tabular-nums text-muted-foreground">
              {formatCurrency(rewards.rakebackClaimedUsd)}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
});

export const FeatureLocksCard = React.memo(function FeatureLocksCard({
  userId,
  featureLocks,
  canToggle,
}: {
  userId: string;
  featureLocks: UserDetail["featureLocks"];
  canToggle: boolean;
}) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const features = [
    {
      key: "locked_withdrawals_crypto",
      label: "Crypto Withdrawals",
      locked: featureLocks?.lockedWithdrawalsCrypto ?? false,
    },
    {
      key: "locked_withdrawals_items",
      label: "Item Withdrawals",
      locked: featureLocks?.lockedWithdrawalsItems ?? false,
    },
    {
      key: "locked_inventory_sales",
      label: "Inventory Sales",
      locked: featureLocks?.lockedInventorySales ?? false,
    },
    {
      key: "locked_exchanges",
      label: "Exchanges",
      locked: featureLocks?.lockedExchanges ?? false,
    },
    {
      key: "locked_openings",
      label: "Openings",
      locked: featureLocks?.lockedOpenings ?? false,
    },
    {
      key: "locked_vault",
      label: "Vault",
      locked: featureLocks?.lockedVault ?? false,
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Feature Locks</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {features.map((f) => (
          <div key={f.key} className="flex items-center justify-between">
            <span className="text-sm">{f.label}</span>
            <div className="flex items-center gap-2">
              <Badge
                variant="outline"
                className={
                  f.locked
                    ? "bg-red-500/15 text-red-600 dark:text-red-400"
                    : "bg-green-500/15 text-green-600 dark:text-green-400"
                }
              >
                {f.locked ? "Locked" : "Open"}
              </Badge>
              {canToggle && (
                <Switch
                  checked={f.locked}
                  disabled={isPending}
                  onCheckedChange={(checked) => {
                    startTransition(async () => {
                      await toggleFeatureLock(userId, f.key, checked);
                      toast.success(
                        `${f.label} ${checked ? "locked" : "unlocked"}`,
                      );
                      router.refresh();
                    });
                  }}
                />
              )}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
});

export const AccountDetailsSection = React.memo(function AccountDetailsSection({
  user,
  shippingAddress,
  vault,
  depositAddresses,
}: {
  user: UserDetail["user"];
  shippingAddress: UserDetail["shippingAddress"];
  vault: UserDetail["vault"];
  depositAddresses: UserDetail["depositAddresses"];
}) {
  return (
    <div className="space-y-6">
      {/* Row 1 — Account | Shipping Address | Vault */}
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {/* Account */}
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            Account
          </p>
          <div className="space-y-2.5">
            <InfoRow label="Providers" value={user.providers.join(", ")} />
            <InfoRow label="API Key" value={user.hasApiKey ? "Yes" : "No"} />
            <InfoRow
              label="Signup IP"
              value={user.signupIp ?? "-"}
              mono
              truncate
            />
            <InfoRow
              label="Location"
              value={
                [user.city, user.state, user.continentCode]
                  .filter(Boolean)
                  .join(", ") || "-"
              }
            />
            <InfoRow
              label="Registered"
              value={formatDateTime(user.createdAt)}
            />
            <InfoRow label="Updated" value={formatDateTime(user.updatedAt)} />
          </div>
        </div>

        {/* Shipping Address */}
        {shippingAddress && (
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
              Shipping Address
            </p>
            <div className="space-y-2.5">
              <InfoRow
                label="Name"
                value={`${shippingAddress.firstName} ${shippingAddress.lastName}`}
              />
              <InfoRow
                label="Phone"
                value={`${shippingAddress.phoneCountryCode} ${shippingAddress.phoneNumber}`}
              />
              <InfoRow
                label="Address"
                value={[
                  shippingAddress.addressLine1,
                  shippingAddress.addressLine2,
                ]
                  .filter(Boolean)
                  .join(", ")}
                truncate
              />
              <InfoRow label="City" value={shippingAddress.city} />
              {shippingAddress.stateProvince && (
                <InfoRow label="State" value={shippingAddress.stateProvince} />
              )}
              <InfoRow label="ZIP" value={shippingAddress.zipCode} />
              <InfoRow label="Country" value={shippingAddress.country} />
            </div>
          </div>
        )}

        {/* Vault */}
        {vault && (
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
              Vault
            </p>
            <div className="space-y-2.5">
              <InfoRow label="ID" value={vault.id} mono truncate />
              <InfoRow label="Name" value={vault.name} />
              {vault.customerRefId && (
                <InfoRow
                  label="Customer Ref"
                  value={vault.customerRefId}
                  mono
                  truncate
                />
              )}
              {vault.fireblocksVaultId && (
                <InfoRow
                  label="Fireblocks Vault"
                  value={vault.fireblocksVaultId}
                  mono
                  truncate
                />
              )}
              <InfoRow
                label="Created"
                value={formatDateTime(vault.createdAt)}
              />
            </div>
          </div>
        )}
      </div>

      {/* Row 2 — Deposit Addresses (full width) */}
      {depositAddresses.length > 0 && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            Deposit Addresses
          </p>
          <div className="grid gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
            {depositAddresses.map((da) => (
              <div
                key={da.id}
                className="space-y-1.5 rounded-md border p-2.5 min-w-0"
              >
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-xs shrink-0">
                    {da.assetId}
                  </Badge>
                </div>
                <p className="font-mono text-xs truncate" title={da.address}>
                  {da.address}
                </p>
                {da.tag && (
                  <p className="text-xs text-muted-foreground">
                    Tag: <span className="font-mono">{da.tag}</span>
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
});

const balanceChartConfig = {
  balance: {
    label: "Balance",
    color: "var(--color-chart-1)",
  },
} satisfies ChartConfig;

const BALANCE_RANGES = [
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
  { label: "All", days: 0 },
] as const;

export const BalanceHistoryChart = React.memo(function BalanceHistoryChart({
  data,
}: {
  data: BalanceHistoryPoint[];
}) {
  const [range, setRange] = useState(30);

  if (data.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Balance History</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground text-center py-8">
            No transaction history
          </p>
        </CardContent>
      </Card>
    );
  }

  const filtered =
    range > 0
      ? (() => {
          const cutoff = new Date();
          cutoff.setDate(cutoff.getDate() - range);
          const cutoffStr = cutoff.toISOString().slice(0, 10);
          return data.filter((d) => d.date >= cutoffStr);
        })()
      : data;

  const chartData = filtered.length > 0 ? filtered : data;
  const tickInterval = Math.max(1, Math.floor(chartData.length / 10));

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-sm font-medium">Balance History</CardTitle>
        <div className="flex items-center gap-1">
          {BALANCE_RANGES.map((r) => (
            <Button
              key={r.label}
              variant={range === r.days ? "default" : "outline"}
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setRange(r.days)}
            >
              {r.label}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        <ChartContainer
          config={balanceChartConfig}
          className="h-[300px] w-full"
        >
          <AreaChart data={chartData} accessibilityLayer>
            <defs>
              <linearGradient id="balanceGradient" x1="0" y1="0" x2="0" y2="1">
                <stop
                  offset="5%"
                  stopColor="var(--color-balance)"
                  stopOpacity={0.3}
                />
                <stop
                  offset="95%"
                  stopColor="var(--color-balance)"
                  stopOpacity={0}
                />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              interval={tickInterval}
              tickFormatter={(v) => v.slice(5)}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              width={70}
              domain={["auto", "auto"]}
              tickFormatter={(v) => {
                if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
                if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
                return `$${v}`;
              }}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  formatter={(value) => `$${Number(value).toFixed(2)}`}
                />
              }
            />
            <Area
              type="monotone"
              dataKey="balance"
              stroke="var(--color-balance)"
              strokeWidth={2}
              fill="url(#balanceGradient)"
            />
          </AreaChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
});

/* ── Notes Section ── */
export const NotesSection = React.memo(function NotesSection({
  userId,
  notes,
}: {
  userId: string;
  notes: AdminNote[];
}) {
  const [content, setContent] = useState("");
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!content.trim()) return;
    startTransition(async () => {
      try {
        await createNote(userId, content);
        setContent("");
        toast.success("Note added");
        router.refresh();
      } catch {
        toast.error("Failed to add note");
      }
    });
  }

  function handleDelete(noteId: string) {
    startTransition(async () => {
      try {
        await deleteNote(noteId);
        toast.success("Note deleted");
        router.refresh();
      } catch {
        toast.error("Failed to delete note");
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">
          Notes ({notes.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={handleSubmit} className="space-y-2">
          <Textarea
            placeholder="Add a note about this user..."
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={3}
          />
          <Button
            type="submit"
            size="sm"
            disabled={isPending || !content.trim()}
          >
            {isPending && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
            Add Note
          </Button>
        </form>

        {notes.length > 0 && (
          <div className="space-y-3 border-t pt-4">
            {notes.map((note) => (
              <div key={note.id} className="rounded-md border p-3 space-y-1">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">
                      {note.adminUsername}
                    </span>
                    <span>{formatRelative(note.createdAt)}</span>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6"
                    onClick={() => handleDelete(note.id)}
                    disabled={isPending}
                  >
                    <Trash2 className="size-3" />
                  </Button>
                </div>
                <p className="text-sm whitespace-pre-wrap">{note.content}</p>
              </div>
            ))}
          </div>
        )}

        {notes.length === 0 && (
          <p className="text-sm text-muted-foreground">No notes yet</p>
        )}
      </CardContent>
    </Card>
  );
});
