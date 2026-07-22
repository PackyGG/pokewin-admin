"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  CheckCircle2,
  CopyCheck,
  Filter,
  Play,
  RotateCcw,
  Ticket,
  TriangleAlert,
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
  BULK_MAX_ITEMS,
  REWARD_AUDIENCE_MAX,
  REWARD_MAX_VALUE_USD,
  validateCampaignSlug,
} from "@/lib/user-notification";
import { sendRewardCampaignChunkAction } from "./reward-actions";
import {
  resolveRewardAudienceAction,
  type AudienceFilters,
  type PickedUser,
} from "./audience-actions";
import { NotificationUserPicker } from "./notification-user-picker";

type Mode = "pick" | "filter";
type Failure = { chunkIndex: number; error: string };

type ChunkTotals = {
  requested: number;
  created: number;
  deduped: number;
  codesMinted: number;
  codesReused: number;
  unknown: string[];
};

const ANY = "__any__";

/**
 * Reward campaign composer.
 *
 * Recipients are chosen, never typed. The previous version asked the operator
 * to paste user ids into a textarea, which nobody is going to do for a
 * thousand-user campaign — so this offers the two ways the job is actually
 * thought about: name specific people, or describe a group. The group path
 * resolves through the same predicate builder the /users table renders from,
 * so the count on screen is the population that gets paid.
 *
 * Laid out as three steps rather than one wall of fields: who, what, send.
 * The money total is stated before the button, not after.
 */
