"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  BadgeCheck,
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleX,
  Loader2,
  Play,
  ScanSearch,
  ShieldOff,
  Users,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { SectionHeading } from "@/components/modern-panels";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  DEFAULT_MIN_ACCOUNT_AGE_DAYS,
  FIAT_PERK_SCOPES,
  FIAT_PERK_SCOPE_LABELS,
  MAX_PERK_RUN_ACCOUNTS,
  type FiatPerkCandidate,
  type FiatPerkCheck,
  type FiatPerkGrant,
  type FiatPerkRun,
  type FiatPerkScope,
} from "@/lib/antifraud/fiat-perks-contract";
import { formatRelative } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import {
  decidePerkCandidate,
  revokePerkGrant,
  startPerkScreeningRun,
} from "./actions";

/** How often a still-running sweep re-reads its progress. */
const RUN_POLL_MS = 4_000;

type Filters = {
  verdict: "pass" | "review" | "fail" | null;
  decision: "pending" | "approved" | "declined" | null;
  search: string;
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

const VERDICT_STYLES: Record<
  FiatPerkCandidate["verdict"],
  { label: string; className: string; icon: React.ElementType }
> = {
  pass: {
    label: "Clears every check",
    className:
      "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    icon: CircleCheck,
  },
  review: {
    label: "Needs a human call",
    className:
      "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
    icon: CircleAlert,
  },
  fail: {
    label: "Blocked by a rule",
    className:
      "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-400",
    icon: CircleX,
  },
};

const CHECK_STYLES: Record<FiatPerkCheck["status"], string> = {
  pass: "text-emerald-600 dark:text-emerald-400",
  warn: "text-amber-600 dark:text-amber-400",
  fail: "text-rose-600 dark:text-rose-400",
};

const CHECK_ICONS: Record<FiatPerkCheck["status"], React.ElementType> = {
  pass: CircleCheck,
  warn: CircleAlert,
  fail: CircleX,
};

export function FiatPerksClient({
  runs,
  selectedRunId,
  candidates,
  grants,
  filters,
  readOnly,
}: {
  runs: FiatPerkRun[];
  selectedRunId: string | null;
  candidates: FiatPerkCandidate[];
  grants: FiatPerkGrant[];
  filters: Filters;
  readOnly: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? null;

  // A sweep finishes server-side. Poll only while one is actually running, and
  // stop the moment it is not — an idle workspace must not keep refetching.
  const running = selectedRun?.status === "running"
    || runs.some((run) => run.status === "running");
  React.useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => router.refresh(), RUN_POLL_MS);
    return () => window.clearInterval(timer);
  }, [running, router]);

  const setParam = React.useCallback(
    (updates: Record<string, string | null>) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value === null || value === "") next.delete(key);
        else next.set(key, value);
      }
      const query = next.toString();
      router.replace(query ? `?${query}` : "?", { scroll: false });
    },
    [router, searchParams],
  );

  return (
    <div className="space-y-4">
      <ScreeningForm disabled={readOnly} />
      <RunHistory
        runs={runs}
        selectedRunId={selectedRunId}
        onSelect={(runId) => setParam({ run: runId, q: null })}
      />
      <ReviewQueue
        run={selectedRun}
        candidates={candidates}
        filters={filters}
        disabled={readOnly}
        onFilter={setParam}
      />
      <GrantList grants={grants} disabled={readOnly} />
    </div>
  );
}

