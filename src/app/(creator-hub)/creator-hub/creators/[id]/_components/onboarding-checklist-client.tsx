"use client";

import { useState, useTransition } from "react";
import {
  Check,
  ChevronDown,
  ClipboardList,
  ExternalLink,
  Loader2,
  Lock,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

import type {
  ChecklistItem,
  CreatorChecklistData,
  ManualToggleField,
} from "./onboarding-checklist-shared";
import {
  setChecklistGiveawayUrl,
  setChecklistLbPrepaidProof,
  setChecklistToggle,
} from "./onboarding-checklist-actions";

/**
 * Per-creator Onboarding Checklist — interactive client panel.
 *
 * Rendered inside the server `<CreatorChecklist>` wrapper, which only mounts it
 * when the checklist is NOT yet complete (auto-hide lives on the server). The
 * owner wants this panel to be the MOST prominent item in the right rail, so it
 * styles as an accent-emphasised, expanded-by-default dock (solid card
 * background, primary ring) — louder than the live/recent docks.
 *
 * AUTO items are read-only (a lock chip explains they complete elsewhere).
 * MANUAL items carry a Switch; the giveaway item adds a URL input, and the
 * leaderboard-funds item nests a prepaid coin + TX-link proof. Every write goes
 * through a manager-gated server action (`onboarding-checklist-actions.ts`) with
 * the house try/catch + `sonner` toast pattern.
 *
 * Only serializable data crosses the boundary — the server passes the resolved
 * {@link CreatorChecklistData}; no function props.
 */
export function OnboardingChecklistPanel({
  data,
}: {
  data: CreatorChecklistData;
}) {
  const [open, setOpen] = useState(true);
  const pct =
    data.totalCount > 0
      ? Math.round((data.doneCount / data.totalCount) * 100)
      : 0;

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn(
        "overflow-hidden rounded-xl border border-primary/30 bg-card",
        "shadow-md ring-1 ring-inset ring-primary/10",
      )}
    >
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-center gap-3 px-3.5 py-3 text-left outline-none",
          "transition-colors hover:bg-primary/[0.06] focus-visible:bg-primary/[0.06]",
        )}
      >
        <div className="grid size-8 shrink-0 place-items-center rounded-lg border border-primary/30 bg-primary/15 text-primary shadow-sm">
          <ClipboardList className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold tracking-tight">
              Onboarding checklist
            </span>
            <Sparkles className="size-3.5 shrink-0 text-primary" />
          </div>
          <p className="truncate text-[11px] text-muted-foreground">
            {data.doneCount} of {data.totalCount} steps done
            {data.partial ? " · refreshing" : ""}
          </p>
        </div>
        <span className="shrink-0 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-primary">
          {data.doneCount}/{data.totalCount}
        </span>
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
            open && "rotate-180",
          )}
        />
      </CollapsibleTrigger>

      {/* Progress bar — always visible (even when collapsed) so the dock reads
          at a glance. */}
      <div className="px-3.5 pb-2">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-primary/10">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-500 motion-reduce:transition-none"
            style={{ width: `${pct}%` }}
            role="progressbar"
            aria-valuenow={data.doneCount}
            aria-valuemin={0}
            aria-valuemax={data.totalCount}
            aria-label="Onboarding progress"
          />
        </div>
      </div>

      <CollapsibleContent>
        <div className="space-y-1.5 px-2.5 pb-3 pt-0.5">
          {data.items.map((item) => (
            <ChecklistRow
              key={item.id}
              item={item}
              targetUserId={data.targetUserId}
              manual={data.manual}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ─── One checklist row ──────────────────────────────────────────────

function ChecklistRow({
  item,
  targetUserId,
  manual,
}: {
  item: ChecklistItem;
  targetUserId: string;
  manual: CreatorChecklistData["manual"];
}) {
  return (
    <div
      className={cn(
        "rounded-lg border px-2.5 py-2 transition-colors",
        item.done
          ? "border-emerald-500/25 bg-emerald-500/10"
          : "border-border/60 bg-muted",
      )}
    >
      <div className="flex items-center gap-2.5">
        <StatusDot done={item.done} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span
              className={cn(
                "truncate text-[13px] font-medium",
                item.done && "text-emerald-600 dark:text-emerald-400",
              )}
            >
              {item.label}
            </span>
            {item.kind === "auto" && (
              <span
                className="inline-flex shrink-0 items-center gap-0.5 rounded border border-border/60 bg-background/60 px-1 py-px text-[9px] font-medium uppercase tracking-wide text-muted-foreground"
                title="Completed automatically from live data"
              >
                <Lock className="size-2.5" />
                Auto
              </span>
            )}
          </div>
          <p className="truncate text-[11px] text-muted-foreground">
            {item.detail ?? item.hint}
          </p>
        </div>

        {item.kind === "manual" && (
          <ManualToggle
            targetUserId={targetUserId}
            field={toggleFieldFor(item.id)}
            checked={item.done}
          />
        )}
      </div>

      {/* Giveaway URL input nests under the giveaway item. */}
      {item.id === "twitter_giveaway" && (
        <GiveawayUrlInput
          targetUserId={targetUserId}
          initialUrl={manual.twitterGiveawayUrl}
        />
      )}

      {/* Prepaid coin + TX proof nests under the leaderboard-funds item
          (owner: placed directly below the leaderboard item). */}
      {item.id === "lb_funds_collected" && (
        <LbPrepaidProofInputs
          targetUserId={targetUserId}
          initialCoin={manual.lbPrepaidCoin}
          initialTxUrl={manual.lbPrepaidTxUrl}
        />
      )}
    </div>
  );
}

function StatusDot({ done }: { done: boolean }) {
  return (
    <span
      className={cn(
        "grid size-5 shrink-0 place-items-center rounded-full border",
        done
          ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
          : "border-border bg-background text-transparent",
      )}
      aria-hidden
    >
      <Check className="size-3" strokeWidth={3} />
    </span>
  );
}

// ─── Manual toggle (Switch) ─────────────────────────────────────────

function ManualToggle({
  targetUserId,
  field,
  checked,
}: {
  targetUserId: string;
  field: ManualToggleField;
  checked: boolean;
}) {
  const [pending, startTransition] = useTransition();

  function onChange(next: boolean) {
    startTransition(async () => {
      try {
        const res = await setChecklistToggle(targetUserId, field, next);
        if (!res.success) {
          toast.error(res.error);
          return;
        }
        toast.success(next ? "Marked done" : "Marked not done");
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Could not update item",
        );
      }
    });
  }

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {pending && (
        <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
      )}
      <Switch
        size="sm"
        checked={checked}
        onCheckedChange={onChange}
        disabled={pending}
        aria-label="Toggle checklist item"
      />
    </div>
  );
}

// ─── Giveaway URL input ─────────────────────────────────────────────

function GiveawayUrlInput({
  targetUserId,
  initialUrl,
}: {
  targetUserId: string;
  initialUrl: string | null;
}) {
  const [value, setValue] = useState(initialUrl ?? "");
  const [pending, startTransition] = useTransition();
  const dirty = value.trim() !== (initialUrl ?? "");

  function save() {
    startTransition(async () => {
      try {
        const res = await setChecklistGiveawayUrl(targetUserId, value.trim());
        if (!res.success) {
          toast.error(res.error);
          return;
        }
        toast.success("Giveaway link saved");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not save link");
      }
    });
  }

  return (
    <div className="mt-2 flex items-center gap-1.5 pl-7">
      <Input
        type="url"
        inputMode="url"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Giveaway tweet URL"
        className="h-7 text-xs"
        disabled={pending}
      />
      {initialUrl && (
        <a
          href={initialUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="grid size-7 shrink-0 place-items-center rounded-md border border-border/60 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title="Open giveaway"
        >
          <ExternalLink className="size-3.5" />
        </a>
      )}
      <Button
        type="button"
        size="xs"
        variant="secondary"
        onClick={save}
        disabled={pending || !dirty}
        className="shrink-0"
      >
        {pending ? <Loader2 className="size-3 animate-spin" /> : "Save"}
      </Button>
    </div>
  );
}

// ─── Leaderboard prepaid proof (coin + TX link) ─────────────────────

function LbPrepaidProofInputs({
  targetUserId,
  initialCoin,
  initialTxUrl,
}: {
  targetUserId: string;
  initialCoin: string | null;
  initialTxUrl: string | null;
}) {
  const [coin, setCoin] = useState(initialCoin ?? "");
  const [txUrl, setTxUrl] = useState(initialTxUrl ?? "");
  const [pending, startTransition] = useTransition();
  const dirty =
    coin.trim() !== (initialCoin ?? "") || txUrl.trim() !== (initialTxUrl ?? "");

  function save() {
    startTransition(async () => {
      try {
        const res = await setChecklistLbPrepaidProof(
          targetUserId,
          coin.trim(),
          txUrl.trim(),
        );
        if (!res.success) {
          toast.error(res.error);
          return;
        }
        toast.success("Prepaid proof saved");
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Could not save proof",
        );
      }
    });
  }

  return (
    <div className="mt-2 space-y-1.5 pl-7">
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Prepaid proof
      </p>
      <div className="flex items-center gap-1.5">
        <Input
          value={coin}
          onChange={(e) => setCoin(e.target.value)}
          placeholder="Coin (e.g. USDT)"
          className="h-7 w-28 shrink-0 text-xs"
          disabled={pending}
        />
        <Input
          type="url"
          inputMode="url"
          value={txUrl}
          onChange={(e) => setTxUrl(e.target.value)}
          placeholder="Explorer TX link"
          className="h-7 text-xs"
          disabled={pending}
        />
        {initialTxUrl && (
          <a
            href={initialTxUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="grid size-7 shrink-0 place-items-center rounded-md border border-border/60 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title="Open transaction"
          >
            <ExternalLink className="size-3.5" />
          </a>
        )}
        <Button
          type="button"
          size="xs"
          variant="secondary"
          onClick={save}
          disabled={pending || !dirty}
          className="shrink-0"
        >
          {pending ? <Loader2 className="size-3 animate-spin" /> : "Save"}
        </Button>
      </div>
    </div>
  );
}

// ─── id → manual toggle field ───────────────────────────────────────

/**
 * Map a manual item id to its server toggle field. Only the three manual
 * boolean items reach this (AUTO items render no Switch); an unexpected id
 * throws so a future manual item without a mapping fails loudly in dev rather
 * than silently writing the wrong column.
 */
function toggleFieldFor(id: ChecklistItem["id"]): ManualToggleField {
  switch (id) {
    case "twitter_giveaway":
      return "twitter_giveaway";
    case "streaming_assets":
      return "streaming_assets";
    case "lb_funds_collected":
      return "lb_funds_collected";
    default:
      throw new Error(`No manual toggle field for checklist item "${id}"`);
  }
}