export function RewardCampaignForm() {
  const [mode, setMode] = useState<Mode>("pick");
  const [picked, setPicked] = useState<PickedUser[]>([]);
  const [filters, setFilters] = useState<AudienceFilters>({});
  const [audience, setAudience] = useState<{
    count: number;
    sample: string[];
    truncated: boolean;
  } | null>(null);
  const [resolving, startResolving] = useTransition();
  const [stale, setStale] = useState(false);

  const [campaign, setCampaign] = useState("");
  const [amount, setAmount] = useState("5");
  const [expiresInDays, setExpiresInDays] = useState("");

  const [sending, setSending] = useState(false);
  const [currentChunk, setCurrentChunk] = useState(0);
  const [results, setResults] = useState<ChunkTotals[]>([]);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [sent, setSent] = useState<{
    chunks: string[][];
    campaign: string;
    valueUsd: number;
    expiresInDays: number | null;
  } | null>(null);

  // Re-resolve whenever the filter changes. The count has to track the
  // controls or the operator is reading a stale number right above a button
  // that spends money.
  //
  // Debounced because the affiliate-code field is free text: without this,
  // every keystroke fires a filtered scan over the users table. The dropdowns
  // pay the same 350ms, which is imperceptible next to the query itself.
  // `stale` covers the debounce window itself: for those 350ms the previous
  // count is still on screen, and without this the Send button would stay
  // enabled against a number that no longer matches the filters. Sending the
  // wrong population is a money mistake, so the button waits.
  useEffect(() => {
    if (mode !== "filter") return;
    setStale(true);
    const timer = setTimeout(() => {
      startResolving(async () => {
        const res = await resolveRewardAudienceAction(filters);
        if (!res.success) {
          setAudience(null);
          setStale(false);
          toast.error(res.error);
          return;
        }
        setAudience(res.audience);
        setStale(false);
      });
    }, 350);
    return () => clearTimeout(timer);
  }, [mode, filters]);

  const recipientIds = useMemo(
    () => (mode === "pick" ? picked.map((p) => p.id) : (audience?.sample ?? [])),
    [mode, picked, audience],
  );
  const recipientCount = recipientIds.length;

  const slugError = campaign.trim() ? validateCampaignSlug(campaign) : null;
  const valueUsd = Number(amount);
  const amountError =
    amount.trim() === ""
      ? "Amount is required"
      : !Number.isFinite(valueUsd) || valueUsd <= 0
        ? "Must be greater than zero"
        : valueUsd > REWARD_MAX_VALUE_USD
          ? `Capped at $${REWARD_MAX_VALUE_USD} per code`
          : null;

  const totals = useMemo(() => {
    const unknown = new Set<string>();
    const acc = { requested: 0, created: 0, deduped: 0, codesMinted: 0, codesReused: 0 };
    for (const r of results) {
      acc.requested += r.requested;
      acc.created += r.created;
      acc.deduped += r.deduped;
      acc.codesMinted += r.codesMinted;
      acc.codesReused += r.codesReused;
      for (const id of r.unknown) unknown.add(id);
    }
    return { ...acc, unknown: [...unknown] };
  }, [results]);

  const exposure = recipientCount * (Number.isFinite(valueUsd) ? valueUsd : 0);
  const chunks = useMemo(() => {
    const out: string[][] = [];
    for (let i = 0; i < recipientIds.length; i += BULK_MAX_ITEMS) {
      out.push(recipientIds.slice(i, i + BULK_MAX_ITEMS));
    }
    return out;
  }, [recipientIds]);

  const readyToSend =
    !sending &&
    !resolving &&
    !stale &&
    recipientCount > 0 &&
    !audience?.truncated &&
    !slugError &&
    !amountError &&
    campaign.trim() !== "";

  async function run(plan: NonNullable<typeof sent>, fromChunk: number) {
    setSending(true);
    setFailure(null);
    try {
      for (let i = fromChunk; i < plan.chunks.length; i++) {
        setCurrentChunk(i);
        const res = await sendRewardCampaignChunkAction({
          campaign: plan.campaign,
          valueUsd: plan.valueUsd,
          userIds: plan.chunks[i],
          expiresInDays: plan.expiresInDays,
          chunkIndex: i,
          chunkCount: plan.chunks.length,
        });
        if (!res.success) {
          setFailure({ chunkIndex: i, error: res.error });
          toast.error(`Batch ${i + 1} failed — retrying it is safe`);
          return;
        }
        setResults((prev) => [
          ...prev,
          {
            requested: res.requested,
            created: res.created,
            deduped: res.deduped,
            codesMinted: res.codesMinted,
            codesReused: res.codesReused,
            unknown: res.unknownUsers,
          },
        ]);
      }
      toast.success("Reward campaign sent");
    } finally {
      setSending(false);
    }
  }

  function handleStart() {
    if (chunks.length === 0) return;
    const days = Number(expiresInDays);
    const plan = {
      chunks,
      campaign: campaign.trim(),
      valueUsd,
      expiresInDays:
        expiresInDays.trim() !== "" && Number.isFinite(days) && days > 0 ? days : null,
    };
    setSent(plan);
    setResults([]);
    setCurrentChunk(0);
    void run(plan, 0);
  }

  const done = results.length;
  const total = sent?.chunks.length ?? chunks.length;
  const progressPct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <div className="space-y-4">
      {/* ── 1 · Who ────────────────────────────────────────────────── */}
      <Step n={1} title="Who gets it">
        <div className="grid gap-2 sm:grid-cols-2">
          <ModeCard
            active={mode === "pick"}
            icon={UserPlus}
            title="Pick users"
            hint="Search by name or email"
            onClick={() => setMode("pick")}
            disabled={sending}
          />
          <ModeCard
            active={mode === "filter"}
            icon={Filter}
            title="Match a group"
            hint="Everyone fitting a filter"
            onClick={() => setMode("filter")}
            disabled={sending}
          />
        </div>

        {mode === "pick" ? (
          <div className="space-y-2">
            <div className="sm:max-w-xs">
              <NotificationUserPicker
                disabled={sending}
                label="Search for a user…"
                onSelect={(u) =>
                  setPicked((cur) =>
                    cur.some((p) => p.id === u.id) ? cur : [...cur, u],
                  )
                }
              />
            </div>
            {picked.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">
                No one selected yet.
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {picked.map((u) => (
                  <span
                    key={u.id}
                    className="inline-flex items-center gap-1.5 rounded-full border bg-muted/40 py-1 pl-2.5 pr-1 text-xs"
                  >
                    {u.username ?? u.email ?? u.id}
                    <button
                      type="button"
                      disabled={sending}
                      onClick={() =>
                        setPicked((cur) => cur.filter((p) => p.id !== u.id))
                      }
                      className="rounded-full p-0.5 text-muted-foreground hover:text-rose-600"
                      aria-label={`Remove ${u.username ?? u.id}`}
                    >
                      <X className="size-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <div className="grid gap-2 sm:grid-cols-3">
              <FilterSelect
                label="Deposited"
                value={filters.deposited ?? ANY}
                disabled={sending}
                onChange={(v) =>
                  setFilters((f) => ({ ...f, deposited: v === ANY ? undefined : v }))
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
                onChange={(v) =>
                  setFilters((f) => ({ ...f, status: v === ANY ? undefined : v }))
                }
                options={[
                  { value: ANY, label: "Any" },
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
                  onChange={(e) =>
                    setFilters((f) => ({ ...f, affiliateCode: e.target.value }))
                  }
                  placeholder="any"
                  className="font-mono text-xs uppercase"
                  disabled={sending}
                />
              </div>
            </div>

            <div className="flex items-center gap-2 text-xs">
              {resolving || stale ? (
                <>
                  <Spinner size={13} label="Counting users" />
                  <span className="text-muted-foreground">
                    {audience
                      ? `Updating from ${formatNumber(audience.count)}…`
                      : "Counting…"}
                  </span>
                </>
              ) : audience ? (
                <span
                  className={
                    audience.truncated
                      ? "text-rose-600 dark:text-rose-400"
                      : "text-muted-foreground"
                  }
                >
                  <strong className="text-foreground">
                    {formatNumber(audience.count)}
                  </strong>{" "}
                  users match
                  {audience.truncated &&
                    ` — over the ${formatNumber(REWARD_AUDIENCE_MAX)} cap, narrow the filter`}
                </span>
              ) : null}
            </div>
            <p className="text-[11px] text-muted-foreground">
              Banned accounts and staff are always excluded.
            </p>
          </div>
        )}
      </Step>

      {/* ── 2 · What ───────────────────────────────────────────────── */}
      <Step n={2} title="What they get">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Amount each</Label>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                $
              </span>
              <Input
                type="number"
                min={0}
                max={REWARD_MAX_VALUE_USD}
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="pl-6 text-base font-semibold"
                disabled={sending}
              />
            </div>
            <p
              className={`text-[11px] ${amountError ? "text-rose-600 dark:text-rose-400" : "text-muted-foreground"}`}
            >
              {amountError ?? `Max $${REWARD_MAX_VALUE_USD} per code`}
            </p>
          </div>

          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Campaign name</Label>
            <Input
              value={campaign}
              onChange={(e) => setCampaign(e.target.value)}
              placeholder="summer_promo_2026"
              className="font-mono text-xs"
              disabled={sending}
            />
            <p
              className={`text-[11px] ${slugError ? "text-rose-600 dark:text-rose-400" : "text-muted-foreground"}`}
            >
              {slugError ?? "Keep it stable — reruns reuse the same codes"}
            </p>
          </div>

          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Expires in</Label>
            <div className="relative">
              <Input
                type="number"
                min={0}
                value={expiresInDays}
                onChange={(e) => setExpiresInDays(e.target.value)}
                placeholder="never"
                className="pr-12"
                disabled={sending}
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                days
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Empty = no expiry
            </p>
          </div>
        </div>
      </Step>

      {/* ── 3 · Send ───────────────────────────────────────────────── */}
      <Step n={3} title="Review &amp; send">
        <div className="rounded-lg border bg-muted/30 p-4">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
            <strong className="text-lg tabular-nums">
              {formatNumber(recipientCount)}
            </strong>
            <span className="text-muted-foreground">
              user{recipientCount === 1 ? "" : "s"} ×
            </span>
            <strong className="text-lg tabular-nums">
              {formatCurrency(Number.isFinite(valueUsd) ? valueUsd : 0)}
            </strong>
            <span className="text-muted-foreground">=</span>
            <strong className="text-lg tabular-nums text-rose-600 dark:text-rose-400">
              {formatCurrency(exposure)}
            </strong>
            <span className="text-xs text-muted-foreground">
              in single-use codes
            </span>
          </div>
          {total > 1 && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              Sent as {formatNumber(total)} batches of up to{" "}
              {formatNumber(BULK_MAX_ITEMS)}, one at a time.
            </p>
          )}
        </div>

        {recipientCount > 0 && !amountError && (
          <div className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <p className="text-xs text-amber-700 dark:text-amber-300">
              Each code is single-use and rejected for any account other than
              the one it was minted for. Re-running the same campaign name
              reuses codes instead of issuing new ones.
            </p>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={handleStart} disabled={!readyToSend} className="gap-1.5">
            <Play className="size-4" />
            {sending
              ? `Sending batch ${currentChunk + 1} of ${total}…`
              : `Send ${formatNumber(recipientCount)} reward${recipientCount === 1 ? "" : "s"}`}
          </Button>
          {failure && sent && (
            <Button
              variant="outline"
              onClick={() => void run(sent, failure.chunkIndex)}
              disabled={sending}
              className="gap-1.5"
            >
              <RotateCcw className="size-4" />
              Retry batch {failure.chunkIndex + 1}
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

        {(sending || results.length > 0) && total > 0 && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <span>
                Batch {Math.min(done + (sending ? 1 : 0), total)} of {total}
              </span>
              <span className="tabular-nums">{progressPct}%</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-foreground/70 transition-all duration-300"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>
        )}

        {failure && (
          <div className="space-y-1 rounded-md border border-rose-500/30 bg-rose-500/10 p-3">
            <p className="text-xs font-medium text-rose-700 dark:text-rose-300">
              Batch {failure.chunkIndex + 1} failed
            </p>
            <p className="text-xs text-rose-700/90 dark:text-rose-300/90">
              {failure.error}
            </p>
            <p className="text-[11px] text-rose-700/70 dark:text-rose-300/70">
              Retrying reuses any codes already minted — it can&apos;t pay twice.
            </p>
          </div>
        )}

        {results.length > 0 && (
          <div className="space-y-3 rounded-md border p-3">
            <p className="text-xs font-medium">
              {done} of {total} batch{total === 1 ? "" : "es"} ·{" "}
              {formatCurrency(totals.codesMinted * (sent?.valueUsd ?? 0))} newly
              issued
            </p>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <CountTile
                icon={Ticket}
                label="Codes minted"
                value={totals.codesMinted}
                accent="text-emerald-600 dark:text-emerald-400"
                hint="New single-use codes"
              />
              <CountTile
                icon={CopyCheck}
                label="Codes reused"
                value={totals.codesReused}
                accent="text-blue-600 dark:text-blue-400"
                hint="Existed from an earlier run"
              />
              <CountTile
                icon={CheckCircle2}
                label="Delivered"
                value={totals.created}
                accent="text-emerald-600 dark:text-emerald-400"
                hint="Notifications inserted"
              />
              <CountTile
                icon={UserX}
                label="Unknown"
                value={totals.unknown.length}
                accent="text-amber-600 dark:text-amber-400"
                hint="Ids that don't exist"
              />
            </div>
            {totals.deduped > 0 && (
              <p className="text-[11px] text-muted-foreground">
                {formatNumber(totals.deduped)} already delivered — normal on a
                rerun, not an error.
              </p>
            )}
          </div>
        )}
      </Step>
    </div>
  );
}

/** Numbered section — keeps the flow readable instead of one wall of fields. */
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
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">
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
          "mt-0.5 size-4 shrink-0",
          active ? "text-primary" : "text-muted-foreground",
        )}
      />
      <span className="min-w-0">
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
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {/* base-ui hands back `string | null`; a null clear would blank the
          control, so it falls through to "any" rather than undefined. */}
      <Select
        value={value}
        onValueChange={(v: string | null) => onChange(v ?? ANY)}
      >
        <SelectTrigger className="w-full" disabled={disabled}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function CountTile({
  icon: Icon,
  label,
  value,
  accent,
  hint,
}: {
  icon: typeof CheckCircle2;
  label: string;
  value: number;
  accent: string;
  hint: string;
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
      <p className="mt-0.5 text-[10px] text-muted-foreground">{hint}</p>
    </div>
  );
}
