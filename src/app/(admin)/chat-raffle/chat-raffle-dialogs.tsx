"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  CalendarClock,
  Check,
  Dices,
  Gift,
  Plus,
  ShieldCheck,
  Sliders,
  Sparkles,
  Ticket,
  Trash2,
  Trophy,
  Users,
  Wallet,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ux";
import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import {
  CHAT_RAFFLE_FIXED_RULES,
  CHAT_RAFFLE_MAX_PRIZES,
  CHAT_RAFFLE_MAX_WINDOW_DAYS,
  DEFAULT_CHAT_RAFFLE_SCORING,
  positionColor,
  type ChatRaffleScoring,
} from "@/lib/chat-raffle/config";
import {
  addChatRaffleAdjustment,
  cancelChatRaffleRound,
  createChatRaffleRound,
  drawChatRaffleRound,
  payChatRafflePrize,
  updateChatRaffleRound,
} from "./actions";

/**
 * Client dialogs for the Chat Raffle. Every one of them follows the house
 * server-action contract: the action never throws across the RSC boundary, it
 * returns `{ success, error? }`, and the caller branches on it and toasts.
 *
 * Layout convention shared by all four: an icon-chip header (same chip as
 * SectionHeading), body content grouped into bordered sections with their own
 * small heading, and the dialog's own sticky footer for the actions. Flat
 * surfaces only — no gradient/glow fills, per the app-wide flat standard.
 */

type PrizeDraft = { amountUsd: string; label: string };

/** ISO instant → the `datetime-local` input's value, in the viewer's zone. */
function toLocalInputValue(iso?: string): string {
  const d = iso ? new Date(iso) : new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}

