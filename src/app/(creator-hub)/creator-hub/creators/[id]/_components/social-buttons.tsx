import { ExternalLink } from "lucide-react";

import { DiscordIcon, KickIcon } from "@/components/brand-icons";
import type { CreatorDiscordLink } from "@/lib/creator-discord-links";
import { cn } from "@/lib/utils";

/**
 * Creator banner social buttons — one button per linked social account,
 * plus the creator's REAL Discord link when the Discord bot has one.
 *
 * Data sources (REAL, no fabrication):
 *   • Socials: the `creator_socials` admin-DB rows (platform + username) the
 *     existing `getCreatorHeaderSocials` query returns. `creator_socials`
 *     stores a handle, NOT a stored URL, so each button's href is constructed
 *     from the platform + handle via the well-known public profile URL pattern
 *     for that platform. A platform we don't have a URL pattern for renders a
 *     non-navigating chip (no broken link) rather than guessing.
 *   • Discord: `getDiscordLinkForUser` — the Discord creator-setup bot's
 *     `discord_creator_setups` row (active + linked to this packy user). This
 *     REPLACES the old hand-typed discord handle / `discord_channel_url`,
 *     which drifted from reality. Nothing Discord is typed by hand anymore:
 *     no link → no Discord chip.
 *
 * Server-safe (plain links, no client state).
 */

type SocialLike = {
  id: string;
  platform: string;
  username: string;
  followerCount: number | null;
  subscriberCount: number | null;
};

/** Same call shape as a lucide icon — brand glyphs drop in unchanged. */
type ChipIcon = React.ComponentType<{ className?: string }>;

// Platform → label + accent + public profile URL builder. Only platforms we
// can build a real public URL for get a builder; others render as a
// non-navigating chip. Discord is deliberately absent — it is not a
// hand-typed social here, it comes from the bot link below.
const PLATFORM_META: Record<
  string,
  {
    label: string;
    color: string;
    bg: string;
    border: string;
    /** Brand glyph when we have one; falls back to the generic link icon. */
    icon?: ChipIcon;
    /** Build the public profile URL from a handle, or null if unknown. */
    url: ((handle: string) => string) | null;
  }
> = {
  twitter: {
    label: "X / Twitter",
    color: "text-sky-500",
    bg: "bg-sky-500/10 hover:bg-sky-500/20",
    border: "border-sky-500/25",
    url: (h) => `https://x.com/${encodeURIComponent(h.replace(/^@/, ""))}`,
  },
  kick: {
    label: "Kick",
    color: "text-green-500",
    bg: "bg-green-500/10 hover:bg-green-500/20",
    border: "border-green-500/25",
    // Kick's own mark — the Twitch glyph must never stand in for Kick.
    icon: KickIcon,
    url: (h) => `https://kick.com/${encodeURIComponent(h.replace(/^@/, ""))}`,
  },
  youtube: {
    label: "YouTube",
    color: "text-red-500",
    bg: "bg-red-500/10 hover:bg-red-500/20",
    border: "border-red-500/25",
    // YouTube handles use the @handle path; channel IDs aren't stored, so
    // the @handle form is the correct public URL for a stored handle.
    url: (h) =>
      `https://youtube.com/@${encodeURIComponent(h.replace(/^@/, ""))}`,
  },
  instagram: {
    label: "Instagram",
    color: "text-pink-500",
    bg: "bg-pink-500/10 hover:bg-pink-500/20",
    border: "border-pink-500/25",
    url: (h) =>
      `https://instagram.com/${encodeURIComponent(h.replace(/^@/, ""))}`,
  },
  tiktok: {
    label: "TikTok",
    color: "text-foreground",
    bg: "bg-foreground/5 hover:bg-foreground/10",
    border: "border-border",
    url: (h) =>
      `https://tiktok.com/@${encodeURIComponent(h.replace(/^@/, ""))}`,
  },
};

function SocialButtonChip({
  icon: Icon,
  label,
  sub,
  href,
  title,
  className,
  iconClassName,
}: {
  icon: ChipIcon;
  label: string;
  sub?: string;
  href: string | null;
  title?: string;
  className: string;
  iconClassName: string;
}) {
  const inner = (
    <>
      <Icon className={cn("size-3.5 shrink-0", iconClassName)} />
      <span className="font-semibold">{label}</span>
      {sub && <span className="truncate text-muted-foreground">{sub}</span>}
      {href && (
        <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
      )}
    </>
  );

  const base =
    "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-colors";

  if (!href) {
    return (
      <span
        className={cn(base, className, "cursor-default opacity-90")}
        title={title ?? `${label} — no public link`}
      >
        {inner}
      </span>
    );
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(base, className)}
      title={title ?? `Open ${label}`}
    >
      {inner}
    </a>
  );
}

export function SocialButtons({
  socials,
  discordLink,
}: {
  socials: SocialLike[];
  /**
   * The creator's Discord link as reported by the Discord creator-setup bot,
   * or null when the bot has no active linked setup for them. Never typed in
   * by hand — when it's null we simply render no Discord chip.
   */
  discordLink: CreatorDiscordLink | null;
}) {
  // A legacy hand-typed `discord` row is dead data — the bot link below is
  // the only Discord truth, so such a row never renders a chip.
  const connected = socials.filter(
    (s) => s.username && s.platform !== "discord",
  );

  return (
    <div className="flex flex-wrap items-center gap-2">
      {connected.map((s) => {
        const meta = PLATFORM_META[s.platform] ?? {
          label: s.platform,
          color: "text-muted-foreground",
          bg: "bg-muted hover:bg-muted/70",
          border: "border-border",
          url: null,
        };
        const handle = s.username.replace(/^@/, "");
        const href = meta.url ? meta.url(s.username) : null;
        return (
          <SocialButtonChip
            key={s.id}
            icon={meta.icon ?? ExternalLink}
            label={meta.label}
            sub={`@${handle}`}
            href={href}
            className={cn(meta.bg, meta.border)}
            iconClassName={meta.color}
          />
        );
      })}

      {/* Discord — ONLY from the bot link. A linked creator with a known chat
          channel gets a real deep-link; linked-without-a-channel renders the
          same non-navigating chip idiom the other socials use. Not linked →
          nothing at all. */}
      {discordLink && (
        <SocialButtonChip
          icon={DiscordIcon}
          label="Discord"
          sub={discordLink.categoryName ?? undefined}
          href={discordLink.channelUrl}
          title={
            discordLink.channelUrl
              ? `Open Discord${
                  discordLink.categoryName
                    ? ` — ${discordLink.categoryName}`
                    : ""
                }`
              : "Discord linked — no chat channel recorded yet"
          }
          className="border-indigo-500/25 bg-indigo-500/10 hover:bg-indigo-500/20"
          iconClassName="text-indigo-500"
        />
      )}

      {connected.length === 0 && !discordLink && (
        <span className="inline-flex items-center rounded-md border border-dashed px-2 py-1 text-[11px] text-muted-foreground">
          No socials linked
        </span>
      )}
    </div>
  );
}
