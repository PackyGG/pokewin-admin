import { Suspense } from "react";
import Link from "next/link";
import { ArrowLeft, Info, Star } from "lucide-react";

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

/**
 * `header` is nullable: when the critical-path `getCreatorHeader` lookup
 * failed (MAIN blip / timeout — NOT a confirmed-unknown id, which 404s
 * before this renders), the banner degrades to the user id + a VISIBLE
 * amber "Identity couldn't load" band instead of blanking the page. The
 * tab bar + active tab still mount below (they only need `userId`), and
 * the socials row still streams (it reads the ADMIN DB, independent of
 * the failed MAIN lookup).
 */
export function CreatorBanner({
  header,
  userId,
}: {
  header: CreatorBannerHeader | null;
  userId: string;
}) {
  if (!header) {
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
            <AvatarFallback className="text-xs font-semibold">?</AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0 space-y-2">
            <div className="flex min-w-0 items-center gap-2 flex-wrap">
              <Link
                href={`/users/${userId}`}
                className="min-w-0 text-xl sm:text-2xl font-bold leading-tight hover:underline line-clamp-1"
                title="Open user profile"
              >
                Creator{" "}
                <span className="font-mono text-base sm:text-lg">
                  {userId.slice(0, 12)}…
                </span>
              </Link>
            </div>
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm">
              <Info className="mt-0.5 size-4 shrink-0 text-amber-500" />
              <div>
                <span className="font-medium text-amber-500">
                  Identity couldn&apos;t load
                </span>
                <span className="ml-1.5 text-muted-foreground">
                  The header lookup failed or timed out — refresh to retry.
                  The tabs below still work.
                </span>
              </div>
            </div>
            <Suspense
              fallback={
                <span className="inline-flex items-center rounded-md border border-dashed px-2 py-1 text-[11px] text-muted-foreground">
                  Loading socials…
                </span>
              }
            >
              <BannerSocials userId={userId} />
            </Suspense>
          </div>
        </div>
      </PageHero>
    );
  }

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
  // Both reads stay caught (a socials blip must never take the banner
  // down), but the failure is DISCRIMINATED: `ok: false` renders a muted
  // "socials unavailable" chip instead of the indistinguishable
  // "No socials linked" empty state a real empty list shows.
  const [socialsResult, urls] = await Promise.all([
    getCreatorHeaderSocials(userId)
      .then((socials) => ({ ok: true as const, socials }))
      .catch((err: unknown) => {
        console.error("[creator-hub.creators.banner] socials read failed:", err);
        return { ok: false as const };
      }),
    getCreatorSocialUrls(userId).catch(() => ({
      discordChannelUrl: null,
      rewardPageUrl: null,
    })),
  ]);

  if (!socialsResult.ok) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md border border-dashed px-2 py-1 text-[11px] text-muted-foreground">
        <Info className="size-3" />
        Socials unavailable right now — refresh to retry
      </span>
    );
  }

  return (
    <SocialButtons
      socials={socialsResult.socials}
      discordChannelUrl={urls.discordChannelUrl}
    />
  );
}
