"use client";

import { useId, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Pencil } from "lucide-react";
import { z } from "zod";

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
import { Spinner } from "@/components/ux";
import type { CreatorDealResponse } from "@/lib/backend-api";

import { updateCreatorDeal } from "../../../../../(admin)/creators/backend-actions";

type FormState = {
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

const editFormSchema = z
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
    max_tip_per_stream_usd: z.coerce.number().min(0, "Tip limits must be 0 or greater"),
    max_tip_per_user_usd: z.coerce.number().min(0, "Tip limits must be 0 or greater"),
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
    const start = parseUtcInput(data.week_start_utc);
    const end = parseUtcInput(data.week_end_utc);
    if (!start)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Enter a valid week start (UTC)",
        path: ["week_start_utc"],
      });
    if (!end)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Enter a valid week end (UTC)",
        path: ["week_end_utc"],
      });
    if (start && end && new Date(end) <= new Date(start))
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Week end must be after week start",
        path: ["week_end_utc"],
      });
    const capTrim = data.total_withdraw_cap_usd.trim();
    if (capTrim !== "") {
      const cap = Number(capTrim);
      if (!Number.isFinite(cap) || cap < 0)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Total withdraw cap must be 0 or greater (or empty for no cap)",
          path: ["total_withdraw_cap_usd"],
        });
    }
    if (data.max_sponsorship_per_stream_usd < data.max_sponsored_battle_usd)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Per-stream sponsorship cap must be >= per-battle sponsorship cap",
        path: ["max_sponsorship_per_stream_usd"],
      });
  });

