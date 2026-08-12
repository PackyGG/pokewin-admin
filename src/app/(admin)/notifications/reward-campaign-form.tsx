"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  CheckCircle2,
  CopyCheck,
  Filter,
  Plus,
  Play,
  RotateCcw,
  Ticket,
  Trash2,
  UserPlus,
  UserX,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ux";
import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import {
  depositWindowLabel,
  REWARD_TIER_MAX,
  roundUsd,
  validateRewardTiers,
  type DepositWindow,
  type RewardTier,
} from "@/lib/reward-campaign-tiers";
import {
  BULK_MAX_ITEMS,
  REWARD_AUDIENCE_MAX,
  validateCampaignSlug,
} from "@/lib/user-notification";
import { sendRewardCampaignChunkAction } from "./reward-actions";
import {
  resolveTieredRewardAudienceAction,
  type AudienceFilters,
  type PickedUser,
  type TieredRewardAudience,
} from "./audience-actions";
import { NotificationUserPicker } from "./notification-user-picker";
import type { DbEnv } from "@/lib/db-env";

type Mode = "pick" | "filter";
type Failure = { chunkIndex: number; error: string };
type PlannedChunk = {
  userIds: string[];
  valueUsd: number;
  tier: RewardTier;
};
type SendPlan = {
  chunks: PlannedChunk[];
  campaign: string;
  expiresInDays: number | null;
  exposureUsd: number;
};
type ChunkTotals = {
  requested: number;
  created: number;
  deduped: number;
  codesMinted: number;
  codesReused: number;
  mintedValueUsd: number;
  unknown: string[];
};

const ANY = "__any__";
let tierSequence = 2;

function defaultTier(): RewardTier {
  return {
    id: "tier_1",
    label: "All depositors",
    minDepositUsd: 0,
    maxDepositUsd: null,
    rewardUsd: 5,
    window: { kind: "lifetime" },
  };
}

