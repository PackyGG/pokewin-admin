export const REVIEW_REMINDER_FIELD_NAMES = {
  username: "\u{1F464} Username",
  userId: "\u{1F194} User ID",
  caseId: "\u{1F4C1} Case ID",
  claimedBy: "\u{1F64B} Claimed by",
  startedBy: "\u{1F64B} Started by",
} as const;

type ReviewReminderCardInput = {
  reviewId: string;
  targetUserId: string;
  targetUsername: string | null;
  staffAction: "claimed" | "started";
  staffUsername: string | null;
};

function reviewUrl(reviewId: string): string {
  const url = new URL("https://fraud.packydash.com/reviews");
  url.searchParams.set("review", reviewId);
  return url.toString();
}

function safeDiscordText(value: string, max: number): string {
  return value
    .replace(/@/g, "@\u200b")
    .replace(/[`*_~|>]/g, "\\$&")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, max);
}

function inlineCode(value: string, max = 100): string {
  return `\`${value.replace(/`/g, "'").trim().slice(0, max)}\``;
}

export function buildReviewReminderMessage(
  input: ReviewReminderCardInput,
  correlationId: string,
) {
  const url = reviewUrl(input.reviewId);
  const staffField =
    input.staffAction === "claimed"
      ? REVIEW_REMINDER_FIELD_NAMES.claimedBy
      : REVIEW_REMINDER_FIELD_NAMES.startedBy;

  return {
    embed: {
      title: "\u26A0\uFE0F Account review reminder",
      url,
      color: 0xf97316,
      fields: [
        {
          name: REVIEW_REMINDER_FIELD_NAMES.username,
          value: safeDiscordText(input.targetUsername ?? "Unknown", 100),
          inline: true,
        },
        {
          name: REVIEW_REMINDER_FIELD_NAMES.userId,
          value: inlineCode(input.targetUserId),
          inline: true,
        },
        {
          name: REVIEW_REMINDER_FIELD_NAMES.caseId,
          value: inlineCode(input.reviewId),
          inline: true,
        },
        ...(input.staffUsername
          ? [
              {
                name: staffField,
                value: safeDiscordText(input.staffUsername, 100),
                inline: true,
              },
            ]
          : []),
      ],
      footer: { text: `Account review reminder | Correlation ${correlationId}` },
      timestamp: new Date().toISOString(),
    },
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 5,
            label: "Open Account Review",
            url,
          },
        ],
      },
    ],
  };
}