function toLocalInputValue(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function parseUtcInput(value: string): string | null {
  if (!value) return null;
  const withSeconds = value.length === 16 ? `${value}:00` : value;
  const parsed = new Date(`${withSeconds}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function buildDefaults(deal: CreatorDealResponse): FormState {
  return {
    week_start_utc: toLocalInputValue(deal.week_start_utc),
    week_end_utc: toLocalInputValue(deal.week_end_utc),
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

type Props = {
  userId: string;
  deal: CreatorDealResponse;
};

/**
 * Creator Hub — "Edit terms" dialog.
 *
 * Edits the creator's CURRENT ACTIVE deal via the existing
 * `updateCreatorDeal` server action (optimistic concurrency on
 * `deal.version`). Mirrors the New Deal form fields, pre-filled from the
 * live deal terms.
 */
export function EditDealDialog({ userId, deal }: Props) {
  const formId = useId();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const initial = useMemo(() => buildDefaults(deal), [deal]);
  const [form, setForm] = useState<FormState>(initial);
  const [pending, startTransition] = useTransition();

  function onOpenChange(next: boolean) {
    if (pending) return;
    setOpen(next);
    if (next) setForm(buildDefaults(deal));
  }

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = editFormSchema.safeParse(form);
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "Invalid deal input");
      return;
    }
    const weekStart = parseUtcInput(parsed.data.week_start_utc);
    const weekEnd = parseUtcInput(parsed.data.week_end_utc);
    if (!weekStart || !weekEnd) {
      toast.error("Enter valid start and end dates");
      return;
    }
    const capTrim = parsed.data.total_withdraw_cap_usd.trim();
    const totalCapUsd: number | null = capTrim === "" ? null : Number(capTrim);

    startTransition(async () => {
      try {
        await updateCreatorDeal(userId, deal.id, deal.version, {
          week_start_utc: weekStart,
          week_end_utc: weekEnd,
          fills_allowed: parsed.data.fills_allowed,
          per_fill_amount_usd: parsed.data.per_fill_amount_usd,
          conversion_rate_bps: Math.round(parsed.data.conversion_rate_pct * 100),
          total_withdraw_cap_usd: totalCapUsd,
          cooldown_minutes: parsed.data.cooldown_minutes,
          max_tip_per_stream_usd: parsed.data.max_tip_per_stream_usd,
          max_tip_per_user_usd: parsed.data.max_tip_per_user_usd,
          max_sponsored_battle_usd: parsed.data.max_sponsored_battle_usd,
          max_sponsorship_per_stream_usd:
            parsed.data.max_sponsorship_per_stream_usd,
          allow_site_leaderboards: parsed.data.allow_site_leaderboards,
          allow_code_leaderboards: parsed.data.allow_code_leaderboards,
        });
        toast.success("Deal terms updated");
        setOpen(false);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to update deal");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        <Pencil className="mr-1 size-3.5" />
        Edit terms
      </DialogTrigger>

      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-blue-500/15 text-blue-600 ring-1 ring-inset ring-blue-500/30 dark:text-blue-400">
              <Pencil className="size-4" />
            </span>
            Edit deal terms
          </DialogTitle>
          <DialogDescription>
            Every time interval is UTC. Saved as deal v{deal.version + 1}.
          </DialogDescription>
        </DialogHeader>

        <form id={formId} onSubmit={handleSubmit} className="space-y-5">
          <Section title="Week window (UTC)">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Starts" htmlFor="edit_week_start">
                <Input
                  id="edit_week_start"
                  type="datetime-local"
                  value={form.week_start_utc}
                  onChange={(e) => update("week_start_utc", e.target.value)}
                  required
                  disabled={pending}
                />
              </Field>
              <Field label="Ends" htmlFor="edit_week_end">
                <Input
                  id="edit_week_end"
                  type="datetime-local"
                  value={form.week_end_utc}
                  onChange={(e) => update("week_end_utc", e.target.value)}
                  required
                  disabled={pending}
                />
              </Field>
            </div>
          </Section>

          <Separator />

          <Section title="Fills">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Fills allowed" htmlFor="edit_fills_allowed">
                <Input
                  id="edit_fills_allowed"
                  type="number"
                  min={1}
                  step={1}
                  value={form.fills_allowed}
                  onChange={(e) => update("fills_allowed", e.target.value)}
                  required
                  disabled={pending}
                />
              </Field>
              <Field label="Per-fill amount" htmlFor="edit_per_fill" suffix="USD">
                <Input
                  id="edit_per_fill"
                  type="number"
                  min={0}
                  step="0.01"
                  value={form.per_fill_amount_usd}
                  onChange={(e) => update("per_fill_amount_usd", e.target.value)}
                  required
                  disabled={pending}
                />
              </Field>
            </div>
          </Section>

          <Separator />

          <Section title="Conversion">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Creator keeps" htmlFor="edit_conversion" suffix="%">
                <Input
                  id="edit_conversion"
                  type="number"
                  min={0}
                  max={100}
                  step="0.1"
                  value={form.conversion_rate_pct}
                  onChange={(e) => update("conversion_rate_pct", e.target.value)}
                  required
                  disabled={pending}
                />
              </Field>
              <Field label="Fill cooldown" htmlFor="edit_cooldown" suffix="minutes">
                <Input
                  id="edit_cooldown"
                  type="number"
                  min={0}
                  step={1}
                  value={form.cooldown_minutes}
                  onChange={(e) => update("cooldown_minutes", e.target.value)}
                  required
                  disabled={pending}
                />
              </Field>
            </div>
          </Section>

          <Separator />

          <Section
            title="Total withdraw cap"
            description="Lifetime ceiling on USD paid out across this deal. Leave empty for uncapped."
          >
            <Field label="Cap" htmlFor="edit_cap" suffix="USD">
              <Input
                id="edit_cap"
                type="number"
                min={0}
                step="0.01"
                placeholder="Uncapped"
                value={form.total_withdraw_cap_usd}
                onChange={(e) => update("total_withdraw_cap_usd", e.target.value)}
                disabled={pending}
              />
            </Field>
          </Section>

          <Separator />

          <Section title="Tip limits">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Max tip per user" htmlFor="edit_tip_user" suffix="USD">
                <Input
                  id="edit_tip_user"
                  type="number"
                  min={0}
                  step="0.01"
                  value={form.max_tip_per_user_usd}
                  onChange={(e) => update("max_tip_per_user_usd", e.target.value)}
                  required
                  disabled={pending}
                />
              </Field>
              <Field label="Max tips per stream" htmlFor="edit_tip_stream" suffix="USD">
                <Input
                  id="edit_tip_stream"
                  type="number"
                  min={0}
                  step="0.01"
                  value={form.max_tip_per_stream_usd}
                  onChange={(e) => update("max_tip_per_stream_usd", e.target.value)}
                  required
                  disabled={pending}
                />
              </Field>
            </div>
          </Section>

          <Separator />

          <Section title="Sponsorship limits">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Max per battle" htmlFor="edit_spon_battle" suffix="USD">
                <Input
                  id="edit_spon_battle"
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
              </Field>
              <Field label="Max per stream" htmlFor="edit_spon_stream" suffix="USD">
                <Input
                  id="edit_spon_stream"
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
              </Field>
            </div>
          </Section>

          <Separator />

          <Section title="Leaderboards">
            <div className="space-y-3">
              <ToggleRow
                label="Include in packy.gg official races"
                description="Keep OFF — paid-deal activity should not compete with organic users on the official race."
                checked={form.allow_site_leaderboards}
                onCheckedChange={(v) => update("allow_site_leaderboards", v)}
                disabled={pending}
              />
              <ToggleRow
                label="Creator-run leaderboards"
                description="Lets this creator create and run their own leaderboards for their community."
                checked={form.allow_code_leaderboards}
                onCheckedChange={(v) => update("allow_code_leaderboards", v)}
                disabled={pending}
              />
            </div>
          </Section>
        </form>

        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={pending} />}>
            Cancel
          </DialogClose>
          <Button type="submit" form={formId} disabled={pending} className="gap-1.5">
            {pending ? <Spinner size={14} /> : <Pencil className="size-4" />}
            {pending ? "Saving…" : "Save terms"}
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

function ToggleRow({
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
      <Switch checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
    </div>
  );
}
