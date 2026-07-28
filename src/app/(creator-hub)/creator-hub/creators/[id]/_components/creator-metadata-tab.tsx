import { Suspense } from "react";
import Link from "next/link";
import {
  BadgeCheck,
  CalendarDays,
  Globe,
  Hash,
  IdCard,
  Info,
  Link2,
  Mail,
  ShieldCheck,
  UserCog,
  UserPlus,
  Users,
} from "lucide-react";

import { SectionHeading } from "@/components/modern-panels";
import { HubNotice } from "../../../_components/hub-notice";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { FadeIn } from "@/components/fade-in";
import { safeQueryOrNull } from "@/lib/errors/safe-query";
import { formatDate, formatRelative } from "@/lib/utils/format";

// Reuse the existing masked-email client component from the (admin) creators
// group (sibling route group on disk) — imported, not edited, the same
// cross-group reuse the banner already does.
import { MaskedEmail } from "../../../../../(admin)/creators/[userId]/masked-email";

import {
  getCreatorMetadata,
  type CreatorMetadata,
} from "../_queries/creator-metadata";
import { SocialLinksEditor } from "./social-links-editor";

/**
 * `creators/[id]` — **Creator (metadata)** tab.
 *
 * Owner spec: a tab holding ALL of the creator's metadata, an in-place editor
 * for the social links (Twitter / Kick / Discord ID / Reward page), and a
 * "set up by" line showing which manager onboarded them.
 *
 * Self-contained: takes only `userId` and fetches its OWN data
 * (`getCreatorMetadata`) when rendered. LAZY — wrapped in its own keyed
 * Suspense boundary, so its reads run only when this tab is opened (the
 * active-tab-only rule); it never blocks the banner/other tabs.
 *
 * MAIN/prod game DB is READ-ONLY here (identity + codes are plain SELECTs);
 * the only writes are the social edits, which hit the ADMIN DB via the
 * server actions in `creator-tab-actions.ts`. No data is fabricated — fields
 * with no source (e.g. a reward-page URL, which has no column) are omitted or
 * shown as "not set", never guessed.
 */
export function CreatorMetadataTab({ userId }: { userId: string }) {
  return (
    <Suspense fallback={<CreatorMetadataTabSkeleton />}>
      <CreatorMetadataTabContent userId={userId} />
    </Suspense>
  );
}

