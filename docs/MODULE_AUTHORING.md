# Faultline — Module Authoring

## Files

```
src/modules/<track>/<slug>/
  meta.ts        # pure ModuleMeta, no React
  module.ts      # blocks, sim specs, experiments, interview, checklist, references
  Sim.tsx        # only when visual === "custom"
  module.test.ts # deterministic model tests
  index.ts       # exports meta and module
```

Only assigned IDs from `docs/MODULE_MANIFEST.md`. Never create a module that is not in the manifest. Never edit shared files, dependencies, or other modules.

## Required shape

- `meta.ts` matches the manifest row: id, slug, track, order, difficulty, minutes, prerequisites, tags, production question, learning delta, 2–5 objectives, interview count, sim flag, status, lastReviewed.
- `primer` must contain H2 “What it is,” “Where it sits,” “What you’ll see,” a diagram/table/compare/analogy, and a callout explaining how to use the demo.
- `debrief` must contain “What just happened,” “What you’d see in production,” “How to fix it,” “Tradeoffs.”
- At least one simulation with 3–6 parameters, 4 presets including failure and recovery, 2+ thresholds with cause and fix, and causal insights.
- At least one experiment with a prediction, hidden explanation, fix, and debrief.
- 3–5 interview questions with hints, hidden answer, follow-ups, red flags, rubric.
- Production checklist and 2+ real references.
- 700–1,800 words (standard), 1,200–2,500 (case files).

## Rules

- Explain before interact. The learner must understand the system before touching sliders.
- Failure is obvious when paused: banner, state label, icon, threshold line, event, causal chain.
- Answers hidden by default. No leaks in headings, summaries, URLs, alt text, or pre-opened accordions.
- One unique learning delta. State the new failure mode, signal, or tradeoff versus prerequisites.
- Deterministic models. No `Math.random()` or `Date.now()`. Use injected RNG and simulated time.
- Every module includes a “what to check first” list and a tradeoff.
- No placeholder text, invented numbers, or fabricated references. Label illustrative telemetry.
- Mobile at 360px: no horizontal overflow, 44px controls, readable charts, focus mode works.
- Real AWS/service names and behavior. Explain acronyms on first use.
- No emojis in lesson content, no exclamation marks, no hype.

## Run

```
npm run typecheck
npm run validate:content
npm run test -- src/modules/<track>/<slug>
```
