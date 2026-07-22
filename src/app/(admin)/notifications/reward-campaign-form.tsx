"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  CheckCircle2,
  CopyCheck,
  Play,
  RotateCcw,
  Ticket,
  TriangleAlert,
  UserX,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import {
  BULK_MAX_ITEMS,
  REWARD_MAX_VALUE_USD,
  parseRecipients,
  validateCampaignSlug,
} from "@/lib/user-notification";
import { sendRewardCampaignChunkAction } from "./reward-actions";
import { NotificationUserPicker } from "./notification-user-picker";

const RECIPIENT_PLACEHOLDER = `kX9mQ2pLr7vNa4bT8cZfE1yH6wJ3sD0g
aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY

one user id per line — or paste a CSV with a user_id column`;

type ChunkTotals = {
  requested: number;
  created: number;
  deduped: number;
  codesMinted: number;
  codesReused: number;
  unknown: string[];
};

type Failure = { chunkIndex: number; error: string };

/**
 * Reward campaign — the "$ amount in, codes out" flow.
 *
 * The operator supplies an amount and a recipient list; every code is minted
 * server-side (derived, single-use, bound to its recipient) and delivered as
 * a `promo_code_granted` notification. No payload JSON and no type field:
 * both are fixed by the flow, and letting them be edited here would only
 * create ways to send a code the site can't render.
 *
 * Chunks are sent one at a time against a snapshot taken when the send
 * starts, so editing the form after a failure can't change what a retry
 * sends. Retrying is safe by construction — codes are derived, so a replay
 * reuses them rather than minting a second set.
 */
