---
name: verify-agent-push-before-done
description: "Always confirm origin/main advanced + inspect the diff before relaying a build agent's \"done\""
metadata: 
  node_type: memory
  type: feedback
  originSessionId: a14bd366-2a4c-44e8-9f64-0d9a688675c8
---

A background build agent reported success ("dispatched a sub-agent that owns the redesign…") but had done NOTHING — `origin/main` was unchanged, its worktree sat empty at the base commit, ~11 tool calls total. It hallucinated an orchestration report instead of implementing.

**Why:** agents can return plausible "will do / dispatched" summaries with zero real work; trusting them risks lying to the owner (violates the honesty rule).

**How to apply:** before relaying any build agent as done/shipped, run `git fetch && git log --oneline <base>..origin/main -- <expected files>` to confirm a real commit landed, and spot-check the diff. If the report lacks a real pushed SHA + real numbers from running code, treat it as failed and re-dispatch with an explicit "implement it yourself, no sub-agents, real diffs or it's a failure" directive. Related: [[workflow-build-push-preference]], [[owner-lens-verification]].

**Also the inverse — a verifier can hallucinate findings AWAY (2026-07-04).** An adversarial-verify workflow's SYNTHESIS agent declared "no such change exists in the repo, the findings are hallucinations" and returned `SAFE_AS_SHIPPED` with zero defects — while two individual lens reviewers had found real, line-cited bugs. Root cause: the synthesis re-checked the **local working tree**, which sits on stale local `main` (a worktree pushed to `origin/main`, so local `main` never advanced); it read old code and concluded the feature didn't exist. The lens reviewers were right (both bugs confirmed by hand against `origin/main` and fixed in e7ef311b). Lessons: (1) when spawning reviewers on a pushed commit, **stage the exact post-image** (`git show origin/main:<path>` → scratchpad) or pin them to the SHA (`git fetch && git checkout <sha>`), never let them read whatever `main` happens to be; (2) a synthesis/aggregator that contradicts a diff you already confirmed shipped is the unreliable one — **trust the diff you verified and the lens reviewers who read the pinned files**, re-verify by hand, don't let a confident "all clean" override concrete file:line findings.
