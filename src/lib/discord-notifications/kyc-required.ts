import "server-only";

import { enqueueDiscordEvent } from "./router";

function safeDiscordText(value: string, max: number): string {
  return value
    .replace(/@/g, "@\u200b")
    .replace(/[`*_~|>]/g, "\\$&")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, max);
}

export async function enqueueKycRequiredReview(input: {
  userId: string;
  reason: string;
  levelName?: string;
  verificationCycle: number;
}): Promise<void> {
  const guildId = process.env.ADMIN_GUILD_ID?.trim();
  if (!guildId) throw new Error("ADMIN_GUILD_ID is not configured");

  const url = new URL("https://fraud.packydash.com/kyc");
  url.searchParams.set("user", input.userId);
  const result = await enqueueDiscordEvent({
    guildId,
    eventKey: "antifraud.kyc_required",
    dedupeKey: `kyc-required:${input.userId}:${input.verificationCycle}`,
    embed: {
      title: "KYC account review required",
      description: "An account was placed into KYC review by staff.",
      url: url.toString(),
      color: 0xf0b232,
      fields: [
        {
          name: "Account",
          value: `User ID \`${safeDiscordText(input.userId, 128)}\``,
          inline: true,
        },
        {
          name: "Verification cycle",
          value: String(input.verificationCycle),
          inline: true,
        },
        {
          name: "KYC level",
          value: safeDiscordText(input.levelName || "Default", 100),
          inline: true,
        },
        {
          name: "Reason",
          value: safeDiscordText(input.reason, 500),
          inline: false,
        },
      ],
      footer: { text: "KYC review | PackyGG Fraud" },
      timestamp: new Date().toISOString(),
    },
  });

  if (result.enqueued + result.duplicate === 0) {
    throw new Error("KYC required notification has no eligible Discord route");
  }
}
