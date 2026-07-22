"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  CheckCircle2,
  CircleAlert,
  Copy,
  CopyCheck,
  Play,
  RotateCcw,
  UserX,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatNumber } from "@/lib/utils/format";
import {
  BULK_MAX_ITEMS,
  NOTIFICATION_PAYLOAD_MAX_BYTES,
  NOTIFICATION_TYPE_MAX,
  buildBulkItems,
  chunkBulkItems,
  jsonByteSize,
  parsePayloadJson,
  parseRecipients,
  validateCampaignSlug,
  validateNotificationType,
  type BulkNotificationItem,
  type UserNotificationCategory,
} from "@/lib/user-notification";
import { sendBulkNotificationChunkAction } from "./direct-actions";
import { NotificationUserPicker } from "./notification-user-picker";
import { NotificationPreview } from "./notification-preview";
import type { BulkNotificationResult } from "@/lib/backend-api/user-notifications";

const RECIPIENT_PLACEHOLDER = `user_id,code,value
kX9mQ2pLr7vNa4bT8cZfE1yH6wJ3sD0g,PACKY-A1B2-C3D4,25
aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY,PACKY-E5F6-G7H8,25

— or one id per line, or a JSON array of { user_id, payload }`;

type Failure = { chunkIndex: number; error: string };

/**
 * Bulk composer for `POST /admin/notifications/bulk`.
 *
 * The whole list is validated and chunked BEFORE the first request goes out —
 * a 400 on chunk 12 of 17 is a bad experience, and every rule the backend
 * enforces is checkable client-side.
 *
 * Chunks are sent SEQUENTIALLY from the client (one server action per chunk)
 * rather than in one long action: each chunk is a single multi-row INSERT
 * server-side with no reason to stampede it, progress stays live, and a
 * 17-chunk campaign can't blow one action's budget.
 *
 * Failure handling leans entirely on `dedupe_key` — `(user_id, dedupe_key)` is
 * backed by a partial unique index, so retrying the failed chunk verbatim is
 * always safe. Already-delivered items come back as `deduped`, which is why
 * that counter is presented as normal rather than as an error.
 */
