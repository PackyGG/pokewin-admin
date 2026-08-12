import { PageHeroSkeleton } from "@/components/loading-skeletons";

import { DiscordWorkspaceSkeleton } from "./discord-workspace-skeleton";

/**
 * Matches /system/discord-moderation: hero + the tabbed Discord workspace.
 * Renders the SAME shell the page renders, so navigating here paints the
 * layout instantly instead of falling back to the generic (admin) skeleton
 * while ~9 Admin-DB reads resolve.
 */
export default function DiscordModerationLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <DiscordWorkspaceSkeleton />
    </div>
  );
}
