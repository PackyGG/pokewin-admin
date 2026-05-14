"use client";

import { useId, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { Loader2, Pencil, Plus } from "lucide-react";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import type {
  MultiplierDealResponse,
  UpdateMultiplierDealInput,
} from "@/lib/backend-api";

import {
  createMultiplierDeal,
  updateMultiplierDeal,
} from "../../multiplier-actions";

type Props =
  | {
      userId: string;
      mode?: "create";
      deal?: undefined;
      trigger?: React.ReactNode;
    }
  | {
      userId: string;
      mode: "edit";
      deal: MultiplierDealResponse;
      trigger?: React.ReactNode;
    };

/**
 * Form state mirrors the backend's `CreateMultiplierDealInput` plus
 * convenience versions of the bps fields as decimal % strings (which is
 * what humans type) — converted back to bps on submit.
 *
 * Edit mode pre-fills from the existing deal row; only pending_deposit
 * status is editable (enforced backend-side too).
 */
type FormState = {
  required_deposit_usd: string;
  // multiplier_x: how many "x"s. 5 → multiplier_bps=50000 on submit.
  multiplier_x: string;
  // withdrawable %: 20 → withdrawable_bps=2000.
  withdrawable_pct: string;
  // wager req %: 100 → wager_requirement_bps=10000.
  wager_req_pct: string;
  // Caps — empty string = uncapped (sent as null).
  max_total_wager_usd: string;
  max_payout_usd: string;
  // Activity floor.
  min_session_duration_seconds: string;
  min_bet_count: string;
  min_wager_to_funding_ratio_pct: string;
  kick_vod_required: boolean;
  terms_text: string;
  terms_version: string;
};

const buildCreateDefaults = (): FormState => ({
  required_deposit_usd: "200",
  multiplier_x: "5",
  withdrawable_pct: "20",
  wager_req_pct: "100",
  max_total_wager_usd: "",
  max_payout_usd: "",
  min_session_duration_seconds: "1800",
  min_bet_count: "20",
  min_wager_to_funding_ratio_pct: "50",
  kick_vod_required: true,
  terms_text:
    "Growth Program Agreement v1.0\n\n" +
    "1. Activating this deal locks your deposit into the program.\n" +
    "2. Your spendable balance is inflated by the multiplier for the stream.\n" +
    "3. At end-of-stream, only the configured percentage is withdrawable, " +
    "and only after admin review.\n" +
    "4. You must wager at least the configured fraction of your loaded " +
    "balance to unlock payout.\n" +
    "5. Abuse of the program (low duration, missing VOD, suspicious " +
    "wager patterns) may result in deal rejection and forfeiture of funds.\n",
  terms_version: "v1.0",
});

const buildEditDefaults = (deal: MultiplierDealResponse): FormState => ({
  required_deposit_usd: String(deal.required_deposit_usd),
  multiplier_x: (deal.multiplier_bps / 10000).toString(),
  withdrawable_pct: (deal.withdrawable_bps / 100).toString(),
  wager_req_pct: (deal.wager_requirement_bps / 100).toString(),
  max_total_wager_usd: deal.max_total_wager_usd ?? "",
  max_payout_usd: deal.max_payout_usd ?? "",
  min_session_duration_seconds: String(deal.min_session_duration_seconds),
  min_bet_count: String(deal.min_bet_count),
  min_wager_to_funding_ratio_pct: (
    deal.min_wager_to_funding_ratio_bps / 100
  ).toString(),
  kick_vod_required: deal.kick_vod_required,
  terms_text: deal.terms_text,
  terms_version: deal.terms_version,
});

/**
 * Diff patch builder — only sends fields that actually changed so the
 * backend audit log doesn't fill with no-op entries.
 */
function computePatch(
  form: FormState,
  deal: MultiplierDealResponse,
): UpdateMultiplierDealInput["patch"] {
  const patch: UpdateMultiplierDealInput["patch"] = {};

  const requiredDeposit = parseFloat(form.required_deposit_usd);
  if (
    Number.isFinite(requiredDeposit) &&
    requiredDeposit !== Number(deal.required_deposit_usd)
  ) {
    patch.required_deposit_usd = requiredDeposit;
  }

  const multiplierBps = Math.round(parseFloat(form.multiplier_x) * 10000);
  if (
    Number.isFinite(multiplierBps) &&
    multiplierBps !== deal.multiplier_bps
  ) {
    patch.multiplier_bps = multiplierBps;
  }

  const withdrawableBps = Math.round(
    parseFloat(form.withdrawable_pct) * 100,
  );
  if (
    Number.isFinite(withdrawableBps) &&
    withdrawableBps !== deal.withdrawable_bps
  ) {
    patch.withdrawable_bps = withdrawableBps;
  }

  const wagerReqBps = Math.round(parseFloat(form.wager_req_pct) * 100);
  if (
    Number.isFinite(wagerReqBps) &&
    wagerReqBps !== deal.wager_requirement_bps
  ) {
    patch.wager_requirement_bps = wagerReqBps;
  }

  // null ⇄ value transitions matter — explicit null sends.
  const totalWagerTrim = form.max_total_wager_usd.trim();
  const formTotalWager =
    totalWagerTrim === "" ? null : parseFloat(totalWagerTrim);
  const dealTotalWager = deal.max_total_wager_usd
    ? Number(deal.max_total_wager_usd)
    : null;
  if (formTotalWager === null && dealTotalWager !== null) {
    patch.max_total_wager_usd = null;
  } else if (
    formTotalWager !== null &&
    Number.isFinite(formTotalWager) &&
    (dealTotalWager === null || formTotalWager !== dealTotalWager)
  ) {
    patch.max_total_wager_usd = formTotalWager;
  }

  const payoutTrim = form.max_payout_usd.trim();
  const formPayout = payoutTrim === "" ? null : parseFloat(payoutTrim);
  const dealPayout = deal.max_payout_usd
    ? Number(deal.max_payout_usd)
    : null;
  if (formPayout === null && dealPayout !== null) {
    patch.max_payout_usd = null;
  } else if (
    formPayout !== null &&
    Number.isFinite(formPayout) &&
    (dealPayout === null || formPayout !== dealPayout)
  ) {
    patch.max_payout_usd = formPayout;
  }

  const minDuration = parseInt(form.min_session_duration_seconds, 10);
  if (
    Number.isFinite(minDuration) &&
    minDuration !== deal.min_session_duration_seconds
  ) {
    patch.min_session_duration_seconds = minDuration;
  }

  const minBet = parseInt(form.min_bet_count, 10);
  if (Number.isFinite(minBet) && minBet !== deal.min_bet_count) {
    patch.min_bet_count = minBet;
  }

  const minWagerRatioBps = Math.round(
    parseFloat(form.min_wager_to_funding_ratio_pct) * 100,
  );
  if (
    Number.isFinite(minWagerRatioBps) &&
    minWagerRatioBps !== deal.min_wager_to_funding_ratio_bps
  ) {
    patch.min_wager_to_funding_ratio_bps = minWagerRatioBps;
  }

  if (form.kick_vod_required !== deal.kick_vod_required) {
    patch.kick_vod_required = form.kick_vod_required;
  }

  if (form.terms_text !== deal.terms_text) {
    patch.terms_text = form.terms_text;
  }

  if (form.terms_version !== deal.terms_version) {
    patch.terms_version = form.terms_version;
  }

  return patch;
}

export function MultiplierDealFormDialog(props: Props) {
  const { userId, mode = "create", deal, trigger } = props;
  const formId = useId();
  const [open, setOpen] = useState(false);
  const initial = useMemo<FormState>(
    () =>
      mode === "edit" && deal
        ? buildEditDefaults(deal)
        : buildCreateDefaults(),
    [mode, deal],
  );
  const [form, setForm] = useState<FormState>(initial);
  const [isPending, startTransition] = useTransition();

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) setForm(initial);
  }

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    const requiredDeposit = parseFloat(form.required_deposit_usd);
    const multiplier = parseFloat(form.multiplier_x);
    const withdrawablePct = parseFloat(form.withdrawable_pct);
    const wagerReqPct = parseFloat(form.wager_req_pct);
    const minDuration = parseInt(form.min_session_duration_seconds, 10);
    const minBet = parseInt(form.min_bet_count, 10);
    const minWagerRatioPct = parseFloat(form.min_wager_to_funding_ratio_pct);

    // Numeric validation. Backend re-validates under transaction locks so
    // these client checks are purely to fail fast with a friendly toast.
    if (!Number.isFinite(requiredDeposit) || requiredDeposit <= 0) {
      toast.error("Required deposit must be greater than 0");
      return;
    }
    if (!Number.isFinite(multiplier) || multiplier < 1) {
      toast.error("Multiplier must be 1x or higher");
      return;
    }
    if (
      !Number.isFinite(withdrawablePct) ||
      withdrawablePct < 0 ||
      withdrawablePct > 100
    ) {
      toast.error("Withdrawable percentage must be between 0 and 100");
      return;
    }
    if (!Number.isFinite(wagerReqPct) || wagerReqPct < 0) {
      toast.error("Wager requirement must be 0 or greater");
      return;
    }
    if (!Number.isFinite(minDuration) || minDuration < 0) {
      toast.error("Min session duration must be 0 seconds or more");
      return;
    }
    if (!Number.isFinite(minBet) || minBet < 0) {
      toast.error("Min bet count must be 0 or more");
      return;
    }
    if (
      !Number.isFinite(minWagerRatioPct) ||
      minWagerRatioPct < 0 ||
      minWagerRatioPct > 100
    ) {
      toast.error("Min wager / loaded ratio must be 0–100%");
      return;
    }

    const totalWagerTrim = form.max_total_wager_usd.trim();
    const totalWagerUsd =
      totalWagerTrim === "" ? null : parseFloat(totalWagerTrim);
    if (
      totalWagerUsd !== null &&
      (!Number.isFinite(totalWagerUsd) || totalWagerUsd < 0)
    ) {
      toast.error("Max total wager must be 0+ or empty for no cap");
      return;
    }

    const payoutTrim = form.max_payout_usd.trim();
    const payoutUsd = payoutTrim === "" ? null : parseFloat(payoutTrim);
    if (
      payoutUsd !== null &&
      (!Number.isFinite(payoutUsd) || payoutUsd < 0)
    ) {
      toast.error("Max payout must be 0+ or empty for no cap");
      return;
    }

    if (form.terms_text.trim().length === 0) {
      toast.error("TOS text is required");
      return;
    }
    if (form.terms_version.trim().length === 0) {
      toast.error("TOS version is required");
      return;
    }

    startTransition(async () => {
      try {
        if (mode === "edit" && deal) {
          const patch = computePatch(form, deal);
          if (Object.keys(patch).length === 0) {
            toast.message("No changes to save");
            return;
          }
          await updateMultiplierDeal(userId, deal.id, deal.version, patch);
          toast.success("Multiplier deal updated");
        } else {
          await createMultiplierDeal(userId, {
            required_deposit_usd: requiredDeposit,
            multiplier_bps: Math.round(multiplier * 10000),
            withdrawable_bps: Math.round(withdrawablePct * 100),
            wager_requirement_bps: Math.round(wagerReqPct * 100),
            max_total_wager_usd: totalWagerUsd,
            max_payout_usd: payoutUsd,
            min_session_duration_seconds: minDuration,
            min_bet_count: minBet,
            min_wager_to_funding_ratio_bps: Math.round(
              minWagerRatioPct * 100,
            ),
            kick_vod_required: form.kick_vod_required,
            terms_text: form.terms_text,
            terms_version: form.terms_version,
          });
          toast.success("Multiplier deal created");
        }
        setOpen(false);
      } catch (err) {
        toast.error(
          err instanceof Error
            ? err.message
            : mode === "edit"
              ? "Failed to update deal"
              : "Failed to create deal",
        );
      }
    });
  }

  const title =
    mode === "edit" ? "Edit multiplier deal" : "New multiplier deal";
  const description =
    mode === "edit"
      ? "Contract is editable only while status is pending_deposit. Funding snapshot is locked at activation."
      : "Create a multiplier deal offer for this creator. Contract terms are snapshotted onto the deal at create time.";
  const submitLabel = mode === "edit" ? "Save changes" : "Create offer";
  const pendingLabel = mode === "edit" ? "Saving…" : "Creating…";

  // Live preview of total_loaded = deposit × multiplier. Pure UI math; the
  // backend recomputes at activation.
  const requiredDepositNum = parseFloat(form.required_deposit_usd);
  const multiplierNum = parseFloat(form.multiplier_x);
  const previewLoaded =
    Number.isFinite(requiredDepositNum) && Number.isFinite(multiplierNum)
      ? requiredDepositNum * multiplierNum
      : null;
  const previewPlatform =
    previewLoaded !== null ? previewLoaded - requiredDepositNum : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        render={
          <Button
            size="sm"
            variant={mode === "edit" ? "ghost" : "default"}
          />
        }
      >
        {trigger ??
          (mode === "edit" ? (
            <>
              <Pencil className="mr-1.5 size-3.5" />
              Edit
            </>
          ) : (
            <>
              <Plus className="mr-1.5 size-4" />
              New Multiplier Deal
            </>
          ))}
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <form
          id={formId}
          onSubmit={handleSubmit}
          className="space-y-4 py-2"
        >
          {/* Contract — core financial parameters */}
          <FieldGroup title="Contract">
            <Field label="Required deposit ($)" hint="Creator's own funds">
              <Input
                type="number"
                step="0.01"
                min="0.01"
                value={form.required_deposit_usd}
                onChange={(e) =>
                  update("required_deposit_usd", e.target.value)
                }
                required
              />
            </Field>
            <Field
              label="Multiplier (x)"
              hint="5 → balance × 5 at activation"
            >
              <Input
                type="number"
                step="0.1"
                min="1"
                value={form.multiplier_x}
                onChange={(e) => update("multiplier_x", e.target.value)}
                required
              />
            </Field>
            <Field
              label="Withdrawable (%)"
              hint="Fraction of ending balance paid out at approve"
            >
              <Input
                type="number"
                step="1"
                min="0"
                max="100"
                value={form.withdrawable_pct}
                onChange={(e) =>
                  update("withdrawable_pct", e.target.value)
                }
                required
              />
            </Field>
            <Field
              label="Wager requirement (%)"
              hint="Of total loaded — 100 = must wager once through"
            >
              <Input
                type="number"
                step="1"
                min="0"
                value={form.wager_req_pct}
                onChange={(e) => update("wager_req_pct", e.target.value)}
                required
              />
            </Field>
          </FieldGroup>

          {/* Live preview */}
          {previewLoaded !== null && (
            <div className="rounded-lg border bg-muted/30 p-3 text-sm">
              <div className="grid grid-cols-3 gap-x-4 text-center">
                <div>
                  <div className="text-xs text-muted-foreground">
                    Deposit
                  </div>
                  <div className="font-semibold">
                    ${requiredDepositNum.toFixed(2)}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">
                    + Platform credit
                  </div>
                  <div className="font-semibold text-emerald-500">
                    ${previewPlatform?.toFixed(2) ?? "—"}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">
                    = Total loaded
                  </div>
                  <div className="font-semibold">
                    ${previewLoaded.toFixed(2)}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Caps */}
          <FieldGroup title="Caps (optional — empty = uncapped)">
            <Field
              label="Max total wager ($)"
              hint="Hard ceiling on lifetime wager during stream"
            >
              <Input
                type="number"
                step="0.01"
                min="0"
                value={form.max_total_wager_usd}
                onChange={(e) =>
                  update("max_total_wager_usd", e.target.value)
                }
                placeholder="No cap"
              />
            </Field>
            <Field
              label="Max payout ($)"
              hint="Hard ceiling on voucher value at approve"
            >
              <Input
                type="number"
                step="0.01"
                min="0"
                value={form.max_payout_usd}
                onChange={(e) => update("max_payout_usd", e.target.value)}
                placeholder="No cap"
              />
            </Field>
          </FieldGroup>

          {/* Activity floor */}
          <FieldGroup title="Activity floor (auto-flag thresholds)">
            <Field
              label="Min duration (seconds)"
              hint="1800 = 30 minutes"
            >
              <Input
                type="number"
                step="60"
                min="0"
                value={form.min_session_duration_seconds}
                onChange={(e) =>
                  update("min_session_duration_seconds", e.target.value)
                }
                required
              />
            </Field>
            <Field label="Min bet count">
              <Input
                type="number"
                step="1"
                min="0"
                value={form.min_bet_count}
                onChange={(e) => update("min_bet_count", e.target.value)}
                required
              />
            </Field>
            <Field
              label="Min wager / loaded (%)"
              hint="Below this triggers LOW_WAGER_RATIO flag"
            >
              <Input
                type="number"
                step="1"
                min="0"
                max="100"
                value={form.min_wager_to_funding_ratio_pct}
                onChange={(e) =>
                  update("min_wager_to_funding_ratio_pct", e.target.value)
                }
                required
              />
            </Field>
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <Label className="text-xs">Kick VOD required</Label>
                <Switch
                  checked={form.kick_vod_required}
                  onCheckedChange={(v) => update("kick_vod_required", v)}
                />
              </div>
              <p className="text-[11px] text-muted-foreground">
                Creator must paste VOD URL at end-stream
              </p>
            </div>
          </FieldGroup>

          <Separator />

          {/* TOS snapshot */}
          <FieldGroup title="Terms of Service" cols={1}>
            <Field
              label="Version"
              hint="Internal label — e.g. v1.0, growth-2026-q2"
            >
              <Input
                value={form.terms_version}
                onChange={(e) => update("terms_version", e.target.value)}
                maxLength={64}
                required
              />
            </Field>
            <Field
              label="Terms text"
              hint="Full body the creator must accept. Snapshotted onto the deal — future TOS edits don't retroactively change this deal."
            >
              <Textarea
                value={form.terms_text}
                onChange={(e) => update("terms_text", e.target.value)}
                rows={8}
                maxLength={20000}
                required
                className="font-mono text-xs"
              />
            </Field>
          </FieldGroup>
        </form>

        <DialogFooter>
          <DialogClose
            render={<Button variant="ghost" disabled={isPending} />}
          >
            Cancel
          </DialogClose>
          <Button type="submit" form={formId} disabled={isPending}>
            {isPending ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                {pendingLabel}
              </>
            ) : (
              submitLabel
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FieldGroup({
  title,
  cols = 2,
  children,
}: {
  title: string;
  cols?: 1 | 2;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      <div
        className={
          cols === 1
            ? "space-y-3"
            : "grid grid-cols-1 gap-3 sm:grid-cols-2"
        }
      >
        {children}
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      {children}
      {hint && (
        <p className="text-[11px] text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}
