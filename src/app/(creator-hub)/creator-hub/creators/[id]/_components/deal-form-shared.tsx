"use client";

import { z } from "zod";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import type { CreatorDealResponse } from "@/lib/backend-api";

/**
 * Shared pieces of the New / Edit deal dialogs (drift prevention).
 *
 * The two dialogs used to be ~1100 lines of near-duplicate code — one zod
 * schema, one field grid, one set of Section/Field/ToggleRow primitives and
 * one `parseUtcInput`, each copy-pasted twice. This module is now the single
 * source; the dialogs keep only their distinct submit paths (create vs
 * update + version) and their own chrome.
 */

export type DealFormState = {
  week_start_utc: string;
  week_end_utc: string;
  fills_allowed: string;
  per_fill_amount_usd: string;
  conversion_rate_pct: string;
  total_withdraw_cap_usd: string;
  cooldown_minutes: string;
  max_tip_per_stream_usd: string;
  max_tip_per_user_usd: string;
  max_sponsored_battle_usd: string;
  max_sponsorship_per_stream_usd: string;
  allow_site_leaderboards: boolean;
  allow_code_leaderboards: boolean;
};

export const dealFormSchema = z
  .object({
    week_start_utc: z.string().min(1, "Week start is required"),
    week_end_utc: z.string().min(1, "Week end is required"),
    fills_allowed: z.coerce
      .number()
      .int("Fills allowed must be a whole number")
      .positive("Fills allowed must be greater than 0"),
    per_fill_amount_usd: z.coerce
      .number()
      .positive("Per-fill amount must be greater than 0"),
    conversion_rate_pct: z.coerce
      .number()
      .min(0, "Conversion rate must be at least 0%")
      .max(100, "Conversion rate must be at most 100%"),
    total_withdraw_cap_usd: z.string(),
    cooldown_minutes: z.coerce
      .number()
      .int("Cooldown must be a whole number")
      .min(0, "Cooldown must be 0 or more minutes"),
    max_tip_per_stream_usd: z.coerce
      .number()
      .min(0, "Tip limits must be 0 or greater"),
    max_tip_per_user_usd: z.coerce
      .number()
      .min(0, "Tip limits must be 0 or greater"),
    max_sponsored_battle_usd: z.coerce
      .number()
      .min(0, "Sponsorship limits must be 0 or greater"),
    max_sponsorship_per_stream_usd: z.coerce
      .number()
      .min(0, "Sponsorship limits must be 0 or greater"),
    allow_site_leaderboards: z.boolean(),
    allow_code_leaderboards: z.boolean(),
  })
  .superRefine((data, ctx) => {
    const weekStart = parseUtcInput(data.week_start_utc);
    const weekEnd = parseUtcInput(data.week_end_utc);
    if (!weekStart) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Enter a valid week start (UTC)",
        path: ["week_start_utc"],
      });
    }
    if (!weekEnd) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Enter a valid week end (UTC)",
        path: ["week_end_utc"],
      });
    }
    if (weekStart && weekEnd && new Date(weekEnd) <= new Date(weekStart)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Week end must be after week start",
        path: ["week_end_utc"],
      });
    }

    const capTrim = data.total_withdraw_cap_usd.trim();
    if (capTrim !== "") {
      const cap = Number(capTrim);
      if (!Number.isFinite(cap) || cap < 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Total withdraw cap must be 0 or greater (or empty for no cap)",
          path: ["total_withdraw_cap_usd"],
        });
      }
    }

    if (data.max_sponsorship_per_stream_usd < data.max_sponsored_battle_usd) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Per-stream sponsorship cap must be >= per-battle sponsorship cap",
        path: ["max_sponsorship_per_stream_usd"],
      });
    }
  });

export type DealFormParsed = z.infer<typeof dealFormSchema>;

/** `datetime-local` value (UTC semantics) → ISO string, or null if invalid. */
export function parseUtcInput(value: string): string | null {
  if (!value) return null;
  const withSeconds = value.length === 16 ? `${value}:00` : value;
  const iso = `${withSeconds}Z`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Date/ISO → the UTC-rendered `datetime-local` input value. */
export function toUtcLocalInputValue(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function nowPlusSevenDaysUtc(): { start: Date; end: Date } {
  const now = new Date();
  const start = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours(),
      now.getUTCMinutes(),
    ),
  );
  const end = new Date(start.getTime() + 7 * 86400_000);
  return { start, end };
}

