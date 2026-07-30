---
name: owner-lens-verification
description: "STANDING RULE from owner feedback 2026-07-03: verify outputs with business judgment, not just invariants — the owner should never be the QA"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 20e264c8-a2b9-43fa-8a3c-cf4d4b32c6be
---

**Owner feedback (2026-07-03, after finding 5 defects himself in the Retune V2 rollout):** "your job was to find these patterns and fix them yk? i dont wanna repeat this over and over, costs time and money."

**Why:** every defect he found (58% price cut for cosmetic niceness, 52% mass on a mid card with the cheapest floor-pinned, five win cards crushed to 0.001%, cap-drop display change, wrong relaxation copy) PASSED all harnesses — the acceptance criteria were mathematical (tag exact, edge in band, no errors), and no verifier ever judged the plans as a business owner would. Constraint satisfaction ≠ shippable quality.

**How to apply (binding for this repo):**
1. Any change that produces owner-facing OUTPUTS (plans, prices, odds, suggestions, copy) gets an **owner-lens review stage**: an agent (or a fleet sweep) inspects a representative sample of REAL outputs and asks "would the owner ship this / would this screenshot anger him?" — price-move sanity, ladder shape (cheaper ⇒ more common on the loss side), no silent floor-pins/absorber extremes, risk-tier drift, copy correctness. Run it BEFORE declaring done, alongside the math harnesses.
2. Convert every judgment criterion that survives review into an **executable check** (the `plan-quality` harness in `packs/__checks__/`) so it gates future changes automatically.
3. When the owner reports ONE bad output, treat it as a CLASS: sweep the whole fleet for the pattern (and adjacent patterns) in the same pass — never fix only the reported instance.
4. Batch: prefer one exhaustive sweep + one build wave over N reactive fix cycles — his money pays per iteration.

Related: [[pack-studio-current-state]], [[workflow-build-push-preference]] (build fast still applies — this adds a judgment gate, not bureaucracy).