/** `datetime-local` value (parsed as local time) → ISO instant. */
function fromLocalInputValue(value: string): string | null {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Human window length for the live chip next to the date inputs. Worth
 * showing because the window is capped at CHAT_RAFFLE_MAX_WINDOW_DAYS and
 * two `datetime-local` values don't make their own span obvious.
 */
function describeWindow(
  startLocal: string,
  endLocal: string,
): { text: string; tooLong: boolean } | null {
  const start = new Date(startLocal);
  const end = new Date(endLocal);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  const ms = end.getTime() - start.getTime();
  if (ms <= 0) return { text: "Ends before it starts", tooLong: true };

  const hours = ms / 3_600_000;
  const days = ms / 86_400_000;
  const text =
    hours < 48
      ? `${Math.round(hours)}h`
      : `${days % 1 === 0 ? days : days.toFixed(1)} days`;
  return { text, tooLong: days > CHAT_RAFFLE_MAX_WINDOW_DAYS };
}

// ─── Shared dialog chrome ───────────────────────────────────────────

/** Icon-chip dialog header — mirrors the SectionHeading chip on the pages. */
function DialogHeading({
  icon: Icon,
  title,
  description,
}: {
  icon: React.ElementType;
  title: React.ReactNode;
  description?: React.ReactNode;
}) {
  return (
    <DialogHeader>
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 shrink-0 rounded-lg bg-primary/10 p-1.5">
          <Icon className="size-4 text-primary" aria-hidden />
        </div>
        <div className="min-w-0 space-y-1">
          <DialogTitle className="pr-6">{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </div>
      </div>
    </DialogHeader>
  );
}

/** Bordered body section with a small icon heading. */
function FormSection({
  icon: Icon,
  title,
  action,
  children,
}: {
  icon: React.ElementType;
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3 rounded-xl border p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Icon className="size-3.5 text-muted-foreground" aria-hidden />
          <h3 className="text-xs font-semibold tracking-wide uppercase text-muted-foreground">
            {title}
          </h3>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Compact read-only figure, used in the confirm dialogs. */
function StatChip({
  icon: Icon,
  label,
  value,
  valueClassName,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border px-3 py-2">
      <span className="flex items-center gap-1 text-[10px] tracking-wide uppercase text-muted-foreground">
        <Icon className="size-3" aria-hidden />
        {label}
      </span>
      <span className={cn("tabular-nums text-sm font-semibold", valueClassName)}>
        {value}
      </span>
    </div>
  );
}

export type RoundFormValues = {
  id: string;
  name: string;
  startsAt: string;
  endsAt: string;
  scoring: ChatRaffleScoring;
  prizes: { position: number; amountUsd: number; label: string | null }[];
};

/**
 * Create or edit a round. Community XP owns scoring globally, so operators
 * choose only the time window and prize ladder here.
 */
export function RoundFormDialog({
  mode,
  round,
  triggerLabel,
  triggerVariant = "default",
  triggerSize = "sm",
}: {
  mode: "create" | "edit";
  round?: RoundFormValues;
  triggerLabel?: string;
  triggerVariant?: "default" | "outline" | "ghost";
  triggerSize?: "sm" | "default";
}) {
  const scoring = round?.scoring ?? DEFAULT_CHAT_RAFFLE_SCORING;

  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState(round?.name ?? "");
  const [startsAt, setStartsAt] = useState(toLocalInputValue(round?.startsAt));
  const [endsAt, setEndsAt] = useState(
    toLocalInputValue(
      round?.endsAt ?? new Date(Date.now() + 7 * 86_400_000).toISOString(),
    ),
  );
  const [prizes, setPrizes] = useState<PrizeDraft[]>(
    round?.prizes.length
      ? round.prizes.map((p) => ({
          amountUsd: String(p.amountUsd),
          label: p.label ?? "",
        }))
      : [{ amountUsd: "", label: "" }],
  );

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();

    const startsIso = fromLocalInputValue(startsAt);
    const endsIso = fromLocalInputValue(endsAt);
    if (!startsIso || !endsIso) {
      toast.error("Pick a valid start and end time.");
      return;
    }

    const parsedPrizes = prizes.map((p, i) => ({
      position: i + 1,
      amountUsd: Number(p.amountUsd),
      label: p.label.trim() || undefined,
    }));
    if (parsedPrizes.some((p) => !Number.isFinite(p.amountUsd) || p.amountUsd <= 0)) {
      toast.error("Every prize needs a positive amount.");
      return;
    }

    setLoading(true);
    const payload = {
      name: name.trim(),
      startsAt: startsIso,
      endsAt: endsIso,
      scoring,
      prizes: parsedPrizes,
    };
    const result =
      mode === "create"
        ? await createChatRaffleRound(payload)
        : await updateChatRaffleRound({ roundId: round!.id, ...payload });
    setLoading(false);

    if (!result.success) {
      toast.error(result.error);
      return;
    }
    toast.success(mode === "create" ? "Round created" : "Round updated");
    setOpen(false);
  }

  const prizePool = prizes.reduce((sum, p) => {
    const n = Number(p.amountUsd);
    return Number.isFinite(n) ? sum + n : sum;
  }, 0);
  // NOT named `window` — that would shadow the DOM global in a client component.
  const windowSpan = describeWindow(startsAt, endsAt);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={<Button size={triggerSize} variant={triggerVariant} />}
      >
        {mode === "create" ? (
          <Plus className="mr-2 size-4" />
        ) : (
          <Sliders className="mr-2 size-4" />
        )}
        {triggerLabel ?? (mode === "create" ? "New round" : "Edit round")}
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeading
          icon={mode === "create" ? Sparkles : Sliders}
          title={mode === "create" ? "New raffle round" : "Edit raffle round"}
          description="Community XP earned from Discord and linked on-site chat in the window becomes tickets."
        />

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* ─── Round ──────────────────────────────────────────── */}
          <FormSection
            icon={CalendarClock}
            title="Round"
            action={
              windowSpan && (
                <span
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-[10px] font-medium tabular-nums",
                    windowSpan.tooLong
                      ? "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400"
                      : "text-muted-foreground",
                  )}
                >
                  {windowSpan.text}
                </span>
              )
            }
          >
            <Input
              id="round-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Weekly chat raffle #1"
              maxLength={120}
              required
              aria-label="Round name"
              className="font-medium"
            />

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="round-start" className="text-xs">
                  Starts
                </Label>
                <Input
                  id="round-start"
                  type="datetime-local"
                  value={startsAt}
                  onChange={(e) => setStartsAt(e.target.value)}
                  required
                  className="h-9"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="round-end" className="text-xs">
                  Ends
                </Label>
                <Input
                  id="round-end"
                  type="datetime-local"
                  value={endsAt}
                  onChange={(e) => setEndsAt(e.target.value)}
                  required
                  className="h-9"
                />
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Your local timezone. Only messages inside the window earn tickets.
            </p>
          </FormSection>

          {/* ─── Prizes ─────────────────────────────────────────── */}
          <FormSection
            icon={Gift}
            title="Prizes"
            action={
              <span className="tabular-nums text-sm font-semibold text-rose-600 dark:text-rose-400">
                {formatCurrency(prizePool)}
              </span>
            }
          >
            <div className="space-y-2">
              {prizes.map((p, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span
                    className={cn(
                      "flex size-8 shrink-0 items-center justify-center rounded-full border text-[11px] font-bold tabular-nums",
                      positionColor(i + 1),
                    )}
                  >
                    {i + 1 <= 3 ? <Trophy className="size-3.5" /> : i + 1}
                  </span>
                  <InputGroup className="h-9 flex-1">
                    <InputGroupAddon align="inline-start">$</InputGroupAddon>
                    <InputGroupInput
                      type="number"
                      step="0.01"
                      min="0.01"
                      inputMode="decimal"
                      placeholder="0.00"
                      aria-label={`Prize amount for place ${i + 1}`}
                      value={p.amountUsd}
                      onChange={(e) =>
                        setPrizes((prev) =>
                          prev.map((row, idx) =>
                            idx === i ? { ...row, amountUsd: e.target.value } : row,
                          ),
                        )
                      }
                      className="tabular-nums"
                      required
                    />
                  </InputGroup>
                  <Input
                    placeholder="Label (optional)"
                    aria-label={`Label for place ${i + 1}`}
                    value={p.label}
                    maxLength={120}
                    onChange={(e) =>
                      setPrizes((prev) =>
                        prev.map((row, idx) =>
                          idx === i ? { ...row, label: e.target.value } : row,
                        ),
                      )
                    }
                    className="h-9 flex-1"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-8 shrink-0 text-muted-foreground hover:text-foreground"
                    aria-label={`Remove place ${i + 1}`}
                    disabled={prizes.length === 1}
                    onClick={() =>
                      setPrizes((prev) => prev.filter((_, idx) => idx !== i))
                    }
                  >
                    <X className="size-3.5" />
                  </Button>
                </div>
              ))}
            </div>
            {prizes.length < CHAT_RAFFLE_MAX_PRIZES && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full border-dashed"
                onClick={() =>
                  setPrizes((prev) => [...prev, { amountUsd: "", label: "" }])
                }
              >
                <Plus className="mr-2 size-3.5" />
                Add place
              </Button>
            )}
          </FormSection>

          {/* ─── Fixed rules ────────────────────────────────────── */}
          <FormSection icon={ShieldCheck} title="Always applied">
            <ul className="grid gap-1.5 sm:grid-cols-2">
              {CHAT_RAFFLE_FIXED_RULES.map((rule) => (
                <li
                  key={rule}
                  className="flex items-start gap-1.5 text-[11px] leading-snug text-muted-foreground"
                >
                  <Check
                    className="mt-px size-3 shrink-0 text-emerald-600 dark:text-emerald-400"
                    aria-hidden
                  />
                  {rule}
                </li>
              ))}
            </ul>
          </FormSection>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={loading}>
              {loading && <Spinner className="mr-2 size-4" />}
              {mode === "create" ? "Create round" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Freeze the standings and pick the winners. Irreversible, so it confirms. */
export function DrawRoundButton({
  roundId,
  roundName,
  entrants,
  totalTickets,
  prizeCount,
  disabled,
}: {
  roundId: string;
  roundName: string;
  entrants: number;
  totalTickets: number;
  prizeCount: number;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleDraw() {
    setLoading(true);
    const result = await drawChatRaffleRound({ roundId });
    setLoading(false);
    if (!result.success) {
      toast.error(result.error);
      return;
    }
    toast.success(
      result.data.winners === 1
        ? "Winner drawn"
        : `${result.data.winners} winners drawn`,
    );
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" disabled={disabled} />}>
        <Dices className="mr-2 size-4" />
        Draw winners
      </DialogTrigger>
      <DialogContent>
        <DialogHeading
          icon={Dices}
          title={`Draw ${roundName}?`}
          description="This freezes the standings and picks the winners. The snapshot and the random seed are stored, so the draw stays reproducible — but it can't be undone or re-rolled."
        />

        <div className="grid grid-cols-3 gap-2">
          <StatChip icon={Users} label="Entrants" value={formatNumber(entrants)} />
          <StatChip icon={Ticket} label="Tickets" value={formatNumber(totalTickets)} />
          <StatChip icon={Trophy} label="Places" value={formatNumber(prizeCount)} />
        </div>

        <p className="text-xs text-muted-foreground">
          Nobody is paid yet — each winner still has to be paid out
          individually.
        </p>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={loading}
          >
            Cancel
          </Button>
          <Button onClick={handleDraw} disabled={loading}>
            {loading && <Spinner className="mr-2 size-4" />}
            Draw now
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CancelRoundButton({
  roundId,
  roundName,
}: {
  roundId: string;
  roundName: string;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleCancel() {
    setLoading(true);
    const result = await cancelChatRaffleRound({ roundId });
    setLoading(false);
    if (!result.success) {
      toast.error(result.error);
      return;
    }
    toast.success("Round cancelled");
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" variant="outline" />}>
        <Trash2 className="mr-2 size-4" />
        Cancel
      </DialogTrigger>
      <DialogContent>
        <DialogHeading
          icon={Trash2}
          title={`Cancel ${roundName}?`}
          description="The round stops counting and can never be drawn. Its config and manual adjustments are kept for the record."
        />
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={loading}
          >
            Keep it
          </Button>
          <Button variant="destructive" onClick={handleCancel} disabled={loading}>
            {loading && <Spinner className="mr-2 size-4" />}
            Cancel round
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Manual per-user point correction inside a round. */
export function AdjustPointsDialog({
  roundId,
  userId,
  username,
  currentPoints,
}: {
  roundId: string;
  userId: string;
  username: string | null;
  currentPoints: number;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [points, setPoints] = useState("");
  const [reason, setReason] = useState("");

  const delta = Number(points);
  const preview =
    points !== "" && Number.isInteger(delta)
      ? Math.max(0, currentPoints + delta)
      : null;

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!Number.isInteger(delta) || delta === 0) {
      toast.error("Enter a whole, non-zero number of points.");
      return;
    }
    setLoading(true);
    const result = await addChatRaffleAdjustment({
      roundId,
      userId,
      points: delta,
      reason: reason.trim(),
    });
    setLoading(false);
    if (!result.success) {
      toast.error(result.error);
      return;
    }
    toast.success("Points adjusted");
    setPoints("");
    setReason("");
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground hover:text-foreground"
            aria-label={`Adjust points for ${username ?? userId}`}
          />
        }
      >
        <Sliders className="size-3.5" />
      </DialogTrigger>
      <DialogContent>
        <DialogHeading
          icon={Sliders}
          title={`Adjust points — ${username ?? userId.slice(0, 8)}`}
          description="Adjustments stack on top of the scored total and are kept as a record."
        />

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Live before → after, so a typo'd sign is visible before it lands. */}
          <div className="flex items-center justify-center gap-3 rounded-xl border px-3 py-3">
            <div className="flex flex-col items-center gap-0.5">
              <span className="text-[10px] tracking-wide uppercase text-muted-foreground">
                Now
              </span>
              <span className="tabular-nums text-base font-semibold">
                {formatNumber(currentPoints)}
              </span>
            </div>
            <span aria-hidden className="text-muted-foreground">
              →
            </span>
            <div className="flex flex-col items-center gap-0.5">
              <span className="text-[10px] tracking-wide uppercase text-muted-foreground">
                After
              </span>
              <span
                className={cn(
                  "tabular-nums text-base font-semibold",
                  preview === null && "text-muted-foreground",
                )}
              >
                {preview === null ? "—" : formatNumber(preview)}
              </span>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="adjust-points" className="text-xs">
              Points (+ or −)
            </Label>
            <Input
              id="adjust-points"
              type="number"
              inputMode="numeric"
              step="1"
              value={points}
              onChange={(e) => setPoints(e.target.value)}
              placeholder="-50"
              className="h-9 tabular-nums"
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="adjust-reason" className="text-xs">
              Reason
            </Label>
            <Input
              id="adjust-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Copy-pasting the same line all evening"
              minLength={3}
              maxLength={500}
              className="h-9"
              required
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={loading}>
              {loading && <Spinner className="mr-2 size-4" />}
              Apply
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Pay a drawn winner. Goes through the normal balance-adjustment path, so it
 * needs a 2FA code — and the operator also needs balance-adjustment access.
 */
export function PayPrizeDialog({
  prizeId,
  position,
  amountUsd,
  winnerUsername,
  roundName,
}: {
  prizeId: string;
  position: number;
  amountUsd: number;
  winnerUsername: string | null;
  roundName: string;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [totpCode, setTotpCode] = useState("");

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    const result = await payChatRafflePrize({ prizeId, totpCode });
    setLoading(false);
    if (!result.success) {
      toast.error(result.error);
      return;
    }
    toast.success(
      `Paid ${formatCurrency(amountUsd)} to ${winnerUsername ?? "the winner"}`,
    );
    setTotpCode("");
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" variant="outline" />}>
        <Wallet className="mr-2 size-3.5" />
        Pay
      </DialogTrigger>
      <DialogContent>
        <DialogHeading
          icon={Wallet}
          title={`Pay place #${position}`}
          description={`Writes a real balance adjustment and a ledger entry for ${roundName}, tagged as a chat-raffle prize.`}
        />

        {/* The amount, unmissable. Rose = money leaving the house (house POV). */}
        <div className="flex items-center justify-between gap-3 rounded-xl border px-4 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-full border text-[11px] font-bold",
                positionColor(position),
              )}
            >
              <Trophy className="size-3.5" />
            </span>
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-semibold">
                {winnerUsername ?? "The drawn winner"}
              </span>
              <span className="text-[11px] text-muted-foreground">
                Place #{position}
              </span>
            </div>
          </div>
          <span className="shrink-0 tabular-nums text-lg font-semibold text-rose-600 dark:text-rose-400">
            {formatCurrency(amountUsd)}
          </span>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="pay-totp" className="text-xs">
              2FA code
            </Label>
            <Input
              id="pay-totp"
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              className="h-9 tabular-nums tracking-[0.3em]"
              required
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={loading}>
              {loading && <Spinner className="mr-2 size-4" />}
              Pay {formatCurrency(amountUsd)}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
