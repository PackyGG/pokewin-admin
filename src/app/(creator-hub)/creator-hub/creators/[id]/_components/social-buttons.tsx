import { ExternalLink, MessageSquare, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Creator banner social buttons — one button per linked social account,
 * plus a dedicated Discord-channel button.
 *
 * Data source (REAL, no fabrication): the `creator_socials` admin-DB rows
 * (platform + username) the existing `getCreatorHeaderSocials` query
 * returns. `creator_socials` stores a handle, NOT a stored URL, so each
 * button's href is constructed from the platform + handle via the
 * well-known public profile URL pattern for that platform. A platform we
 * don't have a URL pattern for renders a non-navigating chip (no broken
 * link) rather than guessing.
 *
 * The DISCORD CHANNEL button is separate from the per-social buttons: it
 * opens `creator_socials.discord_channel_url` when set, otherwise renders
 * disabled with a clear "channel link not set" state.
 *
 * Server-safe (plain links, no client state). Icons are imported directly
 * from lucide-react (not the sidebar ICONS map).
 */

type SocialLike = {
  id: string;
  platform: string;
  username: string;
  followerCount: number | null;
  subscriberCount: number | null;
};

// Platform → label + accent + public profile URL builder. Only platforms we
// can build a real public URL for get a builder; others render as a
// non-navigating chip.
const PLATFORM_META: Record<
  string,
  {
    label: string;
    color: string;
    bg: string;
    border: string;
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
  discord: {
    label: "Discord",
    color: "text-indigo-500",
    bg: "bg-indigo-500/10 hover:bg-indigo-500/20",
    border: "border-indigo-500/25",
    // A Discord "username"/ID isn't a navigable public profile URL — render
    // as a non-navigating chip. The CHANNEL link (separate button below)
    // is the navigable Discord affordance.
    url: null,
  },
};

function SocialButtonChip({
  icon: Icon,
  label,
  sub,
  href,
  className,
  iconClassName,
}: {
  icon: LucideIcon;
  label: string;
  sub?: string;
  href: string | null;
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
        title={`${label} — no public link`}
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
      title={`Open ${label}`}
    >
      {inner}
    </a>
  );
}

export function SocialButtons({
  socials,
  discordChannelUrl,
}: {
  socials: SocialLike[];
  /**
   * Per-creator Discord *channel* deep-link. Stored in the admin DB on
   * creation (a later wave) — null until then, in which case the
   * Discord-channel button renders disabled rather than guessing a URL.
   */
  discordChannelUrl: string | null;
}) {
  const connected = socials.filter((s) => s.username);

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
            icon={ExternalLink}
            label={meta.label}
            sub={`@${handle}`}
            href={href}
            className={cn(meta.bg, meta.border)}
            iconClassName={meta.color}
          />
        );
      })}

      {/* Discord channel button — its own affordance, always shown. Opens
          the creator's Discord channel link when set; disabled with a clear
          "not set" state until the admin-DB channel-link column lands. */}
      <SocialButtonChip
        icon={MessageSquare}
        label="Discord channel"
        href={discordChannelUrl}
        className="border-indigo-500/25 bg-indigo-500/10 hover:bg-indigo-500/20"
        iconClassName="text-indigo-500"
      />
      {!discordChannelUrl && (
        <span className="text-[11px] text-muted-foreground/70">
          channel link not set yet
        </span>
      )}

      {connected.length === 0 && (
        <span className="inline-flex items-center rounded-md border border-dashed px-2 py-1 text-[11px] text-muted-foreground">
          No socials linked
        </span>
      )}
    </div>
  );
}
