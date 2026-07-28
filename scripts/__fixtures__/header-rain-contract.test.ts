import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function read(relative: string): string {
  return readFileSync(path.join(root, relative), "utf8");
}

const shellLayouts = [
  "src/app/(admin)/layout.tsx",
  "src/app/(creator-hub)/creator-hub/layout.tsx",
  "src/app/(pack-studio)/pack-studio/layout.tsx",
  "src/app/(antifraud)/antifraud/layout.tsx",
];

test("every dashboard shell mounts the streamed rain card", () => {
  for (const layoutPath of shellLayouts) {
    const source = read(layoutPath);
    assert.match(source, /import \{ HeaderRainSlot \}/, layoutPath);
    assert.match(source, /rainSlot=\{<HeaderRainSlot \/>\}/, layoutPath);
  }
});

test("the rain card matches the profile form and exposes entries plus timer", () => {
  const source = read("src/components/header-rain-chip.tsx");

  assert.match(source, /h-10 items-center/);
  assert.match(source, /rounded-lg border border-border\/60 bg-muted\/40/);
  assert.match(source, /participantCount === 1 \? "entry" : "entries"/);
  assert.match(source, /Ends in\{" "\}/);
  assert.match(source, /<RainCountdown/);
  assert.match(source, /<Suspense fallback=\{null\}>/);
});
