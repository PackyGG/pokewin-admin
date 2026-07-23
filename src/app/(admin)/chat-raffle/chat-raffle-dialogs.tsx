"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Check, Dices, Plus, Settings2, Trash2, Wallet, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
import { formatCurrency } from "@/lib/utils/format";
import {
  CHAT_RAFFLE_FIXED_RULES,
  CHAT_RAFFLE_MAX_PRIZES,
  DEFAULT_CHAT_RAFFLE_SCORING,
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

function NumberField({
  id,
  label,
  hint,
  value,
  onChange,
  min,
  max,
  placeholder,
}: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  min?: number;
  max?: number;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9"
      />
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border px-3 py-2.5">
      <div className="min-w-0 space-y-0.5">
        <p className="text-xs font-medium">{label}</p>
        <p className="text-[11px] text-muted-foreground">{hint}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} className="mt-0.5" />
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
 * Create or edit a round: window, prize ladder, and every scoring knob in one
 * form. Editing is blocked server-side once a round is drawn, so this form is
 * only ever rendered for an editable round.
 */
export function RoundFormDialog({
  mode,
  round,
  defaultScoring,
  triggerLabel,
  triggerVariant = "default",
  triggerSize = "sm",
}: {
  mode: "create" | "edit";
  round?: RoundFormValues;
  /** Prefill for a new round — the most recent round's config. */
  defaultScoring?: ChatRaffleScoring;
  triggerLabel?: string;
  triggerVariant?: "default" | "outline" | "ghost";
  triggerSize?: "sm" | "default";
}) {
  const initialScoring =
    round?.scoring ?? defaultScoring ?? DEFAULT_CHAT_RAFFLE_SCORING;

  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState(round?.name ?? "");
  const [startsAt, setStartsAt] = useState(toLocalInputValue(round?.startsAt));
  const [endsAt, setEndsAt] = useState(
    toLocalInputValue(
      round?.endsAt ?? new Date(Date.now() + 7 * 86_400_000).toISOString(),
    ),
  );
  const [scoring, setScoring] = useState<ChatRaffleScoring>(initialScoring);
  const [prizes, setPrizes] = useState<PrizeDraft[]>(
    round?.prizes.length
      ? round.prizes.map((p) => ({
          amountUsd: String(p.amountUsd),
          label: p.label ?? "",
        }))
      : [{ amountUsd: "", label: "" }],
  );

  function setScoringField<K extends keyof ChatRaffleScoring>(
    key: K,
    value: ChatRaffleScoring[K],
  ) {
    setScoring((prev) => ({ ...prev, [key]: value }));
  }

  /** Number inputs round-trip as strings so a half-typed value isn't clamped. */
  function numField<K extends keyof ChatRaffleScoring>(key: K) {
    return {
      value: String(scoring[key] ?? ""),
      onChange: (v: string) => {
        const n = Number(v);
        setScoringField(key, (v === "" ? 0 : n) as ChatRaffleScoring[K]);
      },
    };
  }

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

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={<Button size={triggerSize} variant={triggerVariant} />}
      >
        {mode === "create" ? (
          <Plus className="mr-2 size-4" />
        ) : (
          <Settings2 className="mr-2 size-4" />
        )}
        {triggerLabel ?? (mode === "create" ? "New round" : "Edit round")}
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {mode === "create" ? "New raffle round" : "Edit raffle round"}
          </DialogTitle>
          <DialogDescription>
            Chat activity in the window below becomes points, points become
            tickets, and one ticket is drawn per prize place.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="round-name">Name</Label>
            <Input
              id="round-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Weekly chat raffle #1"
              maxLength={120}
              required
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="round-start">Starts</Label>
              <Input
                id="round-start"
                type="datetime-local"
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="round-end">Ends</Label>
              <Input
                id="round-end"
                type="datetime-local"
                value={endsAt}
                onChange={(e) => setEndsAt(e.target.value)}
                required
              />
            </div>
          </div>
          <p className="-mt-2 text-[11px] text-muted-foreground">
            Times are in your local timezone. Only messages inside the window
            earn tickets.
          </p>

          {/* ─── Prize ladder ─────────────────────────────────────── */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Prizes</Label>
              <span className="text-xs text-muted-foreground">
                Pool {formatCurrency(prizePool)}
              </span>
            </div>
            <div className="space-y-2">
              {prizes.map((p, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="w-8 shrink-0 text-center text-xs font-semibold text-muted-foreground">
                    #{i + 1}
                  </span>
                  <Input
                    type="number"
                    step="0.01"
                    min="0.01"
                    inputMode="decimal"
                    placeholder="Amount (USD)"
                    value={p.amountUsd}
                    onChange={(e) =>
                      setPrizes((prev) =>
                        prev.map((row, idx) =>
                          idx === i ? { ...row, amountUsd: e.target.value } : row,
                        ),
                      )
                    }
                    className="h-9"
                    required
                  />
                  <Input
                    placeholder="Label (optional)"
                    value={p.label}
                    maxLength={120}
                    onChange={(e) =>
                      setPrizes((prev) =>
                        prev.map((row, idx) =>
                          idx === i ? { ...row, label: e.target.value } : row,
                        ),
                      )
                    }
                    className="h-9"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-9 shrink-0"
                    aria-label={`Remove prize ${i + 1}`}
                    disabled={prizes.length === 1}
                    onClick={() =>
                      setPrizes((prev) => prev.filter((_, idx) => idx !== i))
                    }
                  >
                    <X className="size-4" />
                  </Button>
                </div>
              ))}
            </div>
            {prizes.length < CHAT_RAFFLE_MAX_PRIZES && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setPrizes((prev) => [...prev, { amountUsd: "", label: "" }])
                }
              >
                <Plus className="mr-2 size-3.5" />
                Add place
              </Button>
            )}
          </div>

          {/* ─── Scoring ──────────────────────────────────────────── */}
          <div className="space-y-3 rounded-xl border p-3">
            <div className="flex items-center gap-2">
              <Settings2 className="size-4 text-primary" />
              <span className="text-sm font-semibold">Points &amp; weights</span>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <NumberField
                id="pts-per-msg"
                label="Points per message"
                min={1}
                max={100}
                {...numField("pointsPerMessage")}
              />
              <NumberField
                id="min-chars"
                label="Minimum characters"
                hint="Shorter messages score nothing."
                min={1}
                max={500}
                {...numField("minMessageChars")}
              />
              <NumberField
                id="bucket-min"
                label="Rate-cap window (minutes)"
                min={1}
                max={1440}
                {...numField("bucketMinutes")}
              />
              <NumberField
                id="bucket-max"
                label="Max counted messages per window"
                hint="The anti-farm cap. Everything above it is dropped."
                min={1}
                max={1000}
                {...numField("maxMessagesPerBucket")}
              />
            </div>

            <ToggleRow
              label="Dedupe identical messages"
              hint="Repeating the same line counts once per window."
              checked={scoring.dedupeIdentical}
              onChange={(v) => setScoringField("dedupeIdentical", v)}
            />

            {/* The rules an operator can't switch off. Stated here so the
                form is honest about what it does NOT control. */}
            <ul className="space-y-1 rounded-lg bg-muted/40 px-3 py-2.5">
              {CHAT_RAFFLE_FIXED_RULES.map((rule) => (
                <li
                  key={rule}
                  className="flex items-start gap-1.5 text-[11px] text-muted-foreground"
                >
                  <Check className="mt-px size-3 shrink-0" aria-hidden />
                  {rule}
                </li>
              ))}
            </ul>
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
        <DialogHeader>
          <DialogTitle>Draw {roundName}?</DialogTitle>
          <DialogDescription>
            This freezes the standings and picks {prizeCount}{" "}
            {prizeCount === 1 ? "winner" : "winners"} from{" "}
            {totalTickets.toLocaleString()} tickets across{" "}
            {entrants.toLocaleString()}{" "}
            {entrants === 1 ? "entrant" : "entrants"}. The snapshot and the
            random seed are stored, so the draw stays reproducible — but it
            can&apos;t be undone or re-rolled.
          </DialogDescription>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          Nobody is paid yet. Each winner still has to be paid out
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
        <DialogHeader>
          <DialogTitle>Cancel {roundName}?</DialogTitle>
          <DialogDescription>
            The round stops counting and can never be drawn. Its config and
            manual adjustments are kept for the record.
          </DialogDescription>
        </DialogHeader>
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

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const delta = Number(points);
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
            className="size-7"
            aria-label={`Adjust points for ${username ?? userId}`}
          />
        }
      >
        <Settings2 className="size-3.5" />
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Adjust points — {username ?? userId}</DialogTitle>
          <DialogDescription>
            Currently on {currentPoints.toLocaleString()}{" "}
            {currentPoints === 1 ? "point" : "points"}. Adjustments stack on top
            of the scored total and are kept as a record.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="adjust-points">Points (+ or −)</Label>
            <Input
              id="adjust-points"
              type="number"
              inputMode="numeric"
              step="1"
              value={points}
              onChange={(e) => setPoints(e.target.value)}
              placeholder="-50"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="adjust-reason">Reason</Label>
            <Input
              id="adjust-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Copy-pasting the same line all evening"
              minLength={3}
              maxLength={500}
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
    toast.success(`Paid ${formatCurrency(amountUsd)} to ${winnerUsername ?? "the winner"}`);
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
        <DialogHeader>
          <DialogTitle>Pay place #{position}</DialogTitle>
          <DialogDescription>
            Credits {formatCurrency(amountUsd)} to{" "}
            <span className="font-medium text-foreground">
              {winnerUsername ?? "the drawn winner"}
            </span>{" "}
            for {roundName}. This writes a real balance adjustment and a ledger
            entry, tagged as a chat-raffle prize.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="pay-totp">2FA code</Label>
            <Input
              id="pay-totp"
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
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
