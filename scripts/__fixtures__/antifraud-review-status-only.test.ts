import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const reviewRoot = "src/app/(antifraud)/antifraud/reviews";

test("Account Review exposes the simplified high-risk workflow", async () => {
  const [queue, detail, workspace, actions, reads, ingest] =
    await Promise.all([
      readFile(`${reviewRoot}/page.tsx`, "utf8"),
      readFile(`${reviewRoot}/[id]/page.tsx`, "utf8"),
      readFile(`${reviewRoot}/_components/review-case-workspace.tsx`, "utf8"),
      readFile(`${reviewRoot}/actions.ts`, "utf8"),
      readFile("src/lib/antifraud/reviews.ts", "utf8"),
      readFile("src/app/api/antifraud/ingest/route.ts", "utf8"),
    ]);

  assert.doesNotMatch(actions, /updateReviewSeverity|severitySchema/);
  assert.match(actions, /severity:\s*"medium"/);
  assert.match(actions, /export async function startReview/);
  assert.match(actions, /assigned_to:\s*session\.userId/);
  assert.match(reads, /filters\.severities/);
  assert.match(reads, /isUsefulReviewSignalTrailEntry\(note\.body\)/);
  assert.match(ingest, /isUsefulReviewSignalTrailEntry\(trailEntry\)/);
  assert.match(ingest, /const MAX_EVENT_AGE_MS = 60 \* 60 \* 1000/);
  assert.match(ingest, /occurredAt >= oldestAcceptedAt/);
  assert.match(ingest, /accepted, duplicates, stale, reviewsOpened/);

  assert.doesNotMatch(queue, /Assigned to me|params\.mine|assignedTo:/);
  const hero = queue.slice(
    queue.indexOf("<PageHero>"),
    queue.indexOf("</PageHero>"),
  );
  const filterBar = queue.slice(queue.indexOf("function FilterBar"));
  assert.doesNotMatch(hero, /OpenCaseDialog/);
  assert.match(filterBar, /<OpenCaseDialog \{\.\.\.openCaseProps\} \/>/);
  assert.match(queue, /<StartReviewButton/);
  assert.match(queue, /review\.assignee\.label/);
  assert.match(queue, /formatDateTime\(review\.automatedActionAt\)/);
  assert.match(queue, /Containment pending/);
  assert.match(queue, /Automatically contained at/);
  assert.match(queue, /review:\s*review\.id/);
  assert.match(queue, /<ReviewCaseDialog/);
  assert.doesNotMatch(workspace, /aria-label="Review progress"/);
  assert.doesNotMatch(queue, /<QuickReviewActions/);
  assert.match(workspace, /Signed up/);
  assert.doesNotMatch(workspace, /label: "Source"/);
  assert.doesNotMatch(workspace, /label: "Resolved"/);
  assert.doesNotMatch(workspace, /label: "Last updated"/);
  assert.doesNotMatch(workspace, /signals? with no\s+score impact/);
  assert.doesNotMatch(workspace, /bookkeeping and routine play/);
  assert.doesNotMatch(workspace, /contextGroups|const grouped = new Map/);
  assert.match(detail, /redirect\(`\/antifraud\/reviews\?review=/);
});
