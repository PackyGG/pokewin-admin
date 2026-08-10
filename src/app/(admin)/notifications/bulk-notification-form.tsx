"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  CheckCircle2,
  CircleAlert,
  Copy,
  CopyCheck,
  Play,
  RotateCcw,
  Send,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { formatNumber } from "@/lib/utils/format";
import {
  BULK_MAX_ITEMS,
  ADMIN_MESSAGE_BODY_MAX,
  ADMIN_MESSAGE_TITLE_MAX,
  buildBulkItems,
  chunkBulkItems,
  parseRecipients,
  type BulkNotificationItem,
} from "@/lib/user-notification";
import { sendBulkNotificationChunkAction } from "./direct-actions";
import { NotificationUserPicker } from "./notification-user-picker";
import { NotificationPreview } from "./notification-preview";
import type { BulkNotificationResult } from "@/lib/backend-api/user-notifications";
import type { DbEnv } from "@/lib/db-env";

type Failure = { chunkIndex: number; error: string };

export function BulkNotificationForm({ targetEnv }: { targetEnv: DbEnv }) {
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [recipientsText, setRecipientsText] = useState("");
  const [campaign, setCampaign] = useState("");
  const [sending, setSending] = useState(false);
  const [currentChunk, setCurrentChunk] = useState(0);
  const [results, setResults] = useState<BulkNotificationResult[]>([]);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => setCampaign(createCampaignId()), []);

  const parsed = useMemo(
    () => (recipientsText.trim() ? parseRecipients(recipientsText) : null),
    [recipientsText],
  );
  const payload = useMemo(
    () => ({ title: title.trim(), body: message.trim() }),
    [title, message],
  );
  const chunks = useMemo(() => {
    if (!parsed?.ok || !campaign || !title.trim() || !message.trim()) return null;
    const recipients = parsed.recipients.map(({ userId }) => ({ userId }));
    const built = buildBulkItems(recipients, {
      campaign,
      sharedPayload: payload,
    });
    return built.ok
      ? chunkBulkItems(built.items, { maxItems: BULK_MAX_ITEMS })
      : null;
  }, [parsed, campaign, payload, title, message]);

  const [sent, setSent] = useState<{
    chunks: BulkNotificationItem[][];
    campaign: string;
  } | null>(null);

  const totals = useMemo(() => {
    const unknown = new Set<string>();
    let requested = 0;
    let created = 0;
    let deduped = 0;
    for (const result of results) {
      requested += result.requested;
      created += result.created;
      deduped += result.deduped;
      for (const id of result.unknown_users) unknown.add(id);
    }
    return { requested, created, deduped, unknown: [...unknown] };
  }, [results]);

  async function run(plan: NonNullable<typeof sent>, fromChunk: number) {
    setSending(true);
    setFailure(null);
    try {
      for (let index = fromChunk; index < plan.chunks.length; index++) {
        setCurrentChunk(index);
        const response = await sendBulkNotificationChunkAction({
          category: "system",
          type: "admin_message",
          items: plan.chunks[index],
          campaign: plan.campaign,
          chunkIndex: index,
          chunkCount: plan.chunks.length,
        });
        if (!response.success) {
          setFailure({ chunkIndex: index, error: response.error });
          toast.error(`Batch ${index + 1} failed — retrying it is safe`);
          return;
        }
        setResults((current) => [...current, response.result]);
      }
      toast.success("Bulk message sent");
    } finally {
      setSending(false);
    }
  }

  function handleStart() {
    if (!chunks?.length || !campaign) return;
    const count = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    if (
      !window.confirm(
        `Send “${title.trim()}” to ${count} user${count === 1 ? "" : "s"} in ${targetEnv.toUpperCase()}?`,
      )
    ) {
      return;
    }
    const plan = { chunks, campaign };
    setSent(plan);
    setResults([]);
    setCurrentChunk(0);
    void run(plan, 0);
  }

  function handleNewMessage() {
    setTitle("");
    setMessage("");
    setRecipientsText("");
    setCampaign(createCampaignId());
    setResults([]);
    setFailure(null);
    setCurrentChunk(0);
    setSent(null);
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

  const recipientCount = parsed?.ok ? parsed.recipients.length : 0;
  const done = results.length;
  const total = sent?.chunks.length ?? chunks?.length ?? 0;
  const complete = sent !== null && !failure && done === total && total > 0;
  const ready = !sending && Boolean(chunks?.length) && !complete;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(300px,0.72fr)]">
      <div className="space-y-4">
        <Step number={1} title="Add recipients">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              Paste one user ID per line, or search to add people.
            </p>
            <div className="w-full sm:w-60">
              <NotificationUserPicker
                disabled={sending}
                label="Find and add a user…"
                onSelect={(user) =>
                  setRecipientsText((current) =>
                    current.trim()
                      ? `${current.replace(/\s+$/, "")}\n${user.id}`
                      : user.id,
                  )
                }
              />
            </div>
          </div>
          <Textarea
            value={recipientsText}
            onChange={(event) => setRecipientsText(event.target.value)}
            rows={8}
            spellCheck={false}
            className="font-mono text-xs"
            placeholder={"user_id_1\nuser_id_2\nuser_id_3"}
            disabled={sending}
          />
          {parsed?.ok ? (
            <div className="flex flex-wrap gap-2">
              <Badge variant="secondary">
                {formatNumber(recipientCount)} recipient{recipientCount === 1 ? "" : "s"}
              </Badge>
              {parsed.duplicateIds.length > 0 && (
                <Badge variant="outline" className="text-amber-600">
                  {parsed.duplicateIds.length} duplicate ID
                  {parsed.duplicateIds.length === 1 ? "" : "s"}
                </Badge>
              )}
            </div>
          ) : parsed ? (
            <p className="text-xs text-rose-600 dark:text-rose-400">{parsed.error}</p>
          ) : null}
        </Step>

        <Step number={2} title="Write the message">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="bulk-title">Title</Label>
              <span className="text-[11px] text-muted-foreground">
                {title.length}/{ADMIN_MESSAGE_TITLE_MAX}
              </span>
            </div>
            <Input
              id="bulk-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="What should users know?"
              maxLength={ADMIN_MESSAGE_TITLE_MAX}
              disabled={sending}
            />
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="bulk-message">Message</Label>
              <span className="text-[11px] text-muted-foreground">
                {message.length}/{ADMIN_MESSAGE_BODY_MAX}
              </span>
            </div>
            <Textarea
              id="bulk-message"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Write the notification text…"
              rows={6}
              maxLength={ADMIN_MESSAGE_BODY_MAX}
              disabled={sending}
            />
          </div>
        </Step>
      </div>

      <div className="space-y-4">
        <Step number={3} title="Review and send">
          <NotificationPreview
            type="admin_message"
            payload={title.trim() || message.trim() ? payload : undefined}
            showHeading={false}
          />
          <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs">
            <span className="font-medium">Sending to </span>
            <span className="text-muted-foreground">
              {formatNumber(recipientCount)} user{recipientCount === 1 ? "" : "s"}
              {total > 1 ? ` in ${total} batches` : ""}
            </span>
          </div>
          <Button onClick={handleStart} disabled={!ready} className="w-full gap-2">
            <Send className="size-4" />
            {sending ? "Sending…" : "Send bulk message"}
          </Button>
        </Step>

        {(sent || failure) && (
          <SendProgress
            done={done}
            total={total}
            currentChunk={currentChunk}
            sending={sending}
            failure={failure}
            complete={complete}
            totals={totals}
            copied={copied}
            onRetry={() => sent && void run(sent, failure?.chunkIndex ?? 0)}
            onCopyUnknown={copyUnknown}
            onNewMessage={handleNewMessage}
          />
        )}
      </div>
    </div>
  );
}