function ScreeningForm({ disabled }: { disabled: boolean }) {
  const router = useRouter();
  const [scope, setScope] = React.useState<FiatPerkScope>("all");
  const [minAge, setMinAge] = React.useState(
    String(DEFAULT_MIN_ACCOUNT_AGE_DAYS),
  );
  const [limit, setLimit] = React.useState("200");
  const [countryCode, setCountryCode] = React.useState("");
  const [activeWithinDays, setActiveWithinDays] = React.useState("30");
  const [excludeGranted, setExcludeGranted] = React.useState(true);
  const [pending, setPending] = React.useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (pending || disabled) return;
    setPending(true);
    try {
      const run = await startPerkScreeningRun({
        scope,
        minAccountAgeDays: Number(minAge),
        limit: Number(limit),
        countryCode: scope === "country" ? countryCode.trim() : null,
        activeWithinDays: Number(activeWithinDays),
        excludeGranted,
        idempotencyKey: crypto.randomUUID(),
      });
      toast.success(
        `Screening ${run.scopeLabel.toLowerCase()} — results appear as they land.`,
      );
      router.replace(`?run=${run.id}`, { scroll: false });
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error, "The screening run could not start."));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="space-y-3">
      <SectionHeading
        icon={ScanSearch}
        title={
          <>
            Screen a scope
            <span className="text-xs font-normal text-muted-foreground">
              Pick who to look at, then review the results one by one.
            </span>
          </>
        }
      />
      <form
        onSubmit={submit}
        className="rounded-xl border border-border/70 bg-card p-4"
      >
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <div className="space-y-1.5">
            <Label htmlFor="perk-scope">Scope</Label>
            <Select
              value={scope}
              onValueChange={(value) => setScope(value as FiatPerkScope)}
            >
              <SelectTrigger id="perk-scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FIAT_PERK_SCOPES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {FIAT_PERK_SCOPE_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="perk-min-age">Minimum account age (days)</Label>
            <Input
              id="perk-min-age"
              type="number"
              min={0}
              max={3650}
              value={minAge}
              onChange={(event) => setMinAge(event.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="perk-limit">Accounts to screen</Label>
            <Input
              id="perk-limit"
              type="number"
              min={1}
              max={MAX_PERK_RUN_ACCOUNTS}
              value={limit}
              onChange={(event) => setLimit(event.target.value)}
            />
          </div>

          {scope === "country" ? (
            <div className="space-y-1.5">
              <Label htmlFor="perk-country">Country code</Label>
              <Input
                id="perk-country"
                placeholder="DE"
                maxLength={2}
                value={countryCode}
                onChange={(event) =>
                  setCountryCode(event.target.value.toUpperCase())}
              />
            </div>
          ) : scope === "active_players" ? (
            <div className="space-y-1.5">
              <Label htmlFor="perk-active">Played within (days)</Label>
              <Input
                id="perk-active"
                type="number"
                min={1}
                max={365}
                value={activeWithinDays}
                onChange={(event) => setActiveWithinDays(event.target.value)}
              />
            </div>
          ) : (
            <div className="hidden xl:block" aria-hidden />
          )}
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-4 border-t border-border/60 pt-4">
          <label className="flex items-center gap-3 text-sm">
            <Switch
              checked={excludeGranted}
              onCheckedChange={setExcludeGranted}
              aria-label="Skip accounts that already hold a perk"
            />
            <span className="text-muted-foreground">
              Skip accounts that already hold a perk
            </span>
          </label>
          <Button type="submit" disabled={pending || disabled}>
            {pending
              ? <Loader2 className="size-4 animate-spin" aria-hidden />
              : <Play className="size-4" aria-hidden />}
            Run screening
          </Button>
        </div>
      </form>
    </section>
  );
}