async function CreatorMetadataTabContent({ userId }: { userId: string }) {
  // The query's best-effort legs degrade to gap labels internally; this
  // wrapper catches what remains (the MAIN identity reads) so a DB blip
  // renders a VISIBLE band instead of throwing the tab into the route
  // error boundary.
  const { data: meta, error } = await safeQueryOrNull(
    () => getCreatorMetadata(userId),
    "creator-hub.creators.metadata",
    15_000,
  );

  if (error) {
    return (
      <HubNotice tone="amber" icon={Info} title="Creator metadata couldn't load">
        The identity / codes lookup failed or timed out. Refresh to retry —
        the rest of the page is unaffected.
      </HubNotice>
    );
  }

  if (!meta) {
    return (
      <Card size="sm" className="p-6 text-center text-sm text-muted-foreground">
        No metadata found for this creator.
      </Card>
    );
  }

  // Only the platforms the editor manages, mapped to the {platform, username}
  // shape it reads. Other linked platforms (youtube/instagram) still show in
  // the read-only "all linked socials" summary below.
  const editorSocials = meta.socials
    .filter((s) => ["twitter", "kick", "discord"].includes(s.platform))
    .map((s) => ({ platform: s.platform, username: s.username }));

  return (
    <FadeIn className="space-y-5 sm:space-y-6">
      {/* Visible gap chips — one per best-effort leg that failed this load,
          so a degraded section is never mistaken for "no data". */}
      {meta.gaps.length > 0 && (
        <HubNotice tone="amber" icon={Info} dashed>
          <span className="mr-1.5">Partial load — refresh to retry:</span>
          {meta.gaps.map((gap) => (
            <Badge key={gap} variant="outline" className="mr-1 text-[10px]">
              {gap}
            </Badge>
          ))}
        </HubNotice>
      )}

      {/* ── Identity + account metadata ───────────────────────────────── */}
      <div className="space-y-3">
        <SectionHeading icon={IdCard} title="Creator details" />
        <Card size="sm" className="p-4 sm:p-5">
          <div className="flex items-start gap-3">
            <Avatar className="size-12 shrink-0">
              {meta.image && <AvatarImage src={meta.image} alt="" />}
              <AvatarFallback className="text-xs font-semibold">
                {(meta.username ?? meta.email ?? "?").slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  href={`/users/${meta.userId}`}
                  className="text-base font-semibold leading-tight hover:underline"
                  title="Open user profile"
                >
                  {meta.username ?? meta.email ?? "Unknown creator"}
                </Link>
                <Badge variant="outline" className="text-[10px] capitalize">
                  {meta.role}
                </Badge>
                {meta.affiliateCodeActive ? (
                  <Badge
                    variant="outline"
                    className="border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-600 dark:text-emerald-400"
                  >
                    <BadgeCheck className="mr-1 size-3" />
                    Code active
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="text-[10px]">
                    Code inactive
                  </Badge>
                )}
              </div>
              {meta.displayUsername &&
                meta.displayUsername !== meta.username && (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Display name: {meta.displayUsername}
                  </p>
                )}
            </div>
          </div>

          {/* Metadata grid */}
          <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
            <MetaField icon={Mail} label="Email">
              {meta.email ? (
                <MaskedEmail email={meta.email} className="text-sm" />
              ) : (
                <span className="text-sm text-muted-foreground">—</span>
              )}
            </MetaField>

            <MetaField icon={CalendarDays} label="Joined">
              {meta.createdAt ? (
                <span className="text-sm">
                  {formatDate(meta.createdAt)}
                  <span className="ml-1.5 text-xs text-muted-foreground">
                    ({formatRelative(meta.createdAt)})
                  </span>
                </span>
              ) : (
                <span className="text-sm text-muted-foreground">—</span>
              )}
            </MetaField>

            <MetaField icon={Globe} label="Location">
              <span className="text-sm">
                {formatLocation(meta) ?? (
                  <span className="text-muted-foreground">—</span>
                )}
              </span>
            </MetaField>

            <MetaField icon={UserPlus} label="Referred by">
              {meta.referredByUserId ? (
                <Link
                  href={`/creator-hub/creators/${meta.referredByUserId}`}
                  className="text-sm font-medium hover:underline"
                >
                  {meta.referredByName ?? meta.referredByUserId.slice(0, 8)}
                </Link>
              ) : (
                <span className="text-sm text-muted-foreground">
                  Not referred
                </span>
              )}
            </MetaField>

            <MetaField
              icon={Hash}
              label={`Affiliate code${meta.codes.length > 1 ? "s" : ""}`}
              className="sm:col-span-2"
            >
              {meta.codes.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  {meta.codes.map((code, i) => (
                    <Badge
                      key={code}
                      variant="outline"
                      className="font-mono text-[11px]"
                    >
                      {code}
                      {i === 0 && (
                        <span className="ml-1 text-[9px] uppercase tracking-wide text-muted-foreground">
                          primary
                        </span>
                      )}
                    </Badge>
                  ))}
                </div>
              ) : (
                <span className="text-sm text-muted-foreground">
                  No affiliate code
                </span>
              )}
            </MetaField>
          </dl>

          {/* ── Set up by (onboarding manager from the audit trail) ─────── */}
          <OnboardedByLine onboardedBy={meta.onboardedBy} />
        </Card>
      </div>

      {/* ── Social links editor ───────────────────────────────────────── */}
      <div className="space-y-3">
        <SectionHeading icon={Link2} title="Social links" />
        <SocialLinksEditor
          userId={meta.userId}
          initialSocials={editorSocials}
          initialDiscordChannelUrl={meta.discordChannelUrl}
          initialRewardPageUrl={meta.rewardPageUrl}
        />

        {/* Read-only summary of ANY other linked platforms the editor above
            doesn't manage (youtube / instagram), so they're still visible. */}
        <OtherSocials socials={meta.socials} />
      </div>
    </FadeIn>
  );
}

