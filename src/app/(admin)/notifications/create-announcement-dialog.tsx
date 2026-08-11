"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  ExternalLink,
  Loader2,
  Megaphone,
  Package,
  Ticket,
  Trophy,
  Trash2,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatCurrency, formatDate } from "@/lib/utils/format";
import { uploadImageClient } from "@/lib/upload-image-client";
import { MAIN_SITE_PAGES, mainSiteUrl, packUrl } from "@/lib/utils/main-site";
import { toValidIso } from "@/lib/client-runtime-safety";
import {
  ANNOUNCEMENT_CTA_MAX,
  EMPTY_PAYLOAD_DRAFT,
  IMAGEKIT_URL_PREFIX,
  isImageKitUrl,
  shortUrlLabel,
  validateAnnouncementPayload,
  type AnnouncementPayloadDraft,
} from "@/lib/announcement-payload";
import { createAnnouncementAction } from "./actions";
import {
  searchAnnouncementPromoCodes,
  type AnnouncementPackOption,
  type AnnouncementPromoOption,
} from "./composer-actions";
import { NotificationPackPicker } from "./notification-pack-picker";
import { NotificationPreview } from "./notification-preview";
import type {
  AnnouncementAudienceRole,
  AnnouncementCreateCategory,
} from "@/lib/backend-api/announcements";

export const AUDIENCE_OPTIONS: {
  value: AnnouncementAudienceRole;
  label: string;
}[] = [
  { value: "user", label: "Users" },
  { value: "support", label: "Support staff" },
  { value: "admin", label: "Admins" },
  { value: "creator", label: "Creators" },
];

export function audienceLabel(
  roles: AnnouncementAudienceRole[] | null,
): string {
  if (!roles || roles.length === 0) return "Everyone";
  return roles
    .map((r) => AUDIENCE_OPTIONS.find((o) => o.value === r)?.label ?? r)
    .join(", ");
}

/**
 * What kind of announcement is being composed. General templates pre-fill
 * link/media metadata; the challenge template also sends the backend's
 * validated game/name/prize fields so the site can select its dedicated card.
 * There is no per-template delivery behaviour: each remains a composer preset.
 *
 * `type` is a free-form string the client can key an icon off. Keeping one
 * stable value per template gives the frontend something to switch on.
 */
type Template = "message" | "pack" | "challenge" | "page" | "promo";
type ChallengeGame = "keno" | "upgrader" | "pack";

const TEMPLATE_TYPES: Record<Template, string> = {
  message: "admin_announcement",
  pack: "pack_release",
  challenge: "challenge_available",
  page: "page_release",
  promo: "promo_code_granted",
};

const CUSTOM_PAGE = "__custom__";
const MAX_ANNOUNCEMENT_PACKS = 3;

type AutoKey = "title" | "body" | "url" | "imageUrl" | "ctaLabel";

