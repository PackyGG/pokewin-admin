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
import type {
  CreatorDealResponse,
  UpdateDealInput,
} from "@/lib/backend-api";

import {
  createCreatorDeal,
  updateCreatorDeal,
} from "../../backend-actions";

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
      deal: CreatorDealResponse;
      trigger?: React.ReactNode;
    };

type FormState = {
  week_start_utc: string;
  week_end_utc: string;
  fills_allowed: string;
  per_fill_amount_usd: string;
  conversion_rate_pct: string;
  // Empty string = uncapped (sent as null). Any non-empty value parses as
  // the lifetime payout limit for the deal — applies to both end-of-stream
  // conversions and pending conversion claims, never to tip/sponsored
  // battle spend (those don't generate vouchers).
  total_withdraw_cap_usd: string;
  cooldown_minutes: string;
  max_tip_per_stream_usd: string;
  max_tip_per_user_usd: string;
  max_sponsored_battle_usd: string;
  max_sponsorship_per_stream_usd: string;
  allow_site_leaderboards: boolean;
  allow_code_leaderboards: boolean;
};

/**
 * All times on the backend are UTC. The datetime-local input has no
 * timezone, so we label everything UTC and treat entered values as UTC
 * when building the ISO string. Defaults point at the next full Mon–Mon
 * week (UTC) so admins don't have to pick dates by hand for the common
 * case.
 */
const buildCreateDefaults = (): FormState => {
  const { start, end } = nextMondayWeekUtc();
  return {
    week_start_utc: toLocalInputValue(start),
    week_end_utc: toLocalInputValue(end),
    fills_allowed: "7",
    per_fill_amount_usd: "100",
    conversion_rate_pct: "50",
    total_withdraw_cap_usd: "",
    cooldown_minutes: "240",
    max_tip_per_stream_usd: "100",
    max_tip_per_user_usd: "20",
    max_sponsored_battle_usd: "50",
    max_sponsorship_per_stream_usd: "200",
    allow_site_leaderboards: false,
    allow_code_leaderboards: false,
  };
};

const buildEditDefaults = (deal: CreatorDealResponse): FormState => ({
  week_start_utc: toLocalInputValue(new Date(deal.week_start_utc)),
  week_end_utc: toLocalInputValue(new Date(deal.week_end_utc)),
  fills_allowed: String(deal.fills_allowed),
  per_fill_amount_usd: String(deal.per_fill_amount_usd),
  conversion_rate_pct: (deal.conversion_rate_bps / 100).toString(),
  total_withdraw_cap_usd: deal.total_withdraw_cap_usd ?? "",
  cooldown_minutes: String(deal.cooldown_minutes),
  max_tip_per_stream_usd: String(deal.max_tip_per_stream_usd),
  max_tip_per_user_usd: String(deal.max_tip_per_user_usd),
  max_sponsored_battle_usd: String(deal.max_sponsored_battle_usd),
  max_sponsorship_per_stream_usd: String(deal.max_sponsorship_per_stream_usd),
  allow_site_leaderboards: deal.allow_site_leaderboards,
  allow_code_leaderboards: deal.allow_code_leaderboards,
});

/**
 * Build a diff patch against the deal's current persisted values. Only
 * fields that actually changed are sent — avoids hitting backend "week
 * can only change while scheduled" errors when the admin tweaks an
 * active deal's tip limits.
 */
