import assert from "node:assert/strict";
import test from "node:test";

import {
  EMPTY_PAYLOAD_DRAFT,
  validateAnnouncementPayload,
} from "@/lib/announcement-payload";
import { previewNotificationText } from "@/lib/user-notification-templates";

test("challenge broadcast payload preserves the fields used by the site card", () => {
  const result = validateAnnouncementPayload({
    ...EMPTY_PAYLOAD_DRAFT,
    url: "https://packy.gg/rewards?tab=challenges",
    ctaLabel: "View challenge",
    challengeName: "Lucky Seven",
    challengeGame: "keno",
    challengePrizeUsd: "$25",
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.payload, {
    url: "https://packy.gg/rewards?tab=challenges",
    cta_label: "View challenge",
    challenge_name: "Lucky Seven",
    game_type: "keno",
    challenge_type: "keno",
    prize_usd: "25.00",
  });
});

test("challenge preview selects all three dedicated customer designs", () => {
  for (const [game, challengeType, label] of [
    ["keno", "keno", "Keno"],
    ["upgrader", "upgrader", "Upgrader"],
    ["pack", "pack_pull", "Pack Pull"],
  ] as const) {
    const preview = previewNotificationText("challenge_available", {
      challenge_name: "New challenge",
      game_type: game,
      challenge_type: challengeType,
      prize_usd: "10",
    });
    assert.equal(preview.known, true);
    assert.equal(preview.challengeGame, game);
    assert.equal(preview.title, "New challenge is live");
    assert.equal(
      preview.body,
      `Complete this ${label} challenge to claim $10.00.`,
    );
  }
});

test("challenge announcement validation rejects incomplete and unsafe prizes", () => {
  assert.equal(
    validateAnnouncementPayload({ challengeName: "Missing game" }).ok,
    false,
  );
  assert.equal(
    validateAnnouncementPayload({
      challengeName: "Bad prize",
      challengeGame: "pack",
      challengePrizeUsd: "NaN",
    }).ok,
    false,
  );
});
