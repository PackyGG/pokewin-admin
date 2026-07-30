---
name: proactive-learning-agents
description: User permits spawning new agents/workflows freely to learn the codebase deeper
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 93a61a9c-5964-4a78-a705-eebd165d1e98
---

The user explicitly allows me to proactively start new sessions / spawn agents / use Workflows to learn the codebase more deeply and better — I don't need to ask first for learning/exploration. Reaffirmed 2026-06-21: "u always allowed to use workflows and multi agents, i even prefer to use that" — standing, blanket permission for ALL work (analysis, research, external-site competitive analysis, implementation), not just codebase learning. Workflows/multi-agent fan-out is the user's PREFERRED default, never something to ask about.

**Why:** The user wants the best, most thorough, verified result over the fastest shallow one. This aligns with the repo's CLAUDE.md rule that exploration/planning/implementation should fan out across parallel agents and workflows by default.

**How to apply:** For any non-trivial request (learn/understand/explore, analyze, research, build), default to a Workflow or parallel agents (fan-out → adversarial verify → synthesize), then report. No need to ask permission. Note: Workflow `args` may not reach the script in this harness — inline the dataset into the script (Write/Edit the persisted script file, re-invoke with `scriptPath`) instead of relying on `args`. Workflow agents can drive a single shared browser only sequentially, so harvest browser data inline first, then fan out the analysis. See [[backend-index-or-clickhouse]] for the kind of subsystem knowledge worth building this way.
