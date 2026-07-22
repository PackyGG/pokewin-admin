"use client";

import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { CircleAlert, Info, Send, UserX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  NOTIFICATION_DEDUPE_KEY_MAX,
  NOTIFICATION_PAYLOAD_MAX_BYTES,
  NOTIFICATION_TYPE_MAX,
  parsePayloadJson,
  validateDedupeKey,
  validateNotificationType,
  type UserNotificationCategory,
} from "@/lib/user-notification";
import { sendDirectNotificationAction } from "./direct-actions";
import { NotificationUserPicker } from "./notification-user-picker";

type Sent =
  | { kind: "ok"; message: string }
  | { kind: "not-found"; message: string }
  | { kind: "error"; message: string };

/**
 * Quick smoke test for `POST /admin/notifications` — one user, one payload.
 *
 * Two things this form has to make honest, because the endpoint's semantics
 * are easy to misread:
 *   • 200 ≠ "row inserted". It rides the fire-and-forget notify() path and
 *     can't report created-vs-deduped, so the success state says so and
 *     points at the 1-item bulk send for exact accounting.
 *   • 404 is its own outcome (the backend checks the user explicitly), not a
 *     generic failure — it gets its own callout.
 */
export function SingleNotificationForm({ disabled }: { disabled: boolean }) {
  const [userId, setUserId] = useState("");
  const [userLabel, setUserLabel] = useState<string | null>(null);
  const [category, setCategory] = useState<UserNotificationCategory>("rewards");
  const [type, setType] = useState("promo_code_granted");
  const [payloadText, setPayloadText] = useState(
    '{\n  "code": "PACKY-A1B2-C3D4",\n  "value": 25\n}',
  );
  const [dedupeKey, setDedupeKey] = useState("");
  const [sent, setSent] = useState<Sent | null>(null);
  const [isPending, startTransition] = useTransition();

  const payloadCheck = useMemo(() => parsePayloadJson(payloadText), [payloadText]);
  const payloadBytes = useMemo(
    () =>
      payloadCheck.ok && payloadCheck.payload
        ? new TextEncoder().encode(JSON.stringify(payloadCheck.payload)).length
        : 0,
    [payloadCheck],
  );

  const typeError = validateNotificationType(type);
  const dedupeError = dedupeKey.trim() ? validateDedupeKey(dedupeKey) : null;
  const blocked =
    disabled ||
    isPending ||
    !userId.trim() ||
    !payloadCheck.ok ||
    typeError !== null ||
    dedupeError !== null;

  function handleSend() {
    if (!payloadCheck.ok) {
      toast.error(payloadCheck.error);
      return;
    }
    setSent(null);
    startTransition(async () => {
      const result = await sendDirectNotificationAction({
        userId: userId.trim(),
        category,
        type: type.trim(),
        payload: payloadCheck.payload,
        dedupeKey: dedupeKey.trim() || undefined,
      });
      if (result.success) {
        setSent({ kind: "ok", message: result.message });
        toast.success("Notification accepted");
        return;
      }
      setSent({
        kind: result.notFound ? "not-found" : "error",
        message: result.error,
      });
      toast.error(result.notFound ? "User not found" : result.error);
    });
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">Recipient</Label>
        <NotificationUserPicker
          disabled={disabled || isPending}
          label={userLabel ?? "Find a user…"}
          onSelect={(u) => {
            setUserId(u.id);
            setUserLabel(u.username ?? u.email ?? u.id);
          }}
        />
        <Input
          value={userId}
          onChange={(e) => {
            setUserId(e.target.value);
            setUserLabel(null);
          }}
          placeholder="…or paste a user id"
          className="font-mono text-xs"
          disabled={disabled || isPending}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Category</Label>
          <Select
            value={category}
            onValueChange={(v) => setCategory(v as UserNotificationCategory)}
          >
            <SelectTrigger className="w-full" disabled={disabled || isPending}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="rewards">rewards</SelectItem>
              <SelectItem value="system">system</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground">
            Only these two. <code>transaction</code> is producer-owned,{" "}
            <code>news</code> is announcements-only.
          </p>
        </div>

        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Type</Label>
          <Input
            value={type}
            onChange={(e) => setType(e.target.value)}
            placeholder="promo_code_granted"
            maxLength={NOTIFICATION_TYPE_MAX}
            className="font-mono text-xs"
            disabled={disabled || isPending}
          />
          <p
            className={`text-[11px] ${typeError ? "text-rose-600 dark:text-rose-400" : "text-muted-foreground"}`}
          >
            {typeError ??
              "An i18n key, not display copy — the client maps it to a localized template."}
          </p>
        </div>
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <Label className="text-xs text-muted-foreground">
            Payload (optional)
          </Label>
          <span
            className={`text-[11px] tabular-nums ${
              payloadBytes > NOTIFICATION_PAYLOAD_MAX_BYTES
                ? "text-rose-600 dark:text-rose-400"
                : "text-muted-foreground"
            }`}
          >
            {payloadBytes} / {NOTIFICATION_PAYLOAD_MAX_BYTES} bytes
          </span>
        </div>
        <Textarea
          value={payloadText}
          onChange={(e) => setPayloadText(e.target.value)}
          rows={6}
          spellCheck={false}
          className="font-mono text-xs"
          placeholder='{ "code": "PACKY-A1B2-C3D4" }'
          disabled={disabled || isPending}
        />
        {payloadCheck.ok ? (
          <p className="text-[11px] text-muted-foreground">
            Any keys pass through untouched. <code>url</code> must be http(s);{" "}
            <code>image_url</code> must be an ImageKit URL.
          </p>
        ) : (
          <p className="text-[11px] text-rose-600 dark:text-rose-400">
            {payloadCheck.error}
          </p>
        )}
      </div>

      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">
          Dedupe key (optional)
        </Label>
        <Input
          value={dedupeKey}
          onChange={(e) => setDedupeKey(e.target.value)}
          placeholder="summer_promo_2026:kX9mQ2pLr7vNa4bT8cZfE1yH6wJ3sD0g"
          maxLength={NOTIFICATION_DEDUPE_KEY_MAX}
          className="font-mono text-xs"
          disabled={disabled || isPending}
        />
        <p
          className={`text-[11px] ${dedupeError ? "text-rose-600 dark:text-rose-400" : "text-muted-foreground"}`}
        >
          {dedupeError ??
            "Convention is `campaign:user_id`. Set it and a repeat send can't double-deliver."}
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Button onClick={handleSend} disabled={blocked} className="gap-1.5">
          <Send className="size-4" />
          {isPending ? "Sending…" : "Send"}
        </Button>
        {sent && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSent(null)}
            disabled={isPending}
          >
            Clear result
          </Button>
        )}
      </div>

      {sent && <ResultCallout sent={sent} />}
    </div>
  );
}

function ResultCallout({ sent }: { sent: Sent }) {
  if (sent.kind === "ok") {
    return (
      <div className="flex gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3">
        <Info className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <p className="text-xs text-emerald-700 dark:text-emerald-300">
          {sent.message}
        </p>
      </div>
    );
  }
  if (sent.kind === "not-found") {
    return (
      <div className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
        <UserX className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="space-y-1">
          <p className="text-xs font-medium text-amber-700 dark:text-amber-300">
            {sent.message}
          </p>
          <p className="text-[11px] text-amber-700/80 dark:text-amber-300/80">
            The backend checks the id explicitly and returns 404 — nothing was
            written. Check you&apos;re on the right environment.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex gap-2 rounded-md border border-rose-500/30 bg-rose-500/10 p-3">
      <CircleAlert className="mt-0.5 size-4 shrink-0 text-rose-600 dark:text-rose-400" />
      <p className="text-xs text-rose-700 dark:text-rose-300">{sent.message}</p>
    </div>
  );
}
