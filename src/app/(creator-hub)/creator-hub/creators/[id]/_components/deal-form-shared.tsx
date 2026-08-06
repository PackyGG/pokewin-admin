"use client";

import { z } from "zod";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
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
  duration_preset: "7" | "14" | "21" | "28" | "custom";
  duration_days: string;
  fills_allowed: string;
  per_fill_amount_usd: string;
  conversion_rate_pct: string;
  total_withdraw_cap_usd: string;
  withdraw_cap_mode: "" | "limited" | "unlimited";
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
    duration_preset: z.enum(["7", "14", "21", "28", "custom"]),
    duration_days: z.coerce
      .number()
      .int("Duration must be a whole number of days")
      .positive("Duration must be at least one day")
      .max(3650, "Duration cannot exceed 3650 days"),
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
    withdraw_cap_mode: z.enum(["", "limited", "unlimited"]),
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
    if (data.withdraw_cap_mode === "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Enter a withdrawal cap or choose No limit",
        path: ["withdraw_cap_mode"],
      });
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(data.week_start_utc)) {
      const expectedEnd = endDateForDuration(
        data.week_start_utc,
        data.duration_days,
      );
      if (expectedEnd && weekEnd !== expectedEnd) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Deal end must match the selected duration",
          path: ["duration_days"],
        });
      }
    }
    if (data.withdraw_cap_mode === "limited" && capTrim === "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Enter the withdrawal cap amount",
        path: ["total_withdraw_cap_usd"],
      });
    }
    if (data.withdraw_cap_mode === "limited" && capTrim !== "") {
      const cap = Number(capTrim);
      if (!Number.isFinite(cap) || cap < 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Total withdraw cap must be 0 or greater",
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
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const isLocalDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(value);
  const normalized = isDateOnly ? `${value}T00:00:00` : value;
  const withSeconds = normalized.length === 16 ? `${normalized}:00` : normalized;
  const iso = isDateOnly || isLocalDateTime ? `${withSeconds}Z` : withSeconds;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** A date input value rendered in UTC, never the browser's local timezone. */
export function toUtcDateInputValue(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

/** Inclusive start plus N complete UTC days; the returned end is exclusive. */
export function endDateForDuration(startDate: string, days: number): string {
  const start = parseUtcInput(startDate);
  if (!start || !Number.isInteger(days) || days < 1) return "";
  return new Date(new Date(start).getTime() + days * 86_400_000).toISOString();
}

/** Date/ISO → the UTC-rendered `datetime-local` input value. */
export function toUtcLocalInputValue(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function todayPlusSevenDaysUtc(): { start: Date; end: Date } {
  const now = new Date();
  const start = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      0,
      0,
    ),
  );
  const end = new Date(start.getTime() + 7 * 86400_000);
  return { start, end };
}

/** New-deal defaults: now → +7d, house-standard terms. */
export function buildCreateDefaults(): DealFormState {
  const { start, end } = todayPlusSevenDaysUtc();
  return {
    week_start_utc: toUtcDateInputValue(start),
    week_end_utc: end.toISOString(),
    duration_preset: "7",
    duration_days: "7",
    fills_allowed: "7",
    per_fill_amount_usd: "100",
    conversion_rate_pct: "50",
    total_withdraw_cap_usd: "",
    withdraw_cap_mode: "",
    cooldown_minutes: "300",
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
  const durationDays = Math.max(
    1,
    Math.round(
      (new Date(deal.week_end_utc).getTime() -
        new Date(deal.week_start_utc).getTime()) /
        86_400_000,
    ),
  );
  return {
    week_start_utc: toUtcLocalInputValue(deal.week_start_utc),
    week_end_utc: toUtcLocalInputValue(deal.week_end_utc),
    duration_preset: [7, 14, 21, 28].includes(durationDays)
      ? (String(durationDays) as "7" | "14" | "21" | "28")
      : "custom",
    duration_days: String(durationDays),
    fills_allowed: String(deal.fills_allowed),
    per_fill_amount_usd: deal.per_fill_amount_usd,
    conversion_rate_pct: String(deal.conversion_rate_bps / 100),
    total_withdraw_cap_usd: deal.total_withdraw_cap_usd ?? "",
    withdraw_cap_mode:
      deal.total_withdraw_cap_usd == null ? "unlimited" : "limited",
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
export function toDealPayload(
  parsed: DealFormParsed,
  options: { forceLeaderboardsOff?: boolean } = {},
): DealPayload | null {
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
    total_withdraw_cap_usd:
      parsed.withdraw_cap_mode === "unlimited" ? null : Number(capTrim),
    cooldown_minutes: parsed.cooldown_minutes,
    max_tip_per_stream_usd: parsed.max_tip_per_stream_usd,
    max_tip_per_user_usd: parsed.max_tip_per_user_usd,
    max_sponsored_battle_usd: parsed.max_sponsored_battle_usd,
    max_sponsorship_per_stream_usd: parsed.max_sponsorship_per_stream_usd,
    allow_site_leaderboards: options.forceLeaderboardsOff
      ? false
      : parsed.allow_site_leaderboards,
    allow_code_leaderboards: options.forceLeaderboardsOff
      ? false
      : parsed.allow_code_leaderboards,
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
  mode = "edit",
}: {
  form: DealFormState;
  update: <K extends keyof DealFormState>(
    key: K,
    value: DealFormState[K],
  ) => void;
  pending: boolean;
  idPrefix: string;
  mode?: "create" | "edit";
}) {
  const id = (name: string) => `${idPrefix}_${name}`;
  function setCreateDuration(
    days: number,
    preset: DealFormState["duration_preset"],
  ) {
    update("duration_preset", preset);
    update("duration_days", String(days));
    update("week_end_utc", endDateForDuration(form.week_start_utc, days));
  }
  return (
    <>
      <DealFormSection title="Deal window (UTC)">
        <div className="space-y-3">
          <DealFormField label="Starts" htmlFor={id("week_start")}>
            <Input
              id={id("week_start")}
              type={mode === "create" ? "date" : "datetime-local"}
              value={form.week_start_utc}
              onChange={(e) => {
                update("week_start_utc", e.target.value);
                if (mode === "create") {
                  update(
                    "week_end_utc",
                    endDateForDuration(
                      e.target.value,
                      Number(form.duration_days),
                    ),
                  );
                }
              }}
              required
              disabled={pending}
            />
          </DealFormField>
          {mode === "edit" ? (
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
          ) : (
            <DealFormField label="Length" htmlFor={id("duration_days")}>
              <div
                className="flex flex-wrap gap-2"
                role="group"
                aria-label="Deal length"
              >
                {[7, 14, 21, 28].map((days) => (
                  <Button
                    key={days}
                    type="button"
                    size="sm"
                    variant={
                      form.duration_preset === String(days)
                        ? "default"
                        : "outline"
                    }
                    onClick={() =>
                      setCreateDuration(
                        days,
                        String(days) as DealFormState["duration_preset"],
                      )
                    }
                    disabled={pending}
                  >
                    {days / 7} {days === 7 ? "week" : "weeks"}
                  </Button>
                ))}
                <Button
                  type="button"
                  size="sm"
                  variant={
                    form.duration_preset === "custom" ? "default" : "outline"
                  }
                  onClick={() => update("duration_preset", "custom")}
                  disabled={pending}
                >
                  Custom
                </Button>
              </div>
              {form.duration_preset === "custom" && (
                <Input
                  id={id("duration_days")}
                  className="mt-2"
                  type="number"
                  min={1}
                  step={1}
                  value={form.duration_days}
                  onChange={(e) => {
                    update("duration_days", e.target.value);
                    update(
                      "week_end_utc",
                      endDateForDuration(
                        form.week_start_utc,
                        Number(e.target.value),
                      ),
                    );
                  }}
                  required
                  disabled={pending}
                />
              )}
              <p className="mt-1 text-[11px] text-muted-foreground">
                Starts at 00:00 UTC and ends after {form.duration_days || "—"}
                full days.
              </p>
            </DealFormField>
          )}
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
        description="Choose a lifetime USD ceiling or explicitly select No limit."
      >
        <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
          <DealFormField label="Cap" htmlFor={id("cap")} suffix="USD">
            <Input
              id={id("cap")}
              type="number"
              min={0}
              step="0.01"
              placeholder="Enter cap"
              value={form.total_withdraw_cap_usd}
              onChange={(e) => {
                update("total_withdraw_cap_usd", e.target.value);
                update("withdraw_cap_mode", "limited");
              }}
              disabled={pending || form.withdraw_cap_mode === "unlimited"}
            />
          </DealFormField>
          <Button
            type="button"
            variant={
              form.withdraw_cap_mode === "unlimited" ? "default" : "outline"
            }
            className="self-end"
            onClick={() => {
              update("withdraw_cap_mode", "unlimited");
              update("total_withdraw_cap_usd", "");
            }}
            disabled={pending}
          >
            No limit
          </Button>
        </div>
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

    </>
  );
}