// ─────────────────────────────────────────────────────────────────────

function MetaField({
  icon: Icon,
  label,
  children,
  className,
}: {
  icon: React.ElementType;
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <dt className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <Icon className="size-3.5" />
        {label}
      </dt>
      <dd className="mt-1">{children}</dd>
    </div>
  );
}

function formatLocation(meta: CreatorMetadata): string | null {
  const parts = [meta.city, meta.state, meta.country].filter(
    (p): p is string => !!p && p.trim().length > 0,
  );
  return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * "Set up by" line — names the manager who onboarded the creator, sourced
 * from the earliest `user_made_creator` audit event. Renders an honest
 * "Onboarding manager not recorded" state when no event exists (e.g. creators
 * promoted before audit logging, or via a path that didn't log).
 */
function OnboardedByLine({
  onboardedBy,
}: {
  onboardedBy: CreatorMetadata["onboardedBy"];
}) {
  if (!onboardedBy || (!onboardedBy.managerName && !onboardedBy.at)) {
    return (
      <div className="mt-4 flex items-center gap-2 border-t pt-3 text-xs text-muted-foreground">
        <UserCog className="size-3.5 shrink-0" />
        <span>Onboarding manager not recorded.</span>
      </div>
    );
  }

  return (
    <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 border-t pt-3 text-xs">
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        <ShieldCheck className="size-3.5 shrink-0 text-emerald-500" />
        Set up by
      </span>
      <span className="font-semibold text-foreground">
        {onboardedBy.managerName ?? "an admin"}
      </span>
      {onboardedBy.managerRole && (
        <Badge variant="outline" className="text-[9px] capitalize">
          {onboardedBy.managerRole.replace(/_/g, " ")}
        </Badge>
      )}
      {onboardedBy.at && (
        <span className="text-muted-foreground">
          · {formatDate(onboardedBy.at)} ({formatRelative(onboardedBy.at)})
        </span>
      )}
    </div>
  );
}

/**
 * Read-only chips for linked platforms the editor doesn't manage
 * (youtube / instagram). Keeps every linked social visible without offering an
 * edit affordance the owner spec didn't ask for on this tab.
 */
function OtherSocials({
  socials,
}: {
  socials: CreatorMetadata["socials"];
}) {
  const others = socials.filter(
    (s) => !["twitter", "kick", "discord"].includes(s.platform),
  );
  if (others.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 pt-1">
      <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
        <Users className="size-3.5" />
        Also linked:
      </span>
      {others.map((s) => (
        <Badge key={s.id} variant="secondary" className="text-[11px]">
          <span className="capitalize">{s.platform}</span>
          <span className="ml-1 font-mono">@{s.username.replace(/^@/, "")}</span>
        </Badge>
      ))}
    </div>
  );
}

// ── Suspense fallback ─────────────────────────────────────────────────

function CreatorMetadataTabSkeleton() {
  return (
    <div className="space-y-5 sm:space-y-6">
      <div className="space-y-3">
        <Skeleton className="h-6 w-40" />
        <Card size="sm" className="space-y-4 p-4 sm:p-5">
          <div className="flex items-start gap-3">
            <Skeleton className="size-12 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-3 w-32" />
            </div>
          </div>
          <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="space-y-1.5">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-4 w-40" />
              </div>
            ))}
          </div>
          <Skeleton className="h-3 w-56" />
        </Card>
      </div>
      <div className="space-y-3">
        <Skeleton className="h-6 w-32" />
        <div className="space-y-2 rounded-xl border p-3">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}
