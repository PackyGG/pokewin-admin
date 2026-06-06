import { Suspense } from "react";
import Link from "next/link";
import { ArrowLeft, Star } from "lucide-react";

import { PageHero } from "@/components/modern-panels";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

// Reuse the EXISTING masked-email client component + header-socials read
// from the (admin) creators group (sibling route group on disk). Importing
// — not editing — them, the same cross-group reuse the Hub dashboard does.
import { MaskedEmail } from "../../../../../(admin)/creators/[userId]/masked-email";
import { getCreatorHeaderSocials } from "../../../../../(admin)/creators/[userId]/_queries/header-socials";
import { getCreatorSocialUrls } from "@/lib/creator-social-urls";

import { SocialButtons } from "./social-buttons";

/**
 * Creator detail top banner (identity bar).
 *
 * Renders the creator's profile picture, username, creator code chip(s),
 * email with a hide/show toggle, a button per linked social, and a dedicated
 * Discord-channel button. Mirrors the owner spec for the `creators/[id]`
 * banner and matches the Hub's PageHero look.
 *
 * The cheap header (username / image / email / primary code) is passed in
 * from the page's critical-path `getCreatorHeader` read so the banner paints
 * immediately; the social buttons stream in their OWN Suspense boundary off a
 * thin admin-DB read (`getCreatorHeaderSocials`) so they never block the
 * banner text.
 *
 * Discord channel link is read from `creator_socials.discord_channel_url`
 * (admin DB) and passed to `SocialButtons`.
 */

export type CreatorBannerHeader = {
  userId: string;
  username: string | null;
  email: string | null;
  image: string | null;
  role: string;
  code: string;
};

export function CreatorBanner({ header }: { header: CreatorBannerHeader }) {
  const initials = (header.username ?? header.email ?? "?")
    .slice(0, 2)
    .toUpperCase();

  return (
    <PageHero>
      <div className="flex items-start gap-2.5 sm:gap-3 flex-wrap">
        <Link
          href="/creator-hub"
          aria-label="Back to Creator Hub"
          className="inline-flex size-9 items-center justify-center rounded-md hover:bg-accent hover:text-accent-foreground shrink-0"
        >
          <ArrowLeft className="size-4" />
        </Link>
        <Avatar className="size-11 sm:size-12 shrink-0">
          {header.image && <AvatarImage src={header.image} alt="" />}
          <AvatarFallback className="text-xs font-semibold">
            {initials}
          </AvatarFallback>
        </Avatar>
        <div className="hidden sm:flex size-11 items-center justify-center rounded-xl bg-pink-500/10 shrink-0">
          <Star className="size-5 text-pink-500" />
        </div>

        <div className="flex-1 min-w-0 space-y-2">
          <div className="flex min-w-0 items-center gap-2 flex-wrap">
            <Link
              href={`/users/${header.userId}`}
              className="min-w-0 text-xl sm:text-2xl font-bold leading-tight hover:underline line-clamp-1"
              title="Open user profile"
            >
              {header.username ?? header.email ?? "Unknown creator"}
            </Link>
            {header.code ? (
              <Badge variant="outline" className="font-mono text-[11px]">
                {header.code}
              </Badge>
            ) : (
              <Badge variant="secondary" className="text-[11px]">
                No affiliate code
              </Badge>
            )}
            <Badge variant="outline" className="text-[10px] capitalize">
              {header.role}
            </Badge>
          </div>

          {header.email && (
            <MaskedEmail email={header.email} />
          )}

          {/* Social buttons + Discord channel — streamed in their own
              boundary off a thin admin-DB read so the banner text never
              waits on it. A failure degrades to the empty state. */}
          <Suspense
            fallback={
              <span className="inline-flex items-center rounded-md border border-dashed px-2 py-1 text-[11px] text-muted-foreground">
                Loading socials…
              </span>
            }
          >
            <BannerSocials userId={header.userId} />
          </Suspense>
        </div>
      </div>
    </PageHero>
  );
}

async function BannerSocials({ userId }: { userId: string }) {
  const [socials, urls] = await Promise.all([
    getCreatorHeaderSocials(userId).catch(() => []),
    getCreatorSocialUrls(userId).catch(() => ({
      discordChannelUrl: null,
      rewardPageUrl: null,
    })),
  ]);
  return (
    <SocialButtons
      socials={socials}
      discordChannelUrl={urls.discordChannelUrl}
    />
  );
}
