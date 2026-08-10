"use client";

import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  CircleAlert,
  Info,
  Send,
  UserX,
  X,
} from "lucide-react";
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
  ADMIN_MESSAGE_BODY_MAX,
  ADMIN_MESSAGE_TITLE_MAX,
  validateNotificationPayload,
} from "@/lib/user-notification";
import { sendDirectNotificationAction } from "./direct-actions";
import { NotificationUserPicker } from "./notification-user-picker";
import { NotificationPreview } from "./notification-preview";
import { NotificationPackPicker } from "./notification-pack-picker";
import type { AnnouncementPackOption } from "./composer-actions";
import type { DbEnv } from "@/lib/db-env";
import { mainSiteUrl, packUrl } from "@/lib/utils/main-site";
import { formatCurrency } from "@/lib/utils/format";

export type SingleNotificationMode = "message" | "pack" | "challenge";
type ChallengeGame = "keno" | "upgrader" | "pack";
const MAX_NOTIFICATION_PACKS = 3;

type Sent =
  | { kind: "ok"; message: string }
  | { kind: "not-found"; message: string }
  | { kind: "error"; message: string };

export function SingleNotificationForm({
  targetEnv,
  mode,
}: {
  targetEnv: DbEnv;
  mode: SingleNotificationMode;
}) {
  const [userId, setUserId] = useState("");
  const [userLabel, setUserLabel] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [packs, setPacks] = useState<AnnouncementPackOption[]>([]);
  const [challengeGame, setChallengeGame] = useState<ChallengeGame>("keno");
  const [challengeName, setChallengeName] = useState("");
  const [challengePrize, setChallengePrize] = useState("");
  const [sent, setSent] = useState<Sent | null>(null);
  const [isPending, startTransition] = useTransition();

  const challengePrizeNumber = Number(challengePrize.replace(/^\$/, ""));
  const challengeInvalid =
    !challengeName.trim() ||
    (!!challengePrize.trim() &&
      (!Number.isFinite(challengePrizeNumber) ||
        challengePrizeNumber <= 0 ||
        challengePrizeNumber > 100_000));

  const notification = useMemo(() => {
    if (mode === "message") {
      return {
        category: "system" as const,
        type: "admin_message",
        payload: { title: title.trim(), body: message.trim() },
        dedupeKey: undefined,
      };
    }

    if (mode === "challenge") {
      return {
        category: "rewards" as const,
        type: "challenge_available",
        payload: {
          challenge_name: challengeName.trim(),
          game_type: challengeGame,
          challenge_type:
            challengeGame === "pack" ? "pack_pull" : challengeGame,
          url: mainSiteUrl("/rewards?tab=challenges"),
          ...(challengePrize.trim() && Number.isFinite(challengePrizeNumber)
            ? { prize_usd: challengePrizeNumber.toFixed(2) }
            : {}),
        },
        dedupeKey: challengeName.trim()
          ? `challenge_available:manual:${challengeGame}:${slugify(challengeName)}`
          : undefined,
      };
    }

    const payload =
      packs.length === 1
        ? {
            pack_name: packs[0].name,
            price_usd: packs[0].priceUsd,
            url: packUrl(packs[0].slug),
            ...(packs[0].imageUrl ? { image_url: packs[0].imageUrl } : {}),
          }
        : {
            packs: packs.map((pack) => ({
              name: pack.name,
              price_usd: pack.priceUsd,
              url: packUrl(pack.slug),
              ...(pack.imageUrl ? { image_url: pack.imageUrl } : {}),
            })),
            url: mainSiteUrl("/games/packs?sort=newest"),
          };

    return {
      category: "system" as const,
      type: "pack_release",
      payload,
      dedupeKey:
        packs.length > 0
          ? `pack_release:${packs
              .map((pack) => pack.id)
              .sort()
              .join(":")}`
          : undefined,
    };
  }, [
    mode,
    title,
    message,
    challengeName,
    challengeGame,
    challengePrize,
    challengePrizeNumber,
    packs,
  ]);

  const payloadCheck = validateNotificationPayload(notification.payload);
  const messageInvalid = !title.trim() || !message.trim();
  const blocked =
    isPending ||
    !userId.trim() ||
    (mode === "message" && messageInvalid) ||
    (mode === "pack" && packs.length === 0) ||
    (mode === "challenge" && challengeInvalid) ||
    !payloadCheck.ok;

  function handleSend() {
    if (!payloadCheck.ok) {
      toast.error(payloadCheck.error);
      return;
    }
    if (
      targetEnv === "prod" &&
      !window.confirm(
        `Send this ${mode} notification to the selected user in PRODUCTION?`,
      )
    ) {
      return;
    }

    setSent(null);
    startTransition(async () => {
      const result = await sendDirectNotificationAction({
        userId: userId.trim(),
        category: notification.category,
        type: notification.type,
        payload: payloadCheck.payload,
        dedupeKey: notification.dedupeKey,
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
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(300px,0.72fr)]">
      <div className="space-y-4">
        <Step number={1} title="Choose recipient">
          <NotificationUserPicker
            disabled={isPending}
            label={userLabel ?? "Find a user by name or email…"}
            onSelect={(user) => {
              setUserId(user.id);
              setUserLabel(user.username ?? user.email ?? user.id);
            }}
          />
          <Input
            value={userId}
            onChange={(event) => {
              setUserId(event.target.value);
              setUserLabel(null);
            }}
            placeholder="Or paste a user ID"
            className="font-mono text-xs"
            disabled={isPending}
          />
        </Step>

        <Step number={2} title={stepTitle(mode)}>
          {mode === "message" && (
            <MessageFields
              title={title}
              message={message}
              disabled={isPending}
              onTitleChange={setTitle}
              onMessageChange={setMessage}
            />
          )}
          {mode === "pack" && (
            <PackFields
              packs={packs}
              disabled={isPending}
              onChange={setPacks}
            />
          )}
          {mode === "challenge" && (
            <ChallengeFields
              game={challengeGame}
              name={challengeName}
              prize={challengePrize}
              invalid={challengeInvalid}
              disabled={isPending}
              onGameChange={setChallengeGame}
              onNameChange={setChallengeName}
              onPrizeChange={setChallengePrize}
            />
          )}
        </Step>
      </div>

      <div className="space-y-4">
        <Step number={3} title="Review and send">
          <NotificationPreview
            type={notification.type}
            payload={payloadCheck.ok ? payloadCheck.payload : undefined}
            showHeading={false}
          />
          {!payloadCheck.ok && (
            <p className="text-xs text-rose-600 dark:text-rose-400">
              {payloadCheck.error}
            </p>
          )}
          <Button onClick={handleSend} disabled={blocked} className="w-full gap-2">
            <Send className="size-4" />
            {isPending ? "Sending…" : `Send to ${userLabel ?? "user"}`}
          </Button>
        </Step>
        {sent && <ResultCallout sent={sent} />}
      </div>
    </div>
  );
}

function MessageFields({
  title,
  message,
  disabled,
  onTitleChange,
  onMessageChange,
}: {
  title: string;
  message: string;
  disabled: boolean;
  onTitleChange: (value: string) => void;
  onMessageChange: (value: string) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label htmlFor="direct-title">Title</Label>
          <span className="text-[11px] text-muted-foreground">
            {title.length}/{ADMIN_MESSAGE_TITLE_MAX}
          </span>
        </div>
        <Input
          id="direct-title"
          value={title}
          onChange={(event) => onTitleChange(event.target.value)}
          placeholder="What should the user know?"
          maxLength={ADMIN_MESSAGE_TITLE_MAX}
          disabled={disabled}
        />
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label htmlFor="direct-message">Message</Label>
          <span className="text-[11px] text-muted-foreground">
            {message.length}/{ADMIN_MESSAGE_BODY_MAX}
          </span>
        </div>
        <Textarea
          id="direct-message"
          value={message}
          onChange={(event) => onMessageChange(event.target.value)}
          placeholder="Write the notification text…"
          rows={6}
          maxLength={ADMIN_MESSAGE_BODY_MAX}
          disabled={disabled}
        />
      </div>
    </div>
  );
}

function PackFields({
  packs,
  disabled,
  onChange,
}: {
  packs: AnnouncementPackOption[];
  disabled: boolean;
  onChange: (packs: AnnouncementPackOption[]) => void;
}) {
  return (
    <div className="space-y-3">
      <NotificationPackPicker
        selectedValues={packs}
        onSelectionChange={onChange}
        maxSelected={MAX_NOTIFICATION_PACKS}
        scope="direct"
        placeholder="Select up to three packs…"
        disabled={disabled}
      />
      {packs.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Pack names, prices, images, and links are added automatically.
        </p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-3">
          {packs.map((pack) => (
            <div key={pack.id} className="relative rounded-md border bg-background p-2">
              {pack.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={pack.imageUrl}
                  alt=""
                  className="mb-2 h-16 w-full object-contain"
                />
              ) : null}
              <p className="truncate pr-5 text-xs font-medium">{pack.name}</p>
              <p className="text-[11px] text-muted-foreground">
                {formatCurrency(pack.priceUsd)} per open
              </p>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="absolute right-1 top-1"
                aria-label={`Remove ${pack.name}`}
                disabled={disabled}
                onClick={() => onChange(packs.filter((item) => item.id !== pack.id))}
              >
                <X className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ChallengeFields({
  game,
  name,
  prize,
  invalid,
  disabled,
  onGameChange,
  onNameChange,
  onPrizeChange,
}: {
  game: ChallengeGame;
  name: string;
  prize: string;
  invalid: boolean;
  disabled: boolean;
  onGameChange: (value: ChallengeGame) => void;
  onNameChange: (value: string) => void;
  onPrizeChange: (value: string) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Game</Label>
          <Select value={game} onValueChange={(value) => onGameChange(value as ChallengeGame)}>
            <SelectTrigger className="w-full" disabled={disabled}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="keno">Keno</SelectItem>
              <SelectItem value="upgrader">Upgrader</SelectItem>
              <SelectItem value="pack">Pack opening</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="challenge-prize">Prize (optional)</Label>
          <Input
            id="challenge-prize"
            value={prize}
            onChange={(event) => onPrizeChange(event.target.value)}
            inputMode="decimal"
            placeholder="25.00"
            disabled={disabled}
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="challenge-name">Challenge name</Label>
        <Input
          id="challenge-name"
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
          maxLength={200}
          placeholder="e.g. Lucky Seven"
          disabled={disabled}
        />
      </div>
      {invalid && (name.trim() || prize.trim()) ? (
        <p className="text-xs text-rose-600 dark:text-rose-400">
          Add a name and, when set, a prize between $0.01 and $100,000.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          The notification opens the Challenges tab automatically.
        </p>
      )}
    </div>
  );
}

function Step({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children: React.ReactNode;
}) {
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

function stepTitle(mode: SingleNotificationMode): string {
  if (mode === "pack") return "Choose packs";
  if (mode === "challenge") return "Set up the challenge";
  return "Write the message";
}

function slugify(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "challenge"
  );
}

function ResultCallout({ sent }: { sent: Sent }) {
  if (sent.kind === "ok") {
    return (
      <div className="flex gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3">
        <Info className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <p className="text-xs text-emerald-700 dark:text-emerald-300">{sent.message}</p>
      </div>
    );
  }
  if (sent.kind === "not-found") {
    return (
      <div className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
        <UserX className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <p className="text-xs text-amber-700 dark:text-amber-300">{sent.message}</p>
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