function computePatch(
  form: FormState,
  deal: CreatorDealResponse,
): UpdateDealInput["patch"] {
  const patch: UpdateDealInput["patch"] = {};

  const initialStart = toLocalInputValue(new Date(deal.week_start_utc));
  const initialEnd = toLocalInputValue(new Date(deal.week_end_utc));
  if (form.week_start_utc !== initialStart) {
    const iso = parseUtcInput(form.week_start_utc);
    if (iso) patch.week_start_utc = iso;
  }
  if (form.week_end_utc !== initialEnd) {
    const iso = parseUtcInput(form.week_end_utc);
    if (iso) patch.week_end_utc = iso;
  }

  const fillsAllowed = parseInt(form.fills_allowed, 10);
  if (Number.isFinite(fillsAllowed) && fillsAllowed !== deal.fills_allowed) {
    patch.fills_allowed = fillsAllowed;
  }

  const perFill = parseFloat(form.per_fill_amount_usd);
  if (
    Number.isFinite(perFill) &&
    perFill !== Number(deal.per_fill_amount_usd)
  ) {
    patch.per_fill_amount_usd = perFill;
  }

  const convBps = Math.round(parseFloat(form.conversion_rate_pct) * 100);
  if (Number.isFinite(convBps) && convBps !== deal.conversion_rate_bps) {
    patch.conversion_rate_bps = convBps;
  }

  // null transitions are meaningful — going from "$500 cap" to "uncapped"
  // and vice-versa both need to hit the API. Compare the form's "" (null)
  // against the deal's null cap explicitly.
  const formCapTrim = form.total_withdraw_cap_usd.trim();
  const formCap = formCapTrim === "" ? null : parseFloat(formCapTrim);
  const dealCap =
    deal.total_withdraw_cap_usd === null
      ? null
      : Number(deal.total_withdraw_cap_usd);
  if (formCap === null && dealCap !== null) {
    patch.total_withdraw_cap_usd = null;
  } else if (formCap !== null && Number.isFinite(formCap)) {
    if (dealCap === null || formCap !== dealCap) {
      patch.total_withdraw_cap_usd = formCap;
    }
  }

  const cooldown = parseInt(form.cooldown_minutes, 10);
  if (Number.isFinite(cooldown) && cooldown !== deal.cooldown_minutes) {
    patch.cooldown_minutes = cooldown;
  }

  const tipStream = parseFloat(form.max_tip_per_stream_usd);
  if (
    Number.isFinite(tipStream) &&
    tipStream !== Number(deal.max_tip_per_stream_usd)
  ) {
    patch.max_tip_per_stream_usd = tipStream;
  }

  const tipUser = parseFloat(form.max_tip_per_user_usd);
  if (
    Number.isFinite(tipUser) &&
    tipUser !== Number(deal.max_tip_per_user_usd)
  ) {
    patch.max_tip_per_user_usd = tipUser;
  }

  const sponsored = parseFloat(form.max_sponsored_battle_usd);
  if (
    Number.isFinite(sponsored) &&
    sponsored !== Number(deal.max_sponsored_battle_usd)
  ) {
    patch.max_sponsored_battle_usd = sponsored;
  }

  const sponsoredStream = parseFloat(form.max_sponsorship_per_stream_usd);
  if (
    Number.isFinite(sponsoredStream) &&
    sponsoredStream !== Number(deal.max_sponsorship_per_stream_usd)
  ) {
    patch.max_sponsorship_per_stream_usd = sponsoredStream;
  }

  if (form.allow_site_leaderboards !== deal.allow_site_leaderboards) {
    patch.allow_site_leaderboards = form.allow_site_leaderboards;
  }
  if (form.allow_code_leaderboards !== deal.allow_code_leaderboards) {
    patch.allow_code_leaderboards = form.allow_code_leaderboards;
  }

  return patch;
}

function nextMondayWeekUtc(): { start: Date; end: Date } {
  const now = new Date();
  const utcNow = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const dow = new Date(utcNow).getUTCDay(); // 0 Sun .. 6 Sat
  // Days until next Monday (exclusive if today is Monday → +7)
  const daysToMonday = dow === 1 ? 7 : (8 - dow) % 7 || 7;
  const start = new Date(utcNow + daysToMonday * 86400_000);
  const end = new Date(start.getTime() + 7 * 86400_000);
  return { start, end };
}

