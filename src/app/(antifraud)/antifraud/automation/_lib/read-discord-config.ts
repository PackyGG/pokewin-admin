import "server-only";

import {
  getDiscordNotificationConfig,
  type DiscordNotificationConfig,
} from "@/lib/discord-notifications/config";

/**
 * Non-throwing read of the Discord routing configuration.
 *
 * Alert routing is context for the Automation tabs, never their reason to
 * exist — a routing-store fault must degrade one panel, not take the control
 * center to the segment error boundary.
 */
export async function readDiscordConfig(): Promise<DiscordNotificationConfig | null> {
  try {
    return await getDiscordNotificationConfig();
  } catch (error) {
    console.error("[antifraud-automation] Discord config read failed:", error);
    return null;
  }
}