function Step({ number, title, children }: { number: number; title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-lg border bg-card p-4">
      <div className="flex items-center gap-2">
        <span className="flex size-6 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
          {number}
        </span>
        <h3 className="text-sm font-medium">{title}</h3>
      </div>
      {children}
    </section>
  );
}

function SendProgress({
  done,
  total,
  currentChunk,
  sending,
  failure,
  complete,
  totals,
  copied,
  onRetry,
  onCopyUnknown,
  onNewMessage,
}: {
  done: number;
  total: number;
  currentChunk: number;
  sending: boolean;
  failure: Failure | null;
  complete: boolean;
  totals: { requested: number; created: number; deduped: number; unknown: string[] };
  copied: boolean;
  onRetry: () => void;
  onCopyUnknown: () => void;
  onNewMessage: () => void;
}) {
  return (
    <div className="space-y-3 rounded-lg border bg-card p-4">
      <div className="flex items-center gap-2">
        {complete ? (
          <CheckCircle2 className="size-4 text-emerald-600" />
        ) : failure ? (
          <CircleAlert className="size-4 text-rose-600" />
        ) : (
          <Play className="size-4 text-primary" />
        )}
        <p className="text-sm font-medium">
          {complete
            ? "Bulk message sent"
            : failure
              ? `Batch ${failure.chunkIndex + 1} failed`
              : `Sending batch ${currentChunk + 1} of ${total}`}
        </p>
      </div>
      <div className="grid grid-cols-3 gap-2 text-center">
        <Count label="Delivered" value={totals.created} />
        <Count label="Already sent" value={totals.deduped} />
        <Count label="Unknown" value={totals.unknown.length} />
      </div>
      {failure && <p className="text-xs text-rose-600">{failure.error}</p>}
      <p className="text-[11px] text-muted-foreground">
        {done} of {total} batch{total === 1 ? "" : "es"} complete
      </p>
      <div className="flex flex-wrap gap-2">
        {failure && (
          <Button size="sm" onClick={onRetry} disabled={sending} className="gap-1.5">
            <RotateCcw className="size-3.5" /> Retry failed batch
          </Button>
        )}
        {totals.unknown.length > 0 && (
          <Button size="sm" variant="outline" onClick={onCopyUnknown} className="gap-1.5">
            {copied ? <CopyCheck className="size-3.5" /> : <Copy className="size-3.5" />}
            {copied ? "Copied" : "Copy unknown IDs"}
          </Button>
        )}
        {complete && (
          <Button size="sm" variant="outline" onClick={onNewMessage} className="gap-1.5">
            <RotateCcw className="size-3.5" /> New bulk message
          </Button>
        )}
      </div>
    </div>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border p-2">
      <p className="text-lg font-semibold tabular-nums">{formatNumber(value)}</p>
      <p className="text-[10px] text-muted-foreground">{label}</p>
    </div>
  );
}

function createCampaignId(): string {
  const random = globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 10);
  return `bulk-message-${Date.now().toString(36)}-${random}`.toLowerCase();
}