function RunHistory({
  runs,
  selectedRunId,
  onSelect,
}: {
  runs: FiatPerkRun[];
  selectedRunId: string | null;
  onSelect: (runId: string) => void;
}) {
  if (runs.length === 0) return null;
  return (
    <section className="space-y-3">
      <SectionHeading icon={Users} title="Runs" />
      <div className="flex gap-2 overflow-x-auto pb-1">
        {runs.map((run) => {
          const active = run.id === selectedRunId;
          return (
            <button
              key={run.id}
              type="button"
              onClick={() => onSelect(run.id)}
              aria-current={active ? "true" : undefined}
              className={cn(
                "min-w-56 shrink-0 rounded-xl border px-3 py-2.5 text-left motion-safe:transition-colors",
                active
                  ? "border-cyan-500/40 bg-cyan-500/5"
                  : "border-border/70 bg-card hover:bg-accent/40",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium">
                  {run.scopeLabel}
                </span>
                {run.status === "running" && (
                  <Loader2
                    className="size-3.5 shrink-0 animate-spin text-cyan-500"
                    aria-label="Running"
                  />
                )}
                {run.status === "failed" && (
                  <Badge
                    variant="outline"
                    className="border-rose-500/30 text-[10px] text-rose-600 dark:text-rose-400"
                  >
                    failed
                  </Badge>
                )}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {run.candidateCount} screened · {run.pendingCount} undecided
              </p>
              <p className="text-xs text-muted-foreground">
                {formatRelative(new Date(run.createdAt))}
              </p>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function ReviewQueue({
  run,
  candidates,
  filters,
  disabled,
  onFilter,
}: {
  run: FiatPerkRun | null;
  candidates: FiatPerkCandidate[];
  filters: Filters;
  disabled: boolean;
  onFilter: (updates: Record<string, string | null>) => void;
}) {
  const [search, setSearch] = React.useState(filters.search);
  React.useEffect(() => setSearch(filters.search), [filters.search]);

  return (
    <section className="space-y-3">
      <SectionHeading
        icon={BadgeCheck}
        title={
          <>
            Review queue
            {run && (
              <span className="text-xs font-normal text-muted-foreground">
                {run.scopeLabel} · {run.passCount} clear · {run.reviewCount}{" "}
                borderline · {run.failCount} blocked
                {run.providerChecks > 0
                  ? ` · ${run.providerChecks} identity lookups`
                  : ""}
              </span>
            )}
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <FilterChips
          value={filters.verdict}
          options={[
            ["pass", "Clear"],
            ["review", "Borderline"],
            ["fail", "Blocked"],
          ]}
          onChange={(value) => onFilter({ verdict: value })}
        />
        <FilterChips
          value={filters.decision}
          options={[
            ["pending", "Undecided"],
            ["approved", "Approved"],
            ["declined", "Declined"],
          ]}
          onChange={(value) => onFilter({ decision: value })}
        />
        <form
          className="ml-auto"
          onSubmit={(event) => {
            event.preventDefault();
            onFilter({ q: search.trim() || null });
          }}
        >
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search user, name or email"
            className="h-9 w-56"
            aria-label="Search screened accounts"
          />
        </form>
      </div>

      {candidates.length === 0
        ? (
          <p className="rounded-xl border border-border/70 bg-card px-4 py-8 text-center text-sm text-muted-foreground">
            {run
              ? run.status === "running"
                ? "The sweep is still running. Results appear here as they land."
                : "No screened account matches these filters."
              : "Run a screening sweep to build a review queue."}
          </p>
        )
        : (
          <div className="space-y-2">
            {candidates.map((candidate) => (
              <CandidateRow
                key={candidate.id}
                candidate={candidate}
                disabled={disabled}
              />
            ))}
          </div>
        )}
    </section>
  );
}

function FilterChips<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T | null;
  options: ReadonlyArray<readonly [T, string]>;
  onChange: (value: T | null) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      {options.map(([key, label]) => {
        const active = value === key;
        return (
          <button
            key={key}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(active ? null : key)}
            className={cn(
              "rounded-lg border px-2.5 py-1 text-xs motion-safe:transition-colors",
              active
                ? "border-cyan-500/40 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300"
                : "border-border/70 bg-card text-muted-foreground hover:bg-accent/40",
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

function CandidateRow({
  candidate,
  disabled,
}: {
  candidate: FiatPerkCandidate;
  disabled: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [pending, setPending] = React.useState<"approved" | "declined" | null>(
    null,
  );
  const verdict = VERDICT_STYLES[candidate.verdict];
  const VerdictIcon = verdict.icon;
  const decided = candidate.decision !== "pending";

  async function decide(decision: "approved" | "declined") {
    if (pending || disabled) return;
    setPending(decision);
    try {
      await decidePerkCandidate({
        candidateId: candidate.id,
        decision,
        note: null,
        idempotencyKey: crypto.randomUUID(),
      });
      toast.success(
        decision === "approved"
          ? `${candidate.username ?? candidate.userId} can use card deposits.`
          : `${candidate.username ?? candidate.userId} stays off card deposits.`,
      );
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error, "The decision could not be saved."));
    } finally {
      setPending(null);
    }
  }

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="overflow-hidden rounded-xl border border-border/70 bg-card"
    >
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium">
              {candidate.username ?? candidate.userId}
            </span>
            <Badge
              variant="outline"
              className={cn("text-[10px]", verdict.className)}
            >
              <VerdictIcon className="size-3" aria-hidden />
              {verdict.label}
            </Badge>
            {candidate.countryCode && (
              <Badge variant="outline" className="text-[10px]">
                {candidate.countryCode}
              </Badge>
            )}
            {decided && (
              <Badge
                variant="outline"
                className={cn(
                  "text-[10px]",
                  candidate.decision === "approved"
                    ? "border-emerald-500/30 text-emerald-700 dark:text-emerald-400"
                    : "border-muted-foreground/30 text-muted-foreground",
                )}
              >
                {candidate.decision}
                {candidate.decidedByUsername
                  ? ` · ${candidate.decidedByUsername}`
                  : ""}
              </Badge>
            )}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {candidate.accountAgeDays.toFixed(0)} days old
            {candidate.email ? ` · ${candidate.email}` : ""}
            {candidate.providerChecked ? " · identity checked" : ""}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <span
            className="text-sm font-medium tabular-nums text-muted-foreground"
            title="Screening risk score"
          >
            {candidate.riskScore}
          </span>
          {!decided && (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={disabled || pending !== null}
                onClick={() => decide("approved")}
              >
                {pending === "approved"
                  ? <Loader2 className="size-4 animate-spin" aria-hidden />
                  : <Check className="size-4" aria-hidden />}
                Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={disabled || pending !== null}
                onClick={() => decide("declined")}
              >
                {pending === "declined"
                  ? <Loader2 className="size-4 animate-spin" aria-hidden />
                  : <X className="size-4" aria-hidden />}
                Decline
              </Button>
            </>
          )}
          <CollapsibleTrigger
            className="rounded-md p-1.5 text-muted-foreground hover:bg-accent/40"
            aria-label={open ? "Hide evidence" : "Show evidence"}
          >
            <ChevronDown
              className={cn(
                "size-4 motion-safe:transition-transform",
                open && "rotate-180",
              )}
              aria-hidden
            />
          </CollapsibleTrigger>
        </div>
      </div>

      <CollapsibleContent>
        <div className="border-t border-border/60 px-4 py-3">
          <ul className="grid gap-x-6 gap-y-1.5 md:grid-cols-2">
            {candidate.checks.map((check) => {
              const Icon = CHECK_ICONS[check.status];
              return (
                <li key={check.key} className="flex gap-2 text-xs">
                  <Icon
                    className={cn(
                      "mt-0.5 size-3.5 shrink-0",
                      CHECK_STYLES[check.status],
                    )}
                    aria-hidden
                  />
                  <span className="min-w-0">
                    <span className="font-medium">{check.label}</span>
                    <span className="text-muted-foreground">
                      {" — "}
                      {check.detail}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
          {candidate.evidence.lastKnownIp && (
            <p className="mt-3 font-mono text-[11px] text-muted-foreground">
              last known IP {candidate.evidence.lastKnownIp}
              {candidate.evidence.visitorId
                ? ` · device ${candidate.evidence.visitorId}`
                : ""}
            </p>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function GrantList({
  grants,
  disabled,
}: {
  grants: FiatPerkGrant[];
  disabled: boolean;
}) {
  const router = useRouter();
  const [pendingUser, setPendingUser] = React.useState<string | null>(null);

  async function revoke(grant: FiatPerkGrant) {
    if (pendingUser || disabled) return;
    const reason = window.prompt(
      `Why is the Fiat perk for ${grant.username ?? grant.userId} being revoked?`,
    );
    if (reason === null) return;
    if (reason.trim().length < 4) {
      toast.error("Give a reason of at least 4 characters.");
      return;
    }
    setPendingUser(grant.userId);
    try {
      await revokePerkGrant({
        userId: grant.userId,
        reason: reason.trim(),
        idempotencyKey: crypto.randomUUID(),
      });
      toast.success(
        `${grant.username ?? grant.userId} can no longer use card deposits.`,
      );
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error, "The perk could not be revoked."));
    } finally {
      setPendingUser(null);
    }
  }

  return (
    <section className="space-y-3">
      <SectionHeading
        icon={ShieldOff}
        title={
          <>
            Accounts with card deposits
            <span className="text-xs font-normal text-muted-foreground">
              {grants.length} live perk{grants.length === 1 ? "" : "s"}
            </span>
          </>
        }
      />
      {grants.length === 0
        ? (
          <p className="rounded-xl border border-border/70 bg-card px-4 py-8 text-center text-sm text-muted-foreground">
            No account holds a Fiat perk yet.
          </p>
        )
        : (
          <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70 bg-card">
            {grants.map((grant) => (
              <div
                key={grant.userId}
                className="flex flex-wrap items-center gap-3 px-4 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {grant.username ?? grant.userId}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    approved
                    {grant.grantedByUsername
                      ? ` by ${grant.grantedByUsername}`
                      : ""}
                    {grant.grantedAt
                      ? ` · ${formatRelative(new Date(grant.grantedAt))}`
                      : ""}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={disabled || pendingUser !== null}
                  onClick={() => revoke(grant)}
                >
                  {pendingUser === grant.userId
                    ? <Loader2 className="size-4 animate-spin" aria-hidden />
                    : <ShieldOff className="size-4" aria-hidden />}
                  Revoke
                </Button>
              </div>
            ))}
          </div>
        )}
    </section>
  );
}