export function BulkNotificationForm() {
  const [campaign, setCampaign] = useState("");
  const [category, setCategory] = useState<UserNotificationCategory>("rewards");
  const [type, setType] = useState("promo_code_granted");
  const [sharedPayloadText, setSharedPayloadText] = useState("");
  const [recipientsText, setRecipientsText] = useState("");
  const [chunkSize, setChunkSize] = useState(BULK_MAX_ITEMS);

  const [sending, setSending] = useState(false);
  const [currentChunk, setCurrentChunk] = useState(0);
  const [results, setResults] = useState<BulkNotificationResult[]>([]);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [copied, setCopied] = useState(false);

  const slugError = campaign.trim() ? validateCampaignSlug(campaign) : null;
  const typeError = validateNotificationType(type);
  const sharedCheck = useMemo(
    () => parsePayloadJson(sharedPayloadText),
    [sharedPayloadText],
  );
  const parsed = useMemo(
    () => (recipientsText.trim() ? parseRecipients(recipientsText) : null),
    [recipientsText],
  );

  /** Wire items + chunk plan. Null until everything upstream is valid. */
  const plan = useMemo<
    | { ok: true; chunks: BulkNotificationItem[][] }
    | { ok: false; error: string }
    | null
  >(() => {
    if (!parsed?.ok || !sharedCheck.ok) return null;
    if (validateCampaignSlug(campaign)) return null;
    const built = buildBulkItems(parsed.recipients, {
      campaign,
      sharedPayload: sharedCheck.payload,
    });
    if (!built.ok) return { ok: false, error: built.error };
    const size = Math.min(Math.max(1, chunkSize || 1), BULK_MAX_ITEMS);
    return { ok: true, chunks: chunkBulkItems(built.items, { maxItems: size }) };
  }, [parsed, sharedCheck, campaign, chunkSize]);

  const planError = plan && !plan.ok ? plan.error : null;
  const chunks = plan && plan.ok ? plan.chunks : null;

  const totals = useMemo(() => {
    const unknown = new Set<string>();
    let requested = 0;
    let created = 0;
    let deduped = 0;
    for (const r of results) {
      requested += r.requested;
      created += r.created;
      deduped += r.deduped;
      for (const id of r.unknown_users) unknown.add(id);
    }
    return { requested, created, deduped, unknown: [...unknown] };
  }, [results]);

  const readyToSend =
    !sending &&
    chunks !== null &&
    chunks.length > 0 &&
    !slugError &&
    !typeError &&
    campaign.trim() !== "";

  async function run(fromChunk: number) {
    if (!chunks) return;
    setSending(true);
    setFailure(null);
    try {
      for (let i = fromChunk; i < chunks.length; i++) {
        setCurrentChunk(i);
        const res = await sendBulkNotificationChunkAction({
          category,
          type: type.trim(),
          items: chunks[i],
          campaign: campaign.trim(),
          chunkIndex: i,
          chunkCount: chunks.length,
        });
        if (!res.success) {
          setFailure({ chunkIndex: i, error: res.error });
          toast.error(`Chunk ${i + 1} failed — retrying it is safe`);
          return;
        }
        setResults((prev) => [...prev, res.result]);
      }
      toast.success("Campaign sent");
    } finally {
      setSending(false);
    }
  }

  function handleStart() {
    setResults([]);
    setCurrentChunk(0);
    void run(0);
  }

  function handleReset() {
    setResults([]);
    setFailure(null);
    setCurrentChunk(0);
  }

  async function copyUnknown() {
    try {
      await navigator.clipboard.writeText(totals.unknown.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy to clipboard");
    }
  }

  const done = results.length;
  const total = chunks?.length ?? 0;
  const progressPct = total > 0 ? Math.round((done / total) * 100) : 0;
  const previewItem = chunks?.[0]?.[0];

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
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
            {slugError ??
              "Dedupe key is derived as `slug:user_id`. Keep it stable — a timestamp or random suffix defeats the retry guarantee."}
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Category</Label>
            <Select
              value={category}
              onValueChange={(v) => setCategory(v as UserNotificationCategory)}
            >
              <SelectTrigger className="w-full" disabled={sending}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="rewards">rewards</SelectItem>
                <SelectItem value="system">system</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Type</Label>
            <Input
              value={type}
              onChange={(e) => setType(e.target.value)}
              placeholder="promo_code_granted"
              maxLength={NOTIFICATION_TYPE_MAX}
              className="font-mono text-xs"
              disabled={sending}
            />
          </div>
        </div>
      </div>
      {typeError && (
        <p className="text-[11px] text-rose-600 dark:text-rose-400">{typeError}</p>
      )}

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
          rows={9}
          spellCheck={false}
          className="font-mono text-xs"
          placeholder={RECIPIENT_PLACEHOLDER}
          disabled={sending}
        />
        <RecipientSummary parsed={parsed} />
      </div>

      <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">
            Shared payload (optional)
          </Label>
          <Textarea
            value={sharedPayloadText}
            onChange={(e) => setSharedPayloadText(e.target.value)}
            rows={3}
            spellCheck={false}
            className="font-mono text-xs"
            placeholder='{ "value": 25 }'
            disabled={sending}
          />
          <p
            className={`text-[11px] ${sharedCheck.ok ? "text-muted-foreground" : "text-rose-600 dark:text-rose-400"}`}
          >
            {sharedCheck.ok
              ? "Merged into every item. Per-recipient keys from the list win."
              : sharedCheck.error}
          </p>
        </div>
        <div className="space-y-1">
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
          <p className="text-[11px] text-muted-foreground">
            Max {BULK_MAX_ITEMS}. Chunks also close on body size, so a big
            payload splits earlier by itself.
          </p>
        </div>
      </div>

      {planError && (
        <div className="flex gap-2 rounded-md border border-rose-500/30 bg-rose-500/10 p-3">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-rose-600 dark:text-rose-400" />
          <p className="text-xs text-rose-700 dark:text-rose-300">{planError}</p>
        </div>
      )}

      <NotificationPreview type={type} payload={previewItem?.payload} />

      {chunks && chunks.length > 0 && (
        <ChunkPlan chunks={chunks} previewItem={previewItem} />
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          onClick={handleStart}
          disabled={!readyToSend}
          className="gap-1.5"
        >
          <Play className="size-4" />
          {sending
            ? `Sending chunk ${currentChunk + 1} of ${total}…`
            : `Send ${chunks ? formatNumber(chunks.reduce((n, c) => n + c.length, 0)) : "0"} notifications`}
        </Button>
        {failure && (
          <Button
            variant="outline"
            onClick={() => void run(failure.chunkIndex)}
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
            Nothing needs reconciling — dedupe keys make a verbatim retry safe.
            Anything already written comes back as deduped.
          </p>
        </div>
      )}

      {results.length > 0 && (
        <ResultSummary
          totals={totals}
          chunksDone={done}
          chunksTotal={total}
          copied={copied}
          onCopyUnknown={copyUnknown}
        />
      )}
    </div>
  );
}

function RecipientSummary({
  parsed,
}: {
  parsed: ReturnType<typeof parseRecipients> | null;
}) {
  if (!parsed) {
    return (
      <p className="text-[11px] text-muted-foreground">
        CSV with a <code>user_id</code> column (every other column becomes a
        payload key), a JSON array of{" "}
        <code>{"{ user_id, payload }"}</code>, or plain ids one per line.
      </p>
    );
  }
  if (!parsed.ok) {
    return (
      <p className="text-[11px] text-rose-600 dark:text-rose-400">
        {parsed.error}
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
      <Badge variant="outline" className="uppercase">
        {parsed.format}
      </Badge>
      <span>{formatNumber(parsed.recipients.length)} recipients</span>
      {parsed.duplicateIds.length > 0 && (
        <span className="text-amber-600 dark:text-amber-400">
          · {parsed.duplicateIds.length} id
          {parsed.duplicateIds.length === 1 ? "" : "s"} listed more than once —
          the repeat comes back as deduped
        </span>
      )}
      {parsed.ignoredDedupeKeys > 0 && (
        <span className="text-amber-600 dark:text-amber-400">
          · {parsed.ignoredDedupeKeys} pasted dedupe_key
          {parsed.ignoredDedupeKeys === 1 ? "" : "s"} ignored — keys are always
          derived from the campaign slug
        </span>
      )}
    </div>
  );
}

function ChunkPlan({
  chunks,
  previewItem,
}: {
  chunks: BulkNotificationItem[][];
  previewItem: BulkNotificationItem | undefined;
}) {
  const itemCount = chunks.reduce((n, c) => n + c.length, 0);
  const largestBytes = Math.max(...chunks.map((c) => jsonByteSize(c)));
  const previewBytes = previewItem ? jsonByteSize(previewItem) : 0;

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span>
          <span className="font-medium text-foreground">
            {formatNumber(chunks.length)}
          </span>{" "}
          request{chunks.length === 1 ? "" : "s"}, sent one at a time
        </span>
        <span>
          <span className="font-medium text-foreground">
            {formatNumber(itemCount)}
          </span>{" "}
          items
        </span>
        <span>
          largest body ≈{" "}
          <span className="font-medium text-foreground">
            {formatNumber(Math.round(largestBytes / 1024))} KB
          </span>
        </span>
        <span>
          per item ≈{" "}
          <span
            className={
              previewBytes > NOTIFICATION_PAYLOAD_MAX_BYTES
                ? "font-medium text-rose-600 dark:text-rose-400"
                : "font-medium text-foreground"
            }
          >
            {previewBytes} B
          </span>
        </span>
      </div>
      {previewItem != null && (
        <pre className="max-h-24 overflow-auto rounded bg-muted/50 p-2 font-mono text-[10px] leading-relaxed">
          {JSON.stringify(previewItem, null, 2)}
        </pre>
      )}
    </div>
  );
}

function ResultSummary({
  totals,
  chunksDone,
  chunksTotal,
  copied,
  onCopyUnknown,
}: {
  totals: { requested: number; created: number; deduped: number; unknown: string[] };
  chunksDone: number;
  chunksTotal: number;
  copied: boolean;
  onCopyUnknown: () => void;
}) {
  return (
    <div className="space-y-3 rounded-md border p-3">
      <p className="text-xs font-medium">
        {chunksDone} of {chunksTotal} chunk{chunksTotal === 1 ? "" : "s"} sent ·{" "}
        {formatNumber(totals.requested)} requested
      </p>

      <div className="grid gap-2 sm:grid-cols-3">
        <CountTile
          icon={CheckCircle2}
          label="Created"
          value={totals.created}
          accent="text-emerald-600 dark:text-emerald-400"
          hint="Rows actually inserted"
        />
        <CountTile
          icon={CopyCheck}
          label="Deduped"
          value={totals.deduped}
          accent="text-blue-600 dark:text-blue-400"
          hint="Already delivered — normal, not an error"
        />
        <CountTile
          icon={UserX}
          label="Unknown users"
          value={totals.unknown.length}
          accent="text-amber-600 dark:text-amber-400"
          hint="Distinct ids that don't exist, dropped"
        />
      </div>

      {totals.unknown.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] text-muted-foreground">
              Dropped ids — the send still succeeded. Because this list is
              de-duplicated, the counts above won&apos;t sum to requested when an
              id was sent twice.
            </p>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 shrink-0 gap-1 text-xs"
              onClick={onCopyUnknown}
            >
              {copied ? (
                <CopyCheck className="size-3" />
              ) : (
                <Copy className="size-3" />
              )}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <pre className="max-h-32 overflow-auto rounded bg-muted/50 p-2 font-mono text-[10px] leading-relaxed">
            {totals.unknown.join("\n")}
          </pre>
        </div>
      )}
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