export function RewardCampaignForm() {
  const [campaign, setCampaign] = useState("");
  const [amount, setAmount] = useState("25");
  const [expiresInDays, setExpiresInDays] = useState("");
  const [recipientsText, setRecipientsText] = useState("");
  const [chunkSize, setChunkSize] = useState(BULK_MAX_ITEMS);

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

  const slugError = campaign.trim() ? validateCampaignSlug(campaign) : null;
  const valueUsd = Number(amount);
  const amountError =
    amount.trim() === ""
      ? "Amount is required"
      : !Number.isFinite(valueUsd) || valueUsd <= 0
        ? "Amount must be greater than zero"
        : valueUsd > REWARD_MAX_VALUE_USD
          ? `Capped at $${REWARD_MAX_VALUE_USD} per code`
          : null;

  const parsed = useMemo(
    () => (recipientsText.trim() ? parseRecipients(recipientsText) : null),
    [recipientsText],
  );

  /** Unique recipient ids, chunked. Payload columns in a pasted CSV are
   * ignored here — the payload of a reward notification is the minted code,
   * not anything the operator types. */
  const chunks = useMemo(() => {
    if (!parsed?.ok) return null;
    const ids = [...new Set(parsed.recipients.map((r) => r.userId))];
    if (ids.length === 0) return null;
    const size = Math.min(Math.max(1, chunkSize || 1), BULK_MAX_ITEMS);
    const out: string[][] = [];
    for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
    return out;
  }, [parsed, chunkSize]);

  const recipientCount = chunks?.reduce((n, c) => n + c.length, 0) ?? 0;

  const totals = useMemo(() => {
    const unknown = new Set<string>();
    const acc = {
      requested: 0,
      created: 0,
      deduped: 0,
      codesMinted: 0,
      codesReused: 0,
    };
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

  const readyToSend =
    !sending &&
    chunks !== null &&
    chunks.length > 0 &&
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
          toast.error(`Chunk ${i + 1} failed — retrying it is safe`);
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
    if (!chunks) return;
    const days = Number(expiresInDays);
    const plan = {
      chunks,
      campaign: campaign.trim(),
      valueUsd,
      expiresInDays:
        expiresInDays.trim() !== "" && Number.isFinite(days) && days > 0
          ? days
          : null,
    };
    setSent(plan);
    setResults([]);
    setCurrentChunk(0);
    void run(plan, 0);
  }

  function handleReset() {
    setResults([]);
    setFailure(null);
    setCurrentChunk(0);
    setSent(null);
  }

  const done = results.length;
  const total = sent?.chunks.length ?? chunks?.length ?? 0;
  const progressPct = total > 0 ? Math.round((done / total) * 100) : 0;
  const exposure = recipientCount * (Number.isFinite(valueUsd) ? valueUsd : 0);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Campaign slug</Label>
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
            {slugError ?? "Also seeds each code. Keep it stable — a retry reuses codes."}
          </p>
        </div>

        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Amount per user</Label>
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
              className="pl-6"
              disabled={sending}
            />
          </div>
          <p
            className={`text-[11px] ${amountError ? "text-rose-600 dark:text-rose-400" : "text-muted-foreground"}`}
          >
            {amountError ??
              `One single-use code each, max $${REWARD_MAX_VALUE_USD} per code.`}
          </p>
        </div>

        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">
            Expires in (days)
          </Label>
          <Input
            type="number"
            min={0}
            value={expiresInDays}
            onChange={(e) => setExpiresInDays(e.target.value)}
            placeholder="never"
            disabled={sending}
          />
          <p className="text-[11px] text-muted-foreground">
            Leave empty for no expiry.
          </p>
        </div>
      </div>

      <div className="space-y-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label className="text-xs text-muted-foreground">Recipients</Label>
          <div className="w-56">
            <NotificationUserPicker
              disabled={sending}
              label="Add a user to the list…"
              onSelect={(u) =>
                setRecipientsText((cur) =>
                  cur.trim() ? `${cur.replace(/\s+$/, "")}\n${u.id}` : u.id,
                )
              }
            />
          </div>
        </div>
        <Textarea
          value={recipientsText}
          onChange={(e) => setRecipientsText(e.target.value)}
          rows={8}
          spellCheck={false}
          className="font-mono text-xs"
          placeholder={RECIPIENT_PLACEHOLDER}
          disabled={sending}
        />
        {parsed && !parsed.ok ? (
          <p className="text-[11px] text-rose-600 dark:text-rose-400">
            {parsed.error}
          </p>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            {parsed?.ok
              ? `${formatNumber(recipientCount)} unique recipients${
                  parsed.recipients.length !== recipientCount
                    ? ` (${parsed.recipients.length - recipientCount} duplicate id(s) collapsed)`
                    : ""
                }`
              : "One user id per line. CSV payload columns are ignored — the payload is the minted code."}
          </p>
        )}
      </div>

      <div className="space-y-1 sm:w-40">
        <Label className="text-xs text-muted-foreground">Chunk size</Label>
        <Input
          type="number"
          min={1}
          max={BULK_MAX_ITEMS}
          value={chunkSize}
          onChange={(e) => setChunkSize(Number(e.target.value))}
          className="text-xs"
          disabled={sending}
        />
      </div>

      <PreviewCard valueUsd={valueUsd} />

      {recipientCount > 0 && !amountError && (
        <div className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <p className="text-xs text-amber-700 dark:text-amber-300">
            This mints <strong>{formatNumber(recipientCount)}</strong> real
            promo codes worth{" "}
            <strong>{formatCurrency(exposure)}</strong> in total, across{" "}
            {formatNumber(total)} request{total === 1 ? "" : "s"}. Each code is
            single-use and only redeemable by the account it was minted for.
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={handleStart} disabled={!readyToSend} className="gap-1.5">
          <Play className="size-4" />
          {sending
            ? `Sending chunk ${currentChunk + 1} of ${total}…`
            : `Send ${formatNumber(recipientCount)} rewards`}
        </Button>
        {failure && sent && (
          <Button
            variant="outline"
            onClick={() => void run(sent, failure.chunkIndex)}
            disabled={sending}
            className="gap-1.5"
          >
            <RotateCcw className="size-4" />
            Retry from chunk {failure.chunkIndex + 1}
          </Button>
        )}
        {(results.length > 0 || failure) && !sending && (
          <Button variant="ghost" size="sm" onClick={handleReset}>
            Clear results
          </Button>
        )}
      </div>

      {(sending || results.length > 0) && total > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>
              Chunk {Math.min(done + (sending ? 1 : 0), total)} of {total}
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
            Chunk {failure.chunkIndex + 1} failed
          </p>
          <p className="text-xs text-rose-700/90 dark:text-rose-300/90">
            {failure.error}
          </p>
          <p className="text-[11px] text-rose-700/70 dark:text-rose-300/70">
            Codes are derived from the campaign slug, so a retry reuses any
            already minted instead of creating a second set.
          </p>
        </div>
      )}

      {results.length > 0 && (
        <div className="space-y-3 rounded-md border p-3">
          <p className="text-xs font-medium">
            {done} of {total} chunk{total === 1 ? "" : "s"} ·{" "}
            {formatNumber(totals.requested)} recipients ·{" "}
            {formatCurrency(totals.codesMinted * (sent?.valueUsd ?? 0))} newly
            issued
          </p>

          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <CountTile
              icon={Ticket}
              label="Codes minted"
              value={totals.codesMinted}
              accent="text-emerald-600 dark:text-emerald-400"
              hint="New single-use codes created"
            />
            <CountTile
              icon={CopyCheck}
              label="Codes reused"
              value={totals.codesReused}
              accent="text-blue-600 dark:text-blue-400"
              hint="Already existed from an earlier attempt"
            />
            <CountTile
              icon={CheckCircle2}
              label="Delivered"
              value={totals.created}
              accent="text-emerald-600 dark:text-emerald-400"
              hint="Notification rows inserted"
            />
            <CountTile
              icon={UserX}
              label="Unknown users"
              value={totals.unknown.length}
              accent="text-amber-600 dark:text-amber-400"
              hint="Ids that don't exist — no code minted"
            />
          </div>

          {totals.deduped > 0 && (
            <p className="text-[11px] text-muted-foreground">
              {formatNumber(totals.deduped)} notification
              {totals.deduped === 1 ? "" : "s"} already delivered — normal on a
              retry, not an error.
            </p>
          )}

          {totals.unknown.length > 0 && (
            <pre className="max-h-32 overflow-auto rounded bg-muted/50 p-2 font-mono text-[10px] leading-relaxed">
              {totals.unknown.join("\n")}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/** The recipient's view. The code shown is a shape, not a real one — codes
 * are derived server-side from a secret the browser never sees. */
function PreviewCard({ valueUsd }: { valueUsd: number }) {
  const worth = Number.isFinite(valueUsd) && valueUsd > 0 ? valueUsd : 0;
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">
        What the user sees
      </p>
      <div className="flex gap-3 rounded-md border bg-muted/30 p-3">
        <div className="mt-0.5 shrink-0 rounded-lg bg-primary/10 p-1.5">
          <Ticket className="size-3.5 text-primary" />
        </div>
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="text-sm font-medium">
            {worth ? `${formatCurrency(worth)} promo code for you` : "Promo code for you"}
          </p>
          <p className="text-xs text-muted-foreground">
            Redeem it in your wallet.
          </p>
          <span className="mt-1.5 flex items-center gap-2 rounded-md border bg-background px-2 py-1">
            <span className="flex-1 truncate font-mono text-xs font-semibold tracking-wider text-muted-foreground">
              PACKY-••••-••••-••••
            </span>
            <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
              tap to copy
            </Badge>
          </span>
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Each recipient gets a different code, single-use, and rejected for any
        account other than theirs.
      </p>
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