/** New-deal defaults: now → +7d, house-standard terms. */
export function buildCreateDefaults(): DealFormState {
  const { start, end } = nowPlusSevenDaysUtc();
  return {
    week_start_utc: toUtcLocalInputValue(start),
    week_end_utc: toUtcLocalInputValue(end),
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
}

/** Edit-deal defaults: pre-filled from the live deal terms. */
export function buildDefaultsFromDeal(deal: CreatorDealResponse): DealFormState {
  return {
    week_start_utc: toUtcLocalInputValue(deal.week_start_utc),
    week_end_utc: toUtcLocalInputValue(deal.week_end_utc),
    fills_allowed: String(deal.fills_allowed),
    per_fill_amount_usd: deal.per_fill_amount_usd,
    conversion_rate_pct: String(deal.conversion_rate_bps / 100),
    total_withdraw_cap_usd: deal.total_withdraw_cap_usd ?? "",
    cooldown_minutes: String(deal.cooldown_minutes),
    max_tip_per_stream_usd: deal.max_tip_per_stream_usd,
    max_tip_per_user_usd: deal.max_tip_per_user_usd,
    max_sponsored_battle_usd: deal.max_sponsored_battle_usd,
    max_sponsorship_per_stream_usd: deal.max_sponsorship_per_stream_usd,
    allow_site_leaderboards: deal.allow_site_leaderboards,
    allow_code_leaderboards: deal.allow_code_leaderboards,
  };
}

export type DealPayload = {
  week_start_utc: string;
  week_end_utc: string;
  fills_allowed: number;
  per_fill_amount_usd: number;
  conversion_rate_bps: number;
  total_withdraw_cap_usd: number | null;
  cooldown_minutes: number;
  max_tip_per_stream_usd: number;
  max_tip_per_user_usd: number;
  max_sponsored_battle_usd: number;
  max_sponsorship_per_stream_usd: number;
  allow_site_leaderboards: boolean;
  allow_code_leaderboards: boolean;
};

/**
 * Parsed form → server-action payload (create + update share the shape).
 * Returns null with no side effects when either date fails to re-parse.
 */
export function toDealPayload(parsed: DealFormParsed): DealPayload | null {
  const weekStart = parseUtcInput(parsed.week_start_utc);
  const weekEnd = parseUtcInput(parsed.week_end_utc);
  if (!weekStart || !weekEnd) return null;

  const capTrim = parsed.total_withdraw_cap_usd.trim();
  return {
    week_start_utc: weekStart,
    week_end_utc: weekEnd,
    fills_allowed: parsed.fills_allowed,
    per_fill_amount_usd: parsed.per_fill_amount_usd,
    conversion_rate_bps: Math.round(parsed.conversion_rate_pct * 100),
    total_withdraw_cap_usd: capTrim === "" ? null : Number(capTrim),
    cooldown_minutes: parsed.cooldown_minutes,
    max_tip_per_stream_usd: parsed.max_tip_per_stream_usd,
    max_tip_per_user_usd: parsed.max_tip_per_user_usd,
    max_sponsored_battle_usd: parsed.max_sponsored_battle_usd,
    max_sponsorship_per_stream_usd: parsed.max_sponsorship_per_stream_usd,
    allow_site_leaderboards: parsed.allow_site_leaderboards,
    allow_code_leaderboards: parsed.allow_code_leaderboards,
  };
}

// ── Form primitives ──────────────────────────────────────────────────

export function DealFormSection({
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

export function DealFormField({
  label,
  htmlFor,
  suffix,
  children,
}: {
  label: string;
  htmlFor: string;
  suffix?: string;
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
    </div>
  );
}

export function DealToggleRow({
  label,
  description,
  checked,
  onCheckedChange,
  disabled,
}: {
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-md border px-3 py-2.5">
      <div className="space-y-0.5">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
      />
    </div>
  );
}

// ── Shared field grid ────────────────────────────────────────────────

/**
 * The full deal-terms field grid (week window → fills → conversion → cap →
 * tips → sponsorship → leaderboard toggles). `idPrefix` keeps input ids
 * unique when both dialogs are mounted on the same page.
 */
export function DealFormFields({
  form,
  update,
  pending,
  idPrefix,
}: {
  form: DealFormState;
  update: <K extends keyof DealFormState>(
    key: K,
    value: DealFormState[K],
  ) => void;
  pending: boolean;
  idPrefix: string;
}) {
  const id = (name: string) => `${idPrefix}_${name}`;
  return (
    <>
      <DealFormSection title="Week window (UTC)">
        <div className="grid gap-3 sm:grid-cols-2">
          <DealFormField label="Starts" htmlFor={id("week_start")}>
            <Input
              id={id("week_start")}
              type="datetime-local"
              value={form.week_start_utc}
              onChange={(e) => update("week_start_utc", e.target.value)}
              required
              disabled={pending}
            />
          </DealFormField>
          <DealFormField label="Ends" htmlFor={id("week_end")}>
            <Input
              id={id("week_end")}
              type="datetime-local"
              value={form.week_end_utc}
              onChange={(e) => update("week_end_utc", e.target.value)}
              required
              disabled={pending}
            />
          </DealFormField>
        </div>
      </DealFormSection>

      <Separator />

      <DealFormSection title="Fills">
        <div className="grid gap-3 sm:grid-cols-2">
          <DealFormField label="Fills allowed" htmlFor={id("fills_allowed")}>
            <Input
              id={id("fills_allowed")}
              type="number"
              min={1}
              step={1}
              value={form.fills_allowed}
              onChange={(e) => update("fills_allowed", e.target.value)}
              required
              disabled={pending}
            />
          </DealFormField>
          <DealFormField
            label="Per-fill amount"
            htmlFor={id("per_fill")}
            suffix="USD"
          >
            <Input
              id={id("per_fill")}
              type="number"
              min={0}
              step="0.01"
              value={form.per_fill_amount_usd}
              onChange={(e) => update("per_fill_amount_usd", e.target.value)}
              required
              disabled={pending}
            />
          </DealFormField>
        </div>
      </DealFormSection>

      <Separator />

      <DealFormSection title="Conversion">
        <div className="grid gap-3 sm:grid-cols-2">
          <DealFormField
            label="Creator keeps"
            htmlFor={id("conversion")}
            suffix="%"
          >
            <Input
              id={id("conversion")}
              type="number"
              min={0}
              max={100}
              step="0.1"
              value={form.conversion_rate_pct}
              onChange={(e) => update("conversion_rate_pct", e.target.value)}
              required
              disabled={pending}
            />
          </DealFormField>
          <DealFormField
            label="Fill cooldown"
            htmlFor={id("cooldown")}
            suffix="minutes"
          >
            <Input
              id={id("cooldown")}
              type="number"
              min={0}
              step={1}
              value={form.cooldown_minutes}
              onChange={(e) => update("cooldown_minutes", e.target.value)}
              required
              disabled={pending}
            />
          </DealFormField>
        </div>
      </DealFormSection>

      <Separator />

      <DealFormSection
        title="Total withdraw cap"
        description="Lifetime ceiling on USD paid out across this deal. Leave empty for uncapped."
      >
        <DealFormField label="Cap" htmlFor={id("cap")} suffix="USD">
          <Input
            id={id("cap")}
            type="number"
            min={0}
            step="0.01"
            placeholder="Uncapped"
            value={form.total_withdraw_cap_usd}
            onChange={(e) => update("total_withdraw_cap_usd", e.target.value)}
            disabled={pending}
          />
        </DealFormField>
      </DealFormSection>

      <Separator />

      <DealFormSection title="Tip limits">
        <div className="grid gap-3 sm:grid-cols-2">
          <DealFormField
            label="Max tip per user"
            htmlFor={id("tip_user")}
            suffix="USD"
          >
            <Input
              id={id("tip_user")}
              type="number"
              min={0}
              step="0.01"
              value={form.max_tip_per_user_usd}
              onChange={(e) => update("max_tip_per_user_usd", e.target.value)}
              required
              disabled={pending}
            />
          </DealFormField>
          <DealFormField
            label="Max tips per stream"
            htmlFor={id("tip_stream")}
            suffix="USD"
          >
            <Input
              id={id("tip_stream")}
              type="number"
              min={0}
              step="0.01"
              value={form.max_tip_per_stream_usd}
              onChange={(e) => update("max_tip_per_stream_usd", e.target.value)}
              required
              disabled={pending}
            />
          </DealFormField>
        </div>
      </DealFormSection>

      <Separator />

      <DealFormSection title="Sponsorship limits">
        <div className="grid gap-3 sm:grid-cols-2">
          <DealFormField
            label="Max per battle"
            htmlFor={id("spon_battle")}
            suffix="USD"
          >
            <Input
              id={id("spon_battle")}
              type="number"
              min={0}
              step="0.01"
              value={form.max_sponsored_battle_usd}
              onChange={(e) =>
                update("max_sponsored_battle_usd", e.target.value)
              }
              required
              disabled={pending}
            />
          </DealFormField>
          <DealFormField
            label="Max per stream"
            htmlFor={id("spon_stream")}
            suffix="USD"
          >
            <Input
              id={id("spon_stream")}
              type="number"
              min={0}
              step="0.01"
              value={form.max_sponsorship_per_stream_usd}
              onChange={(e) =>
                update("max_sponsorship_per_stream_usd", e.target.value)
              }
              required
              disabled={pending}
            />
          </DealFormField>
        </div>
      </DealFormSection>

      <Separator />

      <DealFormSection title="Leaderboards">
        <div className="space-y-3">
          <DealToggleRow
            label="Include in packy.gg official races"
            description="Keep OFF — paid-deal activity should not compete with organic users on the official race."
            checked={form.allow_site_leaderboards}
            onCheckedChange={(v) => update("allow_site_leaderboards", v)}
            disabled={pending}
          />
          <DealToggleRow
            label="Creator-run leaderboards"
            description="Lets this creator create and run their own leaderboards for their community."
            checked={form.allow_code_leaderboards}
            onCheckedChange={(v) => update("allow_code_leaderboards", v)}
            disabled={pending}
          />
        </div>
      </DealFormSection>
    </>
  );
}