export function RewardCampaignForm({ targetEnv }: { targetEnv: DbEnv }) {
  const [mode, setMode] = useState<Mode>("filter");
  const [picked, setPicked] = useState<PickedUser[]>([]);
  const [filters, setFilters] = useState<AudienceFilters>({});
  const [tiers, setTiers] = useState<RewardTier[]>([defaultTier()]);
  const [audience, setAudience] = useState<TieredRewardAudience | null>(null);
  const [resolving, startResolving] = useTransition();
  const [stale, setStale] = useState(true);
  const [campaign, setCampaign] = useState("");
  const [expiresInDays, setExpiresInDays] = useState("");
  const [sending, setSending] = useState(false);
  const [currentChunk, setCurrentChunk] = useState(0);
  const [results, setResults] = useState<ChunkTotals[]>([]);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [sent, setSent] = useState<SendPlan | null>(null);

  const tierError = validateRewardTiers(tiers);
  const pickedIds = useMemo(() => picked.map((user) => user.id), [picked]);

  useEffect(() => {
    if (tierError || (mode === "pick" && pickedIds.length === 0)) {
      setAudience(null);
      setStale(false);
      return;
    }
    setStale(true);
    let cancelled = false;
    const timer = setTimeout(() => {
      startResolving(async () => {
        const result = await resolveTieredRewardAudienceAction({
          filters,
          pickedUserIds: mode === "pick" ? pickedIds : undefined,
          tiers,
        });
        if (cancelled) return;
        if (!result.success) {
          setAudience(null);
          toast.error(result.error);
        } else {
          setAudience(result.audience);
        }
        setStale(false);
      });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [filters, mode, pickedIds, tierError, tiers]);

  const chunks = useMemo(() => {
    const result: PlannedChunk[] = [];
    for (const resolved of audience?.tiers ?? []) {
      for (
        let index = 0;
        index < resolved.userIds.length;
        index += BULK_MAX_ITEMS
      ) {
        result.push({
          userIds: resolved.userIds.slice(index, index + BULK_MAX_ITEMS),
          valueUsd: roundUsd(resolved.tier.rewardUsd),
          tier: resolved.tier,
        });
      }
    }
    return result;
  }, [audience]);
  const recipientCount = audience?.count ?? 0;
  const exposure =
    audience?.tiers.reduce((sum, tier) => sum + tier.exposureUsd, 0) ?? 0;
  const slugError = campaign.trim() ? validateCampaignSlug(campaign) : null;
  const readyToSend =
    !sending &&
    !resolving &&
    !stale &&
    recipientCount > 0 &&
    !audience?.truncated &&
    !tierError &&
    !slugError &&
    campaign.trim() !== "";

  const totals = useMemo(() => {
    const unknown = new Set<string>();
    const total = {
      requested: 0,
      created: 0,
      deduped: 0,
      codesMinted: 0,
      codesReused: 0,
      mintedValueUsd: 0,
    };
    for (const result of results) {
      total.requested += result.requested;
      total.created += result.created;
      total.deduped += result.deduped;
      total.codesMinted += result.codesMinted;
      total.codesReused += result.codesReused;
      total.mintedValueUsd += result.mintedValueUsd;
      result.unknown.forEach((id) => unknown.add(id));
    }
    return { ...total, unknown: [...unknown] };
  }, [results]);

  async function run(plan: SendPlan, fromChunk: number) {
    setSending(true);
    setFailure(null);
    try {
      for (let index = fromChunk; index < plan.chunks.length; index++) {
        setCurrentChunk(index);
        const chunk = plan.chunks[index];
        const result = await sendRewardCampaignChunkAction({
          campaign: plan.campaign,
          valueUsd: chunk.valueUsd,
          userIds: chunk.userIds,
          expiresInDays: plan.expiresInDays,
          chunkIndex: index,
          chunkCount: plan.chunks.length,
          tier: chunk.tier,
        });
        if (!result.success) {
          setFailure({ chunkIndex: index, error: result.error });
          toast.error(`Batch ${index + 1} failed — retrying it is safe`);
          return;
        }
        setResults((current) => [
          ...current,
          {
            requested: result.requested,
            created: result.created,
            deduped: result.deduped,
            codesMinted: result.codesMinted,
            codesReused: result.codesReused,
            mintedValueUsd: result.codesMinted * chunk.valueUsd,
            unknown: result.unknownUsers,
          },
        ]);
      }
      toast.success("Tiered reward campaign sent");
    } finally {
      setSending(false);
    }
  }

  function handleStart() {
    if (!readyToSend || chunks.length === 0) return;
    if (
      !window.confirm(
        `Mint and deliver ${formatNumber(recipientCount)} single-use codes worth ${formatCurrency(exposure)} total in ${targetEnv.toUpperCase()} across ${formatNumber(tiers.length)} deposit tier${tiers.length === 1 ? "" : "s"}?`,
      )
    )
      return;
    const days = Number(expiresInDays);
    const plan: SendPlan = {
      chunks,
      campaign: campaign.trim(),
      expiresInDays:
        expiresInDays.trim() && Number.isFinite(days) && days > 0 ? days : null,
      exposureUsd: exposure,
    };
    setSent(plan);
    setResults([]);
    setCurrentChunk(0);
    void run(plan, 0);
  }

  const done = results.length;
  const totalChunks = sent?.chunks.length ?? chunks.length;
  const progressPct =
    totalChunks > 0 ? Math.round((done / totalChunks) * 100) : 0;

  return (
    <div className="space-y-4">
      <Step n={1} title="Choose the eligible users">
        <div className="grid gap-2 sm:grid-cols-2">
          <ModeCard
            active={mode === "filter"}
            icon={Filter}
            title="Match a group"
            hint="Use account and affiliate filters"
            onClick={() => setMode("filter")}
            disabled={sending}
          />
          <ModeCard
            active={mode === "pick"}
            icon={UserPlus}
            title="Pick users"
            hint="Tier specific accounts by their deposits"
            onClick={() => setMode("pick")}
            disabled={sending}
          />
        </div>
        {mode === "pick" ? (
          <div className="space-y-2">
            <div className="sm:max-w-xs">
              <NotificationUserPicker
                disabled={sending}
                label="Search for a user…"
                onSelect={(user) =>
                  setPicked((current) =>
                    current.some((item) => item.id === user.id)
                      ? current
                      : [...current, user],
                  )
                }
              />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {picked.map((user) => (
                <span
                  key={user.id}
                  className="inline-flex items-center gap-1.5 rounded-full border bg-muted/40 py-1 pl-2.5 pr-1 text-xs"
                >
                  {user.username ?? user.email ?? user.id}
                  <button
                    type="button"
                    disabled={sending}
                    onClick={() =>
                      setPicked((current) =>
                        current.filter((item) => item.id !== user.id),
                      )
                    }
                    className="rounded-full p-0.5 text-muted-foreground hover:text-rose-600"
                    aria-label={`Remove ${user.username ?? user.id}`}
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
            {picked.length === 0 && (
              <p className="text-[11px] text-muted-foreground">
                No one selected yet.
              </p>
            )}
          </div>
        ) : (
          <div className="grid gap-2 sm:grid-cols-3">
            <FilterSelect
              label="Deposited"
              value={filters.deposited ?? ANY}
              disabled={sending}
              onChange={(value) =>
                setFilters((current) => ({
                  ...current,
                  deposited: value === ANY ? undefined : value,
                }))
              }
              options={[
                { value: ANY, label: "Any" },
                { value: "yes", label: "Has deposited" },
                { value: "no", label: "Never deposited" },
              ]}
            />
            <FilterSelect
              label="Status"
              value={filters.status ?? ANY}
              disabled={sending}
              onChange={(value) =>
                setFilters((current) => ({
                  ...current,
                  status: value === ANY ? undefined : value,
                }))
              }
              options={[
                { value: ANY, label: "Any active eligibility" },
                { value: "active", label: "Active" },
                { value: "locked", label: "Locked" },
              ]}
            />
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">
                Affiliate code
              </Label>
              <Input
                value={filters.affiliateCode ?? ""}
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    affiliateCode: event.target.value,
                  }))
                }
                placeholder="any"
                className="font-mono text-xs uppercase"
                disabled={sending}
              />
            </div>
          </div>
        )}
        <p className="text-[11px] text-muted-foreground">
          Banned accounts, staff, creators, ex-creators, and excluded users are
          always removed.
        </p>
      </Step>

      <Step n={2} title="Set deposit tiers and reward amounts">
        <div className="space-y-3">
          {tiers.map((tier, index) => (
            <TierEditor
              key={tier.id}
              tier={tier}
              index={index}
              disabled={sending}
              canDelete={tiers.length > 1}
              onChange={(next) =>
                setTiers((current) =>
                  current.map((item) => (item.id === tier.id ? next : item)),
                )
              }
              onDelete={() =>
                setTiers((current) =>
                  current.filter((item) => item.id !== tier.id),
                )
              }
            />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={sending || tiers.length >= REWARD_TIER_MAX}
            onClick={() => {
              const id = `tier_${tierSequence++}`;
              setTiers((current) => [
                ...current,
                {
                  id,
                  label: `Tier ${current.length + 1}`,
                  minDepositUsd: 0,
                  maxDepositUsd: null,
                  rewardUsd: 5,
                  window: { kind: "lifetime" },
                },
              ]);
            }}
          >
            <Plus className="size-3.5" /> Add tier
          </Button>
          <span className="text-[11px] text-muted-foreground">
            Ranges are minimum-inclusive and maximum-exclusive. If rules
            overlap, the first matching tier wins.
          </span>
        </div>
        {tierError && (
          <p className="text-xs text-rose-600 dark:text-rose-400">
            {tierError}
          </p>
        )}
      </Step>

      <Step n={3} title="Preview the matched payouts">
        {resolving || stale ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner size={13} label="Calculating deposit tiers" /> Calculating
            deposits and recipients…
          </div>
        ) : audience ? (
          <div className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {audience.tiers.map((resolved) => (
                <div
                  key={resolved.tier.id}
                  className="rounded-md border bg-muted/20 p-3"
                >
                  <p className="truncate text-xs font-medium">
                    {resolved.tier.label || resolved.tier.id}
                  </p>
                  <p className="mt-1 text-lg font-semibold tabular-nums">
                    {formatNumber(resolved.count)}{" "}
                    <span className="text-xs font-normal text-muted-foreground">
                      users
                    </span>
                  </p>
                  <p className="text-xs text-rose-600 dark:text-rose-400">
                    {formatCurrency(resolved.exposureUsd)} exposure
                  </p>
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    {formatCurrency(resolved.tier.minDepositUsd)}–
                    {resolved.tier.maxDepositUsd === null
                      ? "∞"
                      : formatCurrency(resolved.tier.maxDepositUsd)}{" "}
                    deposited · {depositWindowLabel(resolved.tier.window)} ·{" "}
                    {formatCurrency(resolved.tier.rewardUsd)} each
                  </p>
                </div>
              ))}
            </div>
            {audience.truncated && (
              <p className="text-xs text-rose-600 dark:text-rose-400">
                The base audience exceeds the{" "}
                {formatNumber(REWARD_AUDIENCE_MAX)} user cap. Narrow the
                filters.
              </p>
            )}
            {(audience.unmatched > 0 || audience.overlaps > 0) && (
              <p className="text-[11px] text-amber-600 dark:text-amber-400">
                {formatNumber(audience.unmatched)} eligible users match no tier.{" "}
                {formatNumber(audience.overlaps)} match more than one tier and
                will receive the first match only.
              </p>
            )}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Complete the audience and tier rules to calculate a preview.
          </p>
        )}
      </Step>

      <Step n={4} title="Name, review, and send">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              Campaign name
            </Label>
            <Input
              value={campaign}
              onChange={(event) => setCampaign(event.target.value)}
              placeholder="deposit_promo_aug_2026"
              className="font-mono text-xs"
              disabled={sending}
            />
            <p
              className={cn(
                "text-[11px]",
                slugError
                  ? "text-rose-600 dark:text-rose-400"
                  : "text-muted-foreground",
              )}
            >
              {slugError ??
                "Keep it stable — reruns safely reuse the same user codes"}
            </p>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              Code expires in
            </Label>
            <div className="relative">
              <Input
                type="number"
                min={1}
                value={expiresInDays}
                onChange={(event) => setExpiresInDays(event.target.value)}
                placeholder="never"
                className="pr-12"
                disabled={sending}
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                days
              </span>
            </div>
          </div>
        </div>
        <div className="rounded-lg border bg-muted/30 p-4 text-sm">
          <strong className="text-lg tabular-nums">
            {formatNumber(recipientCount)}
          </strong>{" "}
          <span className="text-muted-foreground">
            users across {formatNumber(tiers.length)} tiers =
          </span>{" "}
          <strong className="text-lg tabular-nums text-rose-600 dark:text-rose-400">
            {formatCurrency(exposure)}
          </strong>{" "}
          <span className="text-xs text-muted-foreground">
            maximum exposure
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={handleStart} disabled={!readyToSend}>
            <Play className="size-4" />
            {sending
              ? `Sending batch ${currentChunk + 1} of ${totalChunks}…`
              : `Send ${formatNumber(recipientCount)} rewards`}
          </Button>
          {failure && sent && (
            <Button
              variant="outline"
              onClick={() => void run(sent, failure.chunkIndex)}
              disabled={sending}
            >
              <RotateCcw className="size-4" /> Retry batch{" "}
              {failure.chunkIndex + 1}
            </Button>
          )}
          {(results.length > 0 || failure) && !sending && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setResults([]);
                setFailure(null);
                setCurrentChunk(0);
                setSent(null);
              }}
            >
              Clear results
            </Button>
          )}
        </div>
        {(sending || results.length > 0) && totalChunks > 0 && (
          <div className="space-y-1.5">
            <div className="flex justify-between text-[11px] text-muted-foreground">
              <span>
                Batch {Math.min(done + (sending ? 1 : 0), totalChunks)} of{" "}
                {totalChunks}
              </span>
              <span>{progressPct}%</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-foreground/70 transition-all"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>
        )}
        {failure && (
          <div className="rounded-md border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-700 dark:text-rose-300">
            <p className="font-medium">Batch {failure.chunkIndex + 1} failed</p>
            <p>{failure.error}</p>
            <p className="mt-1 opacity-75">
              Retrying reuses any codes already minted and cannot pay twice.
            </p>
          </div>
        )}
        {results.length > 0 && (
          <div className="space-y-3 rounded-md border p-3">
            <p className="text-xs font-medium">
              {done} of {totalChunks} batches ·{" "}
              {formatCurrency(totals.mintedValueUsd)} newly issued
            </p>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <CountTile
                icon={Ticket}
                label="Codes minted"
                value={totals.codesMinted}
                accent="text-emerald-600 dark:text-emerald-400"
              />
              <CountTile
                icon={CopyCheck}
                label="Codes reused"
                value={totals.codesReused}
                accent="text-blue-600 dark:text-blue-400"
              />
              <CountTile
                icon={CheckCircle2}
                label="Delivered"
                value={totals.created}
                accent="text-emerald-600 dark:text-emerald-400"
              />
              <CountTile
                icon={UserX}
                label="Unknown"
                value={totals.unknown.length}
                accent="text-amber-600 dark:text-amber-400"
              />
            </div>
            {totals.deduped > 0 && (
              <p className="text-[11px] text-muted-foreground">
                {formatNumber(totals.deduped)} notifications were already
                delivered on an earlier run.
              </p>
            )}
          </div>
        )}
      </Step>
    </div>
  );
}

function TierEditor({
  tier,
  index,
  disabled,
  canDelete,
  onChange,
  onDelete,
}: {
  tier: RewardTier;
  index: number;
  disabled: boolean;
  canDelete: boolean;
  onChange: (tier: RewardTier) => void;
  onDelete: () => void;
}) {
  const customWindow = tier.window.kind === "custom" ? tier.window : null;
  const setWindow = (kind: DepositWindow["kind"]) => {
    const window: DepositWindow =
      kind === "lifetime"
        ? { kind }
        : kind === "rolling"
          ? { kind, days: 30 }
          : {
              kind,
              startDate: new Date().toISOString().slice(0, 10),
              endDate: new Date().toISOString().slice(0, 10),
            };
    onChange({ ...tier, window });
  };
  return (
    <div className="space-y-3 rounded-lg border bg-muted/15 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Priority {index + 1}
        </p>
        {canDelete && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onDelete}
            disabled={disabled}
            aria-label={`Delete ${tier.label}`}
          >
            <Trash2 className="size-3.5" />
          </Button>
        )}
      </div>
      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-6">
        <Field label="Tier name">
          <Input
            value={tier.label}
            onChange={(event) =>
              onChange({ ...tier, label: event.target.value })
            }
            placeholder={`Tier ${index + 1}`}
            disabled={disabled}
          />
        </Field>
        <Field label="Min deposits ($)">
          <Input
            type="number"
            min={0}
            step="0.01"
            value={tier.minDepositUsd}
            onChange={(event) =>
              onChange({ ...tier, minDepositUsd: Number(event.target.value) })
            }
            disabled={disabled}
          />
        </Field>
        <Field label="Max deposits ($)">
          <Input
            type="number"
            min={0}
            step="0.01"
            value={tier.maxDepositUsd ?? ""}
            onChange={(event) =>
              onChange({
                ...tier,
                maxDepositUsd:
                  event.target.value === "" ? null : Number(event.target.value),
              })
            }
            placeholder="no max"
            disabled={disabled}
          />
        </Field>
        <Field label="Deposit timeframe">
          <Select
            value={tier.window.kind}
            onValueChange={(value) =>
              setWindow((value ?? "lifetime") as DepositWindow["kind"])
            }
          >
            <SelectTrigger disabled={disabled}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="lifetime">Lifetime</SelectItem>
              <SelectItem value="rolling">Rolling days</SelectItem>
              <SelectItem value="custom">Custom dates</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        {tier.window.kind === "rolling" ? (
          <Field label="Days">
            <Input
              type="number"
              min={1}
              max={3650}
              value={tier.window.days}
              onChange={(event) =>
                onChange({
                  ...tier,
                  window: { kind: "rolling", days: Number(event.target.value) },
                })
              }
              disabled={disabled}
            />
          </Field>
        ) : customWindow ? (
          <div className="grid grid-cols-2 gap-2 xl:col-span-2">
            <Field label="From (UTC)">
              <Input
                type="date"
                value={customWindow.startDate}
                onChange={(event) =>
                  onChange({
                    ...tier,
                    window: {
                      kind: "custom",
                      startDate: event.target.value,
                      endDate: customWindow.endDate,
                    },
                  })
                }
                disabled={disabled}
              />
            </Field>
            <Field label="Through (UTC)">
              <Input
                type="date"
                value={customWindow.endDate}
                onChange={(event) =>
                  onChange({
                    ...tier,
                    window: {
                      kind: "custom",
                      startDate: customWindow.startDate,
                      endDate: event.target.value,
                    },
                  })
                }
                disabled={disabled}
              />
            </Field>
          </div>
        ) : (
          <div className="hidden xl:block" />
        )}
        <Field label="Reward each ($)">
          <Input
            type="number"
            min={0.01}
            max={100}
            step="0.01"
            value={tier.rewardUsd}
            onChange={(event) =>
              onChange({ ...tier, rewardUsd: Number(event.target.value) })
            }
            disabled={disabled}
          />
        </Field>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3 rounded-lg border p-4">
      <div className="flex items-center gap-2">
        <span className="flex size-5 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">
          {n}
        </span>
        <h3 className="text-sm font-medium">{title}</h3>
      </div>
      {children}
    </section>
  );
}
function ModeCard({
  active,
  icon: Icon,
  title,
  hint,
  onClick,
  disabled,
}: {
  active: boolean;
  icon: typeof UserPlus;
  title: string;
  hint: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={cn(
        "flex items-start gap-2.5 rounded-lg border p-3 text-left transition-colors",
        active
          ? "border-primary/40 bg-primary/5"
          : "hover:bg-muted/50 disabled:opacity-60",
      )}
    >
      <Icon
        className={cn(
          "mt-0.5 size-4",
          active ? "text-primary" : "text-muted-foreground",
        )}
      />
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-[11px] text-muted-foreground">{hint}</span>
      </span>
    </button>
  );
}
function FilterSelect({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <Field label={label}>
      <Select value={value} onValueChange={(next) => onChange(next ?? ANY)}>
        <SelectTrigger className="w-full" disabled={disabled}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}
function CountTile({
  icon: Icon,
  label,
  value,
  accent,
}: {
  icon: typeof CheckCircle2;
  label: string;
  value: number;
  accent: string;
}) {
  return (
    <div className="rounded-md border p-3">
      <div className="flex items-center gap-1.5">
        <Icon className={`size-3.5 ${accent}`} />
        <span className="text-[11px] text-muted-foreground">{label}</span>
      </div>
      <p className={`mt-1 text-xl font-semibold tabular-nums ${accent}`}>
        {formatNumber(value)}
      </p>
    </div>
  );
}
