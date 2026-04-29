import { PageHeroSkeleton } from "@/components/loading-skeletons";

/**
 * /chat is a server-side redirect stub that forwards to the user's default
 * landing page (chat moderation lives in a slide-out panel triggered from
 * the admin shell). The redirect happens before any UI renders, so this
 * fallback only flashes for a frame in the worst case. Kept minimal on
 * purpose — no PageHero would render here in the real flow.
 */
export default function ChatLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
    </div>
  );
}
