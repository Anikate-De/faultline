# Faultline — Agent Playbook

## Gates

0. Setup: scaffold, tooling, contracts.
1. Full module manifest written, reviewed, frozen, validated. No subagents before this.
2. Demo module built and explicitly approved by the user. No module-authoring agents before this.
3. Scale: exemplars, authoring waves, review, fixes.

## Roles

- Orchestrator: architecture, manifest, contracts, integration, quality, commits, approval packet.
- Foundation agents (after Gate 1): disjoint slices of engine/kit or foundation.
- Module authors (after Gate 2): 4–6 assigned modules each, disjoint directories.
- Case-file authors (after Gate 2): research-first, 3–4 files each.
- Reviewers and auditors: read-only, findings by severity.
- Fixers: only the assigned module directories.

## Ownership

Authors own only their module files. Shared primitives, router, tokens, engine, kit, docs, and dependencies are orchestrator-owned. If a primitive is missing, stop and report.

## Waves

- Wave 0: orchestrator skeleton and contracts.
- Wave 1: manifest and curriculum review; no agents.
- Wave 2: foundation, then demo; Gate 2 stop.
- Wave 3: remaining exemplars and one audit.
- Wave 4+: 4–6 authors × 4–6 modules; 2 reviewers; 2 fixers.
- Case files: 2 authors × 3–4 files; 1 accuracy reviewer.
- Final QA: 4 auditors, 2 fixers.

Before each wave, write exact assignments in `docs/BUILD_LEDGER.md` with module IDs. Never say “write modules about X.” No two agents share an ID. At most six concurrent agents.

## Review and rejection

Reject generic text, a simulation that ignores its sliders, failure shown only by color, visible answers, duplicated learning delta, mobile overflow, tiny controls, randomness or wall-clock time in models, fabricated references, missing “check first” or tradeoff, shared-file edits, new dependencies, or unmanifested modules.

## Failure handling

One retry with exact findings; then narrow scope or fix directly. More than 20% rejects in a wave means stop and repair the authoring contract or exemplars before continuing.
