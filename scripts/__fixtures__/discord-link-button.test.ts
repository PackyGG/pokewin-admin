import assert from "node:assert/strict";
import test from "node:test";

import { ensureDiscordLinkButton } from "../../src/lib/discord-notifications/link-button.ts";

test("Discord embeds with links receive a bottom action button", () => {
  assert.deepEqual(
    ensureDiscordLinkButton({ url: "https://fraud.packydash.com/reviews/123" }),
    [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 5,
            label: "View details",
            url: "https://fraud.packydash.com/reviews/123",
          },
        ],
      },
    ],
  );
});

test("producer-specific buttons are preserved without duplicates", () => {
  const components = [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 5,
          label: "Review case",
          url: "https://fraud.packydash.com/reviews/123",
        },
      ],
    },
  ];

  assert.deepEqual(
    ensureDiscordLinkButton(
      { url: "https://fraud.packydash.com/reviews/123" },
      components,
    ),
    components,
  );
});

test("messages without a safe web link are unchanged", () => {
  assert.deepEqual(ensureDiscordLinkButton({ title: "No destination" }), []);
  assert.deepEqual(ensureDiscordLinkButton({ url: "javascript:alert(1)" }), []);
});