function toLocalInputValue(d: Date): string {
  // datetime-local expects YYYY-MM-DDTHH:mm in local time. Because we
  // treat user input as UTC, format the Date's UTC components so the
  // string visually matches the UTC instant.
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function parseUtcInput(value: string): string | null {
  if (!value) return null;
  // Append :00 seconds + Z so the string is a valid UTC ISO.
  const withSeconds = value.length === 16 ? `${value}:00` : value;
  const iso = `${withSeconds}Z`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function DealFormDialog(props: Props) {
  const { userId, mode = "create", deal, trigger } = props;
  const formId = useId();
  const [open, setOpen] = useState(false);
  const initial = useMemo<FormState>(
    () => (mode === "edit" && deal ? buildEditDefaults(deal) : buildCreateDefaults()),
    [mode, deal],
  );
  const [form, setForm] = useState<FormState>(initial);
  const [isPending, startTransition] = useTransition();

  // Reset the form only when opening. Doing the reset during close
  // collides with Base-UI's dialog-close teardown and has caused crashes
  // when the form state updates while the portal is already unmounting.
  // The next open picks up the freshest `initial` via useMemo anyway.
  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) setForm(initial);
  }

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  const weekEditable = mode === "create" || (deal?.status === "scheduled");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    const weekStart = parseUtcInput(form.week_start_utc);
    const weekEnd = parseUtcInput(form.week_end_utc);
    if (!weekStart || !weekEnd) {
      toast.error("Enter valid start and end dates");
      return;
    }
    if (new Date(weekEnd) <= new Date(weekStart)) {
      toast.error("Week end must be after week start");
      return;
    }

    const fillsAllowed = parseInt(form.fills_allowed, 10);
    const perFillUsd = parseFloat(form.per_fill_amount_usd);
    const conversionPct = parseFloat(form.conversion_rate_pct);
    const cooldownMin = parseInt(form.cooldown_minutes, 10);
    const maxTipStream = parseFloat(form.max_tip_per_stream_usd);
    const maxTipUser = parseFloat(form.max_tip_per_user_usd);
    const maxSponsored = parseFloat(form.max_sponsored_battle_usd);
    const maxSponsoredStream = parseFloat(
      form.max_sponsorship_per_stream_usd,
    );

    if (!Number.isFinite(fillsAllowed) || fillsAllowed <= 0) {
      toast.error("Fills allowed must be a positive integer");
      return;
    }
    if (mode === "edit" && deal && fillsAllowed < deal.fills_used) {
      toast.error(
        `Fills allowed can't drop below fills_used (${deal.fills_used})`,
      );
      return;
    }
    if (!Number.isFinite(perFillUsd) || perFillUsd <= 0) {
      toast.error("Per-fill amount must be greater than 0");
      return;
    }
    if (
      !Number.isFinite(conversionPct) ||
      conversionPct < 0 ||
      conversionPct > 100
    ) {
      toast.error("Conversion rate must be between 0 and 100");
      return;
    }

    const capTrim = form.total_withdraw_cap_usd.trim();
    const totalCapUsd: number | null =
      capTrim === "" ? null : parseFloat(capTrim);
    if (totalCapUsd !== null) {
      if (!Number.isFinite(totalCapUsd) || totalCapUsd < 0) {
        toast.error("Total withdraw cap must be 0 or greater (or empty for no cap)");
        return;
      }
      if (
        mode === "edit" &&
        deal &&
        totalCapUsd < Number(deal.withdraw_cap_used_usd)
      ) {
        toast.error(
          `Total withdraw cap can't drop below already paid out ($${Number(deal.withdraw_cap_used_usd).toFixed(2)})`,
        );
        return;
      }
    }

    if (!Number.isFinite(cooldownMin) || cooldownMin < 0) {
      toast.error("Cooldown must be 0 or more minutes");
      return;
    }
    if (
      [maxTipStream, maxTipUser, maxSponsored, maxSponsoredStream].some(
        (v) => !Number.isFinite(v) || v < 0,
      )
    ) {
      toast.error("Spend limits must be 0 or greater");
      return;
    }
    if (maxSponsoredStream < maxSponsored) {
      toast.error(
        "Per-stream sponsorship cap must be >= per-battle sponsorship cap",
      );
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
          await updateCreatorDeal(userId, deal.id, deal.version, patch);
          toast.success("Deal updated");
        } else {
          await createCreatorDeal(userId, {
            week_start_utc: weekStart,
            week_end_utc: weekEnd,
            fills_allowed: fillsAllowed,
            per_fill_amount_usd: perFillUsd,
            conversion_rate_bps: Math.round(conversionPct * 100),
            total_withdraw_cap_usd: totalCapUsd,
            cooldown_minutes: cooldownMin,
            max_tip_per_stream_usd: maxTipStream,
            max_tip_per_user_usd: maxTipUser,
            max_sponsored_battle_usd: maxSponsored,
            max_sponsorship_per_stream_usd: maxSponsoredStream,
            allow_site_leaderboards: form.allow_site_leaderboards,
            allow_code_leaderboards: form.allow_code_leaderboards,
          });
          toast.success("Deal created");
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

  const title = mode === "edit" ? "Edit deal" : "New weekly deal";
  const description =
    mode === "edit"
      ? deal?.status === "scheduled"
        ? "All fields editable while deal is scheduled. Rate / amount changes only apply to future sessions."
        : "Deal is active — week window is locked. Rate / amount changes only apply to future sessions."
      : "Every time interval is UTC. Week windows cannot overlap another non-terminated deal for this creator.";
  const submitLabel = mode === "edit" ? "Save changes" : "Create deal";
  const pendingLabel = mode === "edit" ? "Saving..." : "Creating...";

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
              <Plus className="mr-2 size-4" />
              New Deal
            </>
          ))}
      </DialogTrigger>

      <DialogContent className="sm:max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <form id={formId} onSubmit={handleSubmit} className="space-y-5">
          <Section title="Week window (UTC)">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Starts" htmlFor="week_start_utc">
                <Input
                  id="week_start_utc"
                  type="datetime-local"
                  value={form.week_start_utc}
                  onChange={(e) => update("week_start_utc", e.target.value)}
                  disabled={!weekEditable}
                  required
                />
              </Field>
              <Field label="Ends" htmlFor="week_end_utc">
                <Input
                  id="week_end_utc"
                  type="datetime-local"
                  value={form.week_end_utc}
                  onChange={(e) => update("week_end_utc", e.target.value)}
                  disabled={!weekEditable}
                  required
                />
              </Field>
            </div>
          </Section>

          <Separator />

          <Section title="Fills">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Fills allowed" htmlFor="fills_allowed">
                <Input
                  id="fills_allowed"
                  type="number"
                  min={1}
                  step={1}
                  value={form.fills_allowed}
                  onChange={(e) => update("fills_allowed", e.target.value)}
                  required
                />
              </Field>
              <Field
                label="Per-fill amount"
                htmlFor="per_fill_amount_usd"
                suffix="USD"
              >
                <Input
                  id="per_fill_amount_usd"
                  type="number"
                  min={0}
                  step="0.01"
                  value={form.per_fill_amount_usd}
                  onChange={(e) =>
                    update("per_fill_amount_usd", e.target.value)
                  }
                  required
                />
              </Field>
            </div>
          </Section>

          <Separator />

          <Section title="Conversion">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label="Creator keeps"
                htmlFor="conversion_rate_pct"
                suffix="%"
              >
                <Input
                  id="conversion_rate_pct"
                  type="number"
                  min={0}
                  max={100}
                  step="0.1"
                  value={form.conversion_rate_pct}
                  onChange={(e) =>
                    update("conversion_rate_pct", e.target.value)
                  }
                  required
                />
              </Field>
              <Field
                label="Fill cooldown"
                htmlFor="cooldown_minutes"
                suffix="minutes"
              >
                <Input
                  id="cooldown_minutes"
                  type="number"
                  min={0}
                  step={1}
                  value={form.cooldown_minutes}
                  onChange={(e) => update("cooldown_minutes", e.target.value)}
                  required
                />
              </Field>
            </div>
          </Section>

          <Separator />

          <Section
            title="Total withdraw cap"
            description="Lifetime ceiling on USD that can be paid out across this deal — applies to end-of-stream conversions and pending battle-win/refund claims. Tips and sponsored battles are unaffected. Leave empty for uncapped."
          >
            <Field
              label="Cap"
              htmlFor="total_withdraw_cap_usd"
              suffix="USD"
              hint={
                mode === "edit" && deal
                  ? `Already paid out under this deal: $${Number(deal.withdraw_cap_used_usd).toFixed(2)}. Cap can't be lowered below this.`
                  : "After conversions reach this amount the creator stops accruing payout vouchers — excess is forfeited."
              }
            >
              <Input
                id="total_withdraw_cap_usd"
                type="number"
                min={0}
                step="0.01"
                placeholder="Uncapped"
                value={form.total_withdraw_cap_usd}
                onChange={(e) =>
                  update("total_withdraw_cap_usd", e.target.value)
                }
              />
            </Field>
          </Section>

          <Separator />

          <Section
            title="Tip limits"
            description="Caps that apply while the creator is streaming on fill balance."
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label="Max tip per user"
                htmlFor="max_tip_per_user_usd"
                suffix="USD"
                hint="Single tip from one viewer — caps the biggest tip any one user can send."
              >
                <Input
                  id="max_tip_per_user_usd"
                  type="number"
                  min={0}
                  step="0.01"
                  value={form.max_tip_per_user_usd}
                  onChange={(e) =>
                    update("max_tip_per_user_usd", e.target.value)
                  }
                  required
                />
              </Field>
              <Field
                label="Max tips per stream"
                htmlFor="max_tip_per_stream_usd"
                suffix="USD"
                hint="Total tip spend the creator can rack up over one full stream session."
              >
                <Input
                  id="max_tip_per_stream_usd"
                  type="number"
                  min={0}
                  step="0.01"
                  value={form.max_tip_per_stream_usd}
                  onChange={(e) =>
                    update("max_tip_per_stream_usd", e.target.value)
                  }
                  required
                />
              </Field>
            </div>
          </Section>

          <Separator />

          <Section
            title="Sponsorship limits"
            description="Caps for shared battles the creator sponsors during a stream."
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label="Max sponsorship per battle"
                htmlFor="max_sponsored_battle_usd"
                suffix="USD"
                hint="Largest amount the creator can put into a single sponsored battle."
              >
                <Input
                  id="max_sponsored_battle_usd"
                  type="number"
                  min={0}
                  step="0.01"
                  value={form.max_sponsored_battle_usd}
                  onChange={(e) =>
                    update("max_sponsored_battle_usd", e.target.value)
                  }
                  required
                />
              </Field>
              <Field
                label="Max sponsorship per stream"
                htmlFor="max_sponsorship_per_stream_usd"
                suffix="USD"
                hint="Total sponsorship spend across all battles in one stream session. Must be ≥ per-battle cap."
              >
                <Input
                  id="max_sponsorship_per_stream_usd"
                  type="number"
                  min={0}
                  step="0.01"
                  value={form.max_sponsorship_per_stream_usd}
                  onChange={(e) =>
                    update("max_sponsorship_per_stream_usd", e.target.value)
                  }
                  required
                />
              </Field>
            </div>
          </Section>

          <Separator />

          <Section title="Leaderboards">
            <div className="space-y-3">
              <ToggleRow
                label="Include in packy.gg official races"
                description="Counts this creator's activity toward packy.gg's official race leaderboards. Keep OFF — paid-deal activity should not compete with organic users on the official race."
                checked={form.allow_site_leaderboards}
                onCheckedChange={(v) => update("allow_site_leaderboards", v)}
              />
              <ToggleRow
                label="Creator-run leaderboards"
                description="Lets this creator create and run their own leaderboards for their community (WIP — still configurable from here)."
                checked={form.allow_code_leaderboards}
                onCheckedChange={(v) => update("allow_code_leaderboards", v)}
              />
            </div>
          </Section>
        </form>

        <DialogFooter>
          <DialogClose
            render={<Button variant="outline" disabled={isPending} />}
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

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-3">
      <div className="space-y-0.5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h3>
        {description && (
          <p className="text-[11px] leading-snug text-muted-foreground/80">
            {description}
          </p>
        )}
      </div>
      {children}
    </div>
  );
}

function Field({
  label,
  htmlFor,
  suffix,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  suffix?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor} className="flex items-baseline justify-between">
        <span>{label}</span>
        {suffix && (
          <span className="text-[10px] font-normal uppercase tracking-wide text-muted-foreground">
            {suffix}
          </span>
        )}
      </Label>
      {children}
      {hint && (
        <p className="text-[11px] leading-snug text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onCheckedChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-md border px-3 py-2.5">
      <div className="space-y-0.5">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}