export function CreateAnnouncementDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const router = useRouter();
  const [template, setTemplate] = useState<Template>("message");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [payload, setPayload] =
    useState<AnnouncementPayloadDraft>(EMPTY_PAYLOAD_DRAFT);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [category, setCategory] = useState<AnnouncementCreateCategory>("news");
  const [type, setType] = useState(TEMPLATE_TYPES.message);
  const [everyoneAudience, setEveryoneAudience] = useState(true);
  const [audienceRoles, setAudienceRoles] = useState<
    Set<AnnouncementAudienceRole>
  >(() => new Set());
  const [endsAt, setEndsAt] = useState("");
  const [packs, setPacks] = useState<AnnouncementPackOption[]>([]);
  const [pagePath, setPagePath] = useState<string>(MAIN_SITE_PAGES[1].path);
  const [promo, setPromo] = useState<AnnouncementPromoOption | null>(null);
  const [manualCode, setManualCode] = useState("");
  const [challengeGame, setChallengeGame] = useState<ChallengeGame>("keno");
  const [challengeName, setChallengeName] = useState("");
  const [challengePrize, setChallengePrize] = useState("");
  const [linkOpen, setLinkOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [isPending, startTransition] = useTransition();

  // Last value each field was auto-filled with. A template only overwrites a
  // field that is still empty or still holds its own last auto-fill — an edit
  // by the admin is never clobbered.
  const autoFilled = useRef<Partial<Record<AutoKey, string>>>({});

  function autoSetText(
    key: "title" | "body",
    next: string,
    setter: (v: string | ((cur: string) => string)) => void,
  ) {
    setter((cur) =>
      cur.trim() === "" || cur === autoFilled.current[key] ? next : cur,
    );
    autoFilled.current[key] = next;
  }

  function autoSetPayload(key: "url" | "imageUrl" | "ctaLabel", next: string) {
    setPayload((cur) => ({
      ...cur,
      [key]:
        cur[key].trim() === "" || cur[key] === autoFilled.current[key]
          ? next
          : cur[key],
    }));
    autoFilled.current[key] = next;
  }

  function reset() {
    setTemplate("message");
    setTitle("");
    setBody("");
    setPayload(EMPTY_PAYLOAD_DRAFT);
    setAdvancedOpen(false);
    setCategory("news");
    setType(TEMPLATE_TYPES.message);
    setEveryoneAudience(true);
    setAudienceRoles(new Set());
    setEndsAt("");
    setPacks([]);
    setPagePath(MAIN_SITE_PAGES[1].path);
    setPromo(null);
    setManualCode("");
    setChallengeGame("keno");
    setChallengeName("");
    setChallengePrize("");
    setLinkOpen(false);
    autoFilled.current = {};
  }

  function handleOpenChange(v: boolean) {
    onOpenChange(v);
    if (!v) reset();
  }

  function handleTemplateChange(next: Template) {
    setTemplate(next);
    if (next !== "challenge") {
      setPayload((cur) => ({
        ...cur,
        challengeName: "",
        challengeGame: "",
        challengePrizeUsd: "",
      }));
    }
    // Only swap the type while it still carries a template default — a
    // hand-typed type in Advanced survives a template switch.
    setType((cur) =>
      next === "pack"
        ? TEMPLATE_TYPES.pack
        : Object.values(TEMPLATE_TYPES).includes(cur)
          ? TEMPLATE_TYPES[next]
          : cur,
    );
    if (next === "page") applyPage(pagePath);
    if (next === "pack") applyPacks(packs);
    if (next === "promo" && promo) applyPromo(promo);
    if (next === "challenge") {
      // "All" means every player account, not internal staff roles.
      setEveryoneAudience(false);
      setAudienceRoles(new Set(["user"]));
      applyChallenge({});
    }
  }

  function applyPacks(nextPacks: AnnouncementPackOption[]) {
    const next = nextPacks.slice(0, MAX_ANNOUNCEMENT_PACKS);
    setPacks(next);
    if (next.length === 0) {
      setTitle("");
      setBody("");
      setPayload((cur) => ({
        ...cur,
        url: "",
        imageUrl: "",
        ctaLabel: "",
      }));
      autoFilled.current = {
        ...autoFilled.current,
        title: "",
        body: "",
        url: "",
        imageUrl: "",
        ctaLabel: "",
      };
      return;
    }

    if (next.length === 1) {
      const pack = next[0];
      const nextImage =
        pack.imageUrl && isImageKitUrl(pack.imageUrl) ? pack.imageUrl : "";
      setTitle(pack.name);
      setBody(`${formatCurrency(pack.priceUsd)} per open`);
      setPayload((cur) => ({
        ...cur,
        url: packUrl(pack.slug),
        ctaLabel: "Open now",
        imageUrl: nextImage,
      }));
      autoFilled.current = {
        ...autoFilled.current,
        title: pack.name,
        body: `${formatCurrency(pack.priceUsd)} per open`,
        url: packUrl(pack.slug),
        ctaLabel: "Open now",
        imageUrl: nextImage,
      };
      return;
    }

    const lowestPrice = Math.min(...next.map((pack) => pack.priceUsd));
    setTitle("Fresh packs just dropped");
    setBody(`Starting at ${formatCurrency(lowestPrice)} per open`);
    setPayload((cur) => ({
      ...cur,
      url: mainSiteUrl("/games/packs?sort=newest"),
      imageUrl: "",
      ctaLabel: "View new packs",
    }));
    autoFilled.current = {
      ...autoFilled.current,
      title: "Fresh packs just dropped",
      body: `Starting at ${formatCurrency(lowestPrice)} per open`,
      url: mainSiteUrl("/games/packs?sort=newest"),
      imageUrl: "",
      ctaLabel: "View new packs",
    };
  }

  function payloadForTemplate(): AnnouncementPayloadDraft {
    return {
      ...payload,
      ...(template === "pack"
        ? {
            packs: packs.map((pack) => ({
              name: pack.name,
              priceUsd: pack.priceUsd,
              url: packUrl(pack.slug),
              imageUrl: pack.imageUrl,
            })),
          }
        : {}),
      ...(template === "promo"
        ? {
            promoCode: manualCode,
            promoValueUsd: promo ? String(promo.valueUsd) : "",
          }
        : {}),
    };
  }

  function applyPage(path: string) {
    setPagePath(path);
    // A custom URL is the one case with nothing to auto-fill — open the
    // section so the field the admin has to type into is visible.
    if (path === CUSTOM_PAGE) {
      setLinkOpen(true);
      return;
    }
    const preset = MAIN_SITE_PAGES.find((p) => p.path === path);
    autoSetPayload("url", mainSiteUrl(path));
    autoSetPayload("ctaLabel", preset ? `Open ${preset.label}` : "Open");
  }

  function applyPromo(p: AnnouncementPromoOption) {
    setPromo(p);
    setManualCode(p.code);
    autoSetText("title", `Promo code: ${p.code}`, setTitle);
    autoSetText("body", promoBody(p), setBody);
  }

  function handleManualCode(code: string) {
    setManualCode(code);
    setPromo(null);
    const upper = code.trim().toUpperCase();
    if (upper) autoSetText("title", `Promo code: ${upper}`, setTitle);
  }

  function applyChallenge(next: {
    game?: ChallengeGame;
    name?: string;
    prize?: string;
  }) {
    const game = next.game ?? challengeGame;
    const name = next.name ?? challengeName;
    const prize = next.prize ?? challengePrize;
    if (next.game) setChallengeGame(next.game);
    if (next.name !== undefined) setChallengeName(next.name);
    if (next.prize !== undefined) setChallengePrize(next.prize);

    const gameLabel =
      game === "pack" ? "Pack opening" : game === "keno" ? "Keno" : "Upgrader";
    autoSetText("title", name.trim() || `New ${gameLabel} challenge`, setTitle);
    autoSetText(
      "body",
      prize.trim()
        ? `${gameLabel} challenge is live — complete it to claim $${prize.replace(/^\$/, "")}.`
        : `${gameLabel} challenge is live now.`,
      setBody,
    );
    setPayload((cur) => ({
      ...cur,
      url: mainSiteUrl("/rewards?tab=challenges"),
      ctaLabel: "View challenge",
      challengeName: name.trim() || `New ${gameLabel} challenge`,
      challengeGame: game,
      challengePrizeUsd: prize,
    }));
  }

  async function handleUpload(file: File) {
    setUploading(true);
    try {
      const url = await uploadImageClient(file, "/announcements");
      setPayload((cur) => ({ ...cur, imageUrl: url }));
      autoFilled.current.imageUrl = url;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  function handleSubmit() {
    if (!title.trim()) {
      toast.error("Title is required");
      return;
    }
    if (!everyoneAudience && audienceRoles.size === 0) {
      toast.error("Pick at least one audience role, or choose Everyone");
      return;
    }
    if (template === "pack" && packs.length === 0) {
      toast.error("Select at least one pack");
      return;
    }
    if (template === "promo" && !manualCode.trim()) {
      toast.error("Enter a promo code");
      return;
    }
    const composedPayload = payloadForTemplate();
    const check = validateAnnouncementPayload(composedPayload);
    if (!check.ok) {
      toast.error(check.error);
      return;
    }
    const endsAtIso = endsAt ? toValidIso(endsAt) : null;
    if (endsAt && !endsAtIso) {
      toast.error("Enter a valid end date");
      return;
    }
    startTransition(async () => {
      try {
        const result = await createAnnouncementAction({
          title: title.trim(),
          body: body.trim() || null,
          category,
          type,
          audienceRoles: everyoneAudience ? null : [...audienceRoles],
          endsAt: endsAtIso,
          payload: composedPayload,
        });
        if (!result.success) {
          toast.error(result.error);
          return;
        }
        toast.success("Announcement published");
        handleOpenChange(false);
        router.refresh();
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : "Could not publish announcement",
        );
      }
    });
  }

  function toggleRole(role: AnnouncementAudienceRole) {
    setAudienceRoles((prev) => {
      const next = new Set(prev);
      if (next.has(role)) next.delete(role);
      else next.add(role);
      return next;
    });
  }

  const imageInvalid =
    payload.imageUrl.trim() !== "" && !isImageKitUrl(payload.imageUrl.trim());
  // A pack announcement fills link, image and button from the pack itself, so
  // the whole section is noise there — it collapses to a one-line escape hatch.
  // The exceptions force it open: a bad image blocks Publish, and a pack with
  // no image is the one case where there IS something to do by hand.
  const packAutoFilled = template === "pack";
  const linkExpanded =
    linkOpen ||
    imageInvalid ||
    (packAutoFilled && packs.some((pack) => !pack.imageUrl));
  const filledParts = [
    payload.imageUrl.trim() ? "Image" : null,
    payload.url.trim() ? "Link" : null,
    payload.ctaLabel.trim() ? "Button" : null,
  ].filter((p): p is string => p !== null);
  const composedPayload = payloadForTemplate();
  const composedPayloadCheck = validateAnnouncementPayload(composedPayload);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New announcement</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <Tabs
            value={template}
            onValueChange={(v: string) => handleTemplateChange(v as Template)}
          >
            <TabsList variant="line" className="self-start">
              <TabsTrigger value="message">
                <Megaphone className="size-3.5" />
                Message
              </TabsTrigger>
              <TabsTrigger value="pack">
                <Package className="size-3.5" />
                Pack
              </TabsTrigger>
              <TabsTrigger value="challenge">
                <Trophy className="size-3.5" />
                Challenge
              </TabsTrigger>
              <TabsTrigger value="page">
                <ExternalLink className="size-3.5" />
                Page
              </TabsTrigger>
              <TabsTrigger value="promo">
                <Ticket className="size-3.5" />
                Promo code
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {template === "pack" && (
            <div className="space-y-1.5 rounded-md border p-3">
              <Label className="text-xs text-muted-foreground">Pack</Label>
              <NotificationPackPicker
                selectedValues={packs}
                onSelectionChange={applyPacks}
                maxSelected={MAX_ANNOUNCEMENT_PACKS}
                scope="announcement"
                placeholder="Select up to three packs…"
                disabled={isPending}
              />
              {packs.length > 0 ? (
                packs.every((pack) => pack.imageUrl) ? (
                  <p className="text-[11px] text-emerald-600 dark:text-emerald-400">
                    Pack artwork, prices, links, and button are added
                    automatically in newest-first order.
                  </p>
                ) : (
                  <p className="text-[11px] text-amber-600 dark:text-amber-400">
                    One or more packs have no artwork. They will still render
                    with their names, prices, and links.
                  </p>
                )
              ) : (
                <p className="text-[11px] text-muted-foreground">
                  Pick up to three packs. The newest selected pack is shown
                  first.
                </p>
              )}
              {packs.length > 0 && (
                <div className="grid gap-2 sm:grid-cols-3">
                  {packs.map((pack) => (
                    <div
                      key={pack.id}
                      className="relative rounded-md border bg-background p-2"
                    >
                      {pack.imageUrl && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={pack.imageUrl}
                          alt=""
                          className="mb-2 h-16 w-full object-contain"
                        />
                      )}
                      <p className="truncate pr-5 text-xs font-medium">
                        {pack.name}
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        {formatCurrency(pack.priceUsd)} per open
                      </p>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="absolute right-1 top-1"
                        aria-label={`Remove ${pack.name}`}
                        disabled={isPending}
                        onClick={() =>
                          applyPacks(
                            packs.filter((item) => item.id !== pack.id),
                          )
                        }
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {template === "page" && (
            <div className="space-y-1.5 rounded-md border p-3">
              <Label className="text-xs text-muted-foreground">
                Destination
              </Label>
              <Select
                value={pagePath}
                onValueChange={(v) => {
                  if (v) applyPage(v);
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MAIN_SITE_PAGES.map((p) => (
                    <SelectItem key={p.path} value={p.path}>
                      {p.label}
                      <span className="ml-2 text-xs text-muted-foreground">
                        {p.path}
                      </span>
                    </SelectItem>
                  ))}
                  <SelectItem value={CUSTOM_PAGE}>Custom URL…</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                {pagePath === CUSTOM_PAGE
                  ? "Enter the full URL in the Link field below."
                  : "Announce a newly released page — the link below points at it."}
              </p>
            </div>
          )}

          {template === "challenge" && (
            <div className="space-y-3 rounded-md border p-3">
              <div>
                <Label className="text-xs text-muted-foreground">
                  Challenge design
                </Label>
                <p className="text-[11px] text-muted-foreground">
                  Broadcasts to the audience below using the matching
                  customer-side card.
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Game</Label>
                  <Select
                    value={challengeGame}
                    onValueChange={(value) =>
                      applyChallenge({ game: value as ChallengeGame })
                    }
                    disabled={isPending}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="keno">Keno</SelectItem>
                      <SelectItem value="upgrader">Upgrader</SelectItem>
                      <SelectItem value="pack">Pack opening</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">
                    Prize (optional)
                  </Label>
                  <Input
                    value={challengePrize}
                    onChange={(event) =>
                      applyChallenge({ prize: event.target.value })
                    }
                    inputMode="decimal"
                    placeholder="25.00"
                    disabled={isPending}
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">
                  Challenge name
                </Label>
                <Input
                  value={challengeName}
                  onChange={(event) =>
                    applyChallenge({ name: event.target.value })
                  }
                  maxLength={200}
                  placeholder="e.g. Lucky Seven"
                  disabled={isPending}
                />
              </div>
            </div>
          )}

          {template === "promo" && (
            <div className="space-y-2 rounded-md border p-3">
              <Label className="text-xs text-muted-foreground">
                Promo code
              </Label>
              <PromoPicker value={promo} onSelect={applyPromo} />
              <Input
                value={manualCode}
                onChange={(e) => handleManualCode(e.target.value)}
                placeholder="…or type a code manually"
                className="uppercase"
                disabled={isPending}
              />
              {promo && (
                <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Badge variant="outline">
                    {formatCurrency(promo.valueUsd)}
                  </Badge>
                  <Badge variant="outline">{promo.region}</Badge>
                  <Badge variant="outline">
                    {promo.redeemedCount}/{promo.maxUses} used
                  </Badge>
                  {promo.requiresDiscord && (
                    <Badge variant="outline">Discord required</Badge>
                  )}
                  {promo.minimumLevel > 0 && (
                    <Badge variant="outline">Level {promo.minimumLevel}+</Badge>
                  )}
                  {promo.expiresAt && (
                    <Badge variant="outline">
                      Expires {formatDate(promo.expiresAt)}
                    </Badge>
                  )}
                </div>
              )}
              <p className="text-[11px] text-muted-foreground">
                Codes are redeemed in the wallet&apos;s deposit tab, which has
                no deep link — the code in the message body is what users copy.
                Add a link below only if the button should open a page.
              </p>
            </div>
          )}

          {!packAutoFilled && (
            <>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Title</Label>
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. Scheduled maintenance tonight"
                  disabled={isPending}
                  autoFocus
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">
                  Message (optional)
                </Label>
                <Textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={3}
                  placeholder="More detail shown when a user opens it"
                  disabled={isPending}
                />
              </div>

              <div className="rounded-md border">
                <button
                  type="button"
                  onClick={() => setLinkOpen((v) => !v)}
                  className="flex w-full items-center gap-1.5 px-3 py-2 text-left"
                >
                  {linkExpanded ? (
                    <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
                  )}
                  <span className="text-xs font-medium">
                    Link, image &amp; button
                  </span>
                  <span
                    className={`ml-auto truncate text-[11px] ${
                      imageInvalid
                        ? "text-rose-600 dark:text-rose-400"
                        : "text-muted-foreground"
                    }`}
                  >
                    {imageInvalid
                      ? "Image needs attention"
                      : filledParts.length > 0
                        ? filledParts.join(" · ")
                        : "Text only"}
                  </span>
                </button>

                {linkExpanded && (
                  <div className="border-t p-3">
                    <PayloadFields
                      payload={payload}
                      onChange={(patch) =>
                        setPayload((cur) => ({ ...cur, ...patch }))
                      }
                      imageInvalid={imageInvalid}
                      uploading={uploading}
                      disabled={isPending}
                      onUpload={handleUpload}
                    />
                  </div>
                )}
              </div>
            </>
          )}

          {packAutoFilled ? (
            <div className="space-y-2">
              <NotificationPreview
                type={TEMPLATE_TYPES.pack}
                payload={
                  composedPayloadCheck.ok
                    ? composedPayloadCheck.payload
                    : undefined
                }
              />
              {!composedPayloadCheck.ok && (
                <p className="text-xs text-rose-600 dark:text-rose-400">
                  {composedPayloadCheck.error}
                </p>
              )}
            </div>
          ) : (
            <AnnouncementPreview
              title={title}
              body={body}
              payload={payload}
              imageInvalid={imageInvalid}
            />
          )}

          <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2">
            <span className="text-sm font-medium">Sends to</span>
            <span className="text-sm text-muted-foreground">
              {everyoneAudience
                ? "Everyone"
                : audienceLabel([...audienceRoles])}
            </span>
          </div>

          <button
            type="button"
            onClick={() => setAdvancedOpen((v) => !v)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {advancedOpen ? (
              <ChevronDown className="size-3" />
            ) : (
              <ChevronRight className="size-3" />
            )}
            Advanced options
          </button>

          {advancedOpen && (
            <div className="space-y-3 rounded-md border p-3">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">
                  Audience
                </Label>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={everyoneAudience}
                    onCheckedChange={(v) => setEveryoneAudience(Boolean(v))}
                  />
                  Everyone
                </label>
                {!everyoneAudience && (
                  <div className="ml-6 space-y-1">
                    {AUDIENCE_OPTIONS.map((o) => (
                      <label
                        key={o.value}
                        className="flex items-center gap-2 text-sm"
                      >
                        <Checkbox
                          checked={audienceRoles.has(o.value)}
                          onCheckedChange={() => toggleRole(o.value)}
                        />
                        {o.label}
                      </label>
                    ))}
                  </div>
                )}
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">
                  Category
                </Label>
                <Select
                  value={category}
                  onValueChange={(v) =>
                    setCategory(v as AnnouncementCreateCategory)
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="news">News</SelectItem>
                    <SelectItem value="system">System</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {template !== "pack" && (
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Type</Label>
                  <Input
                    value={type}
                    onChange={(e) => setType(e.target.value)}
                    placeholder="admin_announcement"
                    disabled={isPending}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Machine tag stored with the announcement — the site can key
                    an icon off it. Keep the template default unless you know
                    the client handles another value.
                  </p>
                </div>
              )}
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">
                  Ends at (optional)
                </Label>
                <Input
                  type="datetime-local"
                  value={endsAt}
                  onChange={(e) => setEndsAt(e.target.value)}
                  disabled={isPending}
                />
                <p className="text-[11px] text-muted-foreground">
                  Leave empty to run until manually revoked.
                </p>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => handleOpenChange(false)}
            disabled={isPending}
            className="w-full sm:w-auto"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isPending || uploading || !title.trim() || imageInvalid}
            className="w-full sm:w-auto"
          >
            {isPending ? "Publishing..." : "Publish"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The three payload inputs, shared by both containers (bordered collapsible
 * on the text/page/promo templates, bare escape hatch on the pack one). */
function PayloadFields({
  payload,
  onChange,
  imageInvalid,
  uploading,
  disabled,
  onUpload,
}: {
  payload: AnnouncementPayloadDraft;
  onChange: (patch: Partial<AnnouncementPayloadDraft>) => void;
  imageInvalid: boolean;
  uploading: boolean;
  disabled: boolean;
  onUpload: (file: File) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">Link (optional)</Label>
        <Input
          value={payload.url}
          onChange={(e) => onChange({ url: e.target.value })}
          placeholder="https://packy.gg/games/packs/…"
          disabled={disabled}
        />
      </div>

      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">
          Button label (optional)
        </Label>
        <Input
          value={payload.ctaLabel}
          onChange={(e) => onChange({ ctaLabel: e.target.value })}
          placeholder="e.g. Open now"
          maxLength={ANNOUNCEMENT_CTA_MAX}
          disabled={disabled}
        />
      </div>

      <ImageField
        value={payload.imageUrl}
        invalid={imageInvalid}
        uploading={uploading}
        disabled={disabled}
        onChange={(v) => onChange({ imageUrl: v })}
        onUpload={onUpload}
      />
    </div>
  );
}

function promoBody(p: AnnouncementPromoOption): string {
  const parts = [
    `Use code ${p.code} in your wallet to claim ${formatCurrency(p.valueUsd)}.`,
  ];
  if (p.requiresDiscord) parts.push("Your Discord must be linked.");
  if (p.minimumLevel > 0) parts.push(`Level ${p.minimumLevel}+ only.`);
  if (p.expiresAt) parts.push(`Expires ${formatDate(p.expiresAt)}.`);
  return parts.join(" ");
}

/** Live promo codes with their plaintext, so the code needn't be retyped. */
function PromoPicker({
  value,
  onSelect,
}: {
  value: AnnouncementPromoOption | null;
  onSelect: (promo: AnnouncementPromoOption) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<AnnouncementPromoOption[]>([]);
  const [restricted, setRestricted] = useState(false);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (!open) return;
    startTransition(async () => {
      const result = await searchAnnouncementPromoCodes(query);
      setItems(result.items);
      setRestricted(result.restricted);
    });
  }, [open, query]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            className="h-9 w-full justify-between text-left font-normal"
          />
        }
      >
        {value ? (
          <span className="flex items-center gap-2 truncate">
            <span className="truncate font-mono text-sm">{value.code}</span>
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">
              {formatCurrency(value.valueUsd)}
            </span>
          </span>
        ) : (
          <span className="text-muted-foreground">Pick a live code...</span>
        )}
        <ChevronsUpDown className="ml-1 size-3 shrink-0 opacity-50" />
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search codes..."
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            {isPending && items.length === 0 && (
              <div className="space-y-1 p-1" aria-hidden>
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="px-2 py-1.5">
                    <Skeleton className="h-3.5 w-2/3 rounded" />
                  </div>
                ))}
              </div>
            )}
            {!isPending && items.length === 0 && (
              <CommandEmpty>
                {restricted
                  ? "You don't have access to the promo code list — type the code manually."
                  : "No live promo codes found."}
              </CommandEmpty>
            )}
            {items.map((item) => (
              <CommandItem
                key={item.id}
                value={item.id}
                onSelect={() => {
                  onSelect(item);
                  setOpen(false);
                }}
              >
                <div className="flex w-full items-center gap-2">
                  <div className="flex-1 truncate">
                    <div className="truncate font-mono text-sm">
                      {item.code}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {formatCurrency(item.valueUsd)} · {item.redeemedCount}/
                      {item.maxUses} used
                      {item.expiresAt
                        ? ` · expires ${formatDate(item.expiresAt)}`
                        : ""}
                    </div>
                  </div>
                </div>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Image field. The backend only accepts ImageKit URLs, so this offers a direct
 * upload (same ImageKit path the pack/card forms use) next to manual entry,
 * and blocks submit on any other host instead of letting the create 422.
 */
function ImageField({
  value,
  invalid,
  uploading,
  disabled,
  onChange,
  onUpload,
}: {
  value: string;
  invalid: boolean;
  uploading: boolean;
  disabled: boolean;
  onChange: (v: string) => void;
  onUpload: (file: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">Image (optional)</Label>
      <div className="flex items-start gap-2">
        {value && !invalid ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={value}
            alt=""
            className="size-14 shrink-0 rounded border object-contain"
          />
        ) : (
          <div className="flex size-14 shrink-0 items-center justify-center rounded border border-dashed text-muted-foreground">
            {uploading ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Upload className="size-4" />
            )}
          </div>
        )}
        <div className="flex-1 space-y-1">
          <Input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={`${IMAGEKIT_URL_PREFIX}…`}
            disabled={disabled || uploading}
          />
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 gap-1 text-xs"
              disabled={disabled || uploading}
              onClick={() => inputRef.current?.click()}
            >
              <Upload className="size-3" />
              {uploading ? "Uploading..." : "Upload"}
            </Button>
            {value && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 gap-1 text-xs text-muted-foreground hover:text-rose-600"
                disabled={disabled || uploading}
                onClick={() => onChange("")}
              >
                <Trash2 className="size-3" />
                Remove
              </Button>
            )}
          </div>
          {invalid && (
            <p className="text-[11px] text-rose-600 dark:text-rose-400">
              Only ImageKit images render on the site — upload the file here
              instead of pasting another host.
            </p>
          )}
        </div>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onUpload(file);
          e.target.value = "";
        }}
      />
    </div>
  );
}

/** What the user will see: image, copy and the button, before it ships. */
function AnnouncementPreview({
  title,
  body,
  payload,
  imageInvalid,
}: {
  title: string;
  body: string;
  payload: AnnouncementPayloadDraft;
  imageInvalid: boolean;
}) {
  const showImage = payload.imageUrl.trim() !== "" && !imageInvalid;
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">Preview</p>
      <div className="flex gap-3 rounded-md border bg-muted/30 p-3">
        {showImage && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={payload.imageUrl.trim()}
            alt=""
            className="size-12 shrink-0 rounded object-contain"
          />
        )}
        <div className="min-w-0 flex-1 space-y-1">
          <p className="truncate text-sm font-medium">
            {title.trim() || "Untitled announcement"}
          </p>
          {body.trim() && (
            <p className="line-clamp-3 text-xs text-muted-foreground">
              {body.trim()}
            </p>
          )}
          {payload.url.trim() && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              {payload.ctaLabel.trim() && (
                <span className="rounded border px-2 py-0.5 text-[11px] font-medium">
                  {payload.ctaLabel.trim()}
                </span>
              )}
              <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                <ExternalLink className="size-3" />
                {shortUrlLabel(payload.url.trim())}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
