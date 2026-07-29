import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const reviewRoot = "src/app/(antifraud)/antifraud/reviews";

test("Account Review exposes status workflow without severity controls", async () => {
  const [queue, detail, workspace, controls, dialog, actions, reads] =
    await Promise.all([
      readFile(`${reviewRoot}/page.tsx`, "utf8"),
      readFile(`${reviewRoot}/[id]/page.tsx`, "utf8"),
      readFile(`${reviewRoot}/_components/review-case-workspace.tsx`, "utf8"),
      readFile(`${reviewRoot}/_components/case-controls.tsx`, "utf8"),
      readFile(`${reviewRoot}/_components/open-case-dialog.tsx`, "utf8"),
      readFile(`${reviewRoot}/actions.ts`, "utf8"),
      readFile("src/lib/antifraud/reviews.ts", "utf8"),
    ]);

  for (const surface of [queue, detail, workspace, controls, dialog]) {
    assert.doesNotMatch(surface, /ReviewSeverityBadge|REVIEW_SEVER|severity/i);
  }

  assert.doesNotMatch(actions, /updateReviewSeverity|severitySchema/);
  assert.match(actions, /severity:\s*"medium"/);
  assert.doesNotMatch(reads, /filters\.severity|criticalOpen|critical_open/);

  assert.doesNotMatch(queue, /Assigned to me|params\.mine|assignedTo:/);
  const hero = queue.slice(
    queue.indexOf("<PageHero>"),
    queue.indexOf("</PageHero>"),
  );
  const filterBar = queue.slice(queue.indexOf("function FilterBar"));
  assert.doesNotMatch(hero, /OpenCaseDialog/);
  assert.match(filterBar, /<OpenCaseDialog \{\.\.\.openCaseProps\} \/>/);
  assert.match(queue, />\s*Review\s*<\/HostLink>/);
  assert.match(queue, /aria-label={`Review \$\{/);
  assert.match(queue, /review:\s*review\.id/);
  assert.match(queue, /<ReviewCaseDialog/);
  assert.match(workspace, /aria-label="Review progress"/);
  assert.doesNotMatch(queue, /<QuickReviewActions/);
  assert.match(detail, /redirect\(`\/antifraud\/reviews\?review=/);
});
