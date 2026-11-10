# Faultline — Decisions

Append-only. Newest decisions at the bottom.

## D-001 — Stack versions

Vite 8, React 19, TypeScript 5.9 (strict), React Router 7, Tailwind CSS 4 with CSS-variable tokens and the Vite plugin, Zustand 5, Motion 14, lucide-react, Vitest 5, Playwright. TypeScript 5.9 is pinned for tooling compatibility even though newer versions exist. npm with committed lockfile.

## D-002 — Tailwind 4 setup

Tokens are defined as CSS variables in `src/design/tokens.css` and exposed to Tailwind through `@theme inline` in `src/design/index.css`. Components use semantic utilities (`bg-surface`, `text-muted`, `border-border`) and never hard-code palette values.

## D-003 — Fonts

Self-hosted `@fontsource-variable/inter` and `@fontsource-variable/jetbrains-mono`, imported from `main.tsx`. If the packages fail, the CSS falls back to system UI and monospace.

## D-004 — Module discovery

`import.meta.glob` discovers module metadata eagerly (small) and module content lazily (code-split). No hand-maintained central import registry. The manifest JSON is generated from `docs/MODULE_MANIFEST.md` by `scripts/validate-manifest.ts`.

## D-005 — Manifest authoring

`docs/MODULE_MANIFEST.md` is the single source of truth. It is authored by the orchestrator, parsed by scripts, and frozen after the coverage and dedupe review. `src/generated/module-manifest.json` is generated, never hand-edited. Only authored modules appear in the runtime registry; planned rows appear on track pages as unavailable with an honest “in authoring” state.

## D-006 — Kubernetes

Reserved track only. No modules, no stubs, no lessons. The track page explains that Kubernetes will be learned from a clean baseline later.

## D-007 — Answer hiding

Interview and experiment answers are hidden in the component tree, not merely visually collapsed. No answer text is passed to headings, alt text, URL state, or closed accordions as visible content. Reveals are explicit buttons with `aria-expanded`.

## D-008 — Illustrative numbers

Simulation parameters use illustrative values unless an official documented limit is cited. The UI labels simulations as illustrative. Case files label illustrative telemetry and composites.

## D-009 — Gate discipline

No subagents before Gate 1. No module-authoring agents before Gate 2 approval. Foundation agents may be used after Gate 1 for disjoint work. Silent user presence is not approval.

## D-010 — Gate 2 demo scope

The demo is `caching-hot-key-sharding`, a real manifest module. It ships with six parameters, seven presets, three views (`shards` primary, `flow` and `heatmap` alternates), one guided experiment, four interview questions, a causal panel, and focus mode. The model capacity (12k ops/s per shard) and p99 curve are illustrative teaching values, labeled in the UI.

## D-011 — Experiment execution

Guided experiments start live for the configured simulated duration and offer an explicit “Skip to result.” Deterministic tests and the repair path use synchronous fast-forward. The model never reads wall-clock time; only the presentation timer does.

## D-012 — Alternate visuals

`SimSpec.alternateVisuals` allows one model to be inspected through more than one standard visual. The demo uses this to show the same hot-key frame as shards, request flow, and a time heatmap without duplicating the model.

## D-013 — Case-file plan

The frozen manifest has 60 case files: 17 public-incident candidates with named postmortem sources, and 43 clearly labeled composites. No case file is authored at Gate 2. Real incidents will be verified against public postmortems before authoring; composites must stay labeled. This is below the target of 60 verified real incidents and is recorded as a known gap for the case-file phase.

## D-014 — Performance baseline

Production build: initial route JS 83.9KB gzip (budget 250KB), demo module chunk 10.3KB gzip (budget 120KB), CSS 12.0KB gzip. The 456-row manifest is a lazy 70KB gzip chunk. The PWA precache is 60 entries / 1.2MB. Simulation React updates run at 10Hz; canvas particles animate independently; off-screen and hidden-tab pauses are implemented. LCP measured 2.45s and CLS 0.0 on a 390px viewport with 1.6Mbps/150ms and 4× CPU throttling.

## D-015 — Manifest authoring format

The manifest is authored as a Markdown table per track and parsed by `scripts/validate-manifest.ts`. The generated JSON is the runtime metadata. A source format was not introduced; the Markdown remains the single human source of truth.

## D-016 — Component library for switch and search

Interview mode uses `@radix-ui/react-switch`. Search uses `@radix-ui/react-dialog` plus `cmdk`. These are headless primitives, so the visual language and keyboard behavior stay in Faultline rather than importing a competing theme. The previous hand-built switch and search overlay were replaced because they were visually broken and duplicated focus/keyboard handling.

## D-017 — Flat all-modules path

`/curriculum` is the learner-facing flat sequence. It computes an effective level as the maximum of a module's own difficulty and its prerequisites' effective levels, groups by that level, topologically orders core modules within a level, rotates track categories for variety, and inserts case files at slots after their prerequisites are satisfied. It is deterministic and covered by `tests/learning-path.test.ts`. Levels are monotonic; case files are dark-purple milestones.

## D-018 — Undo completion

Completion is reversible in the module header and in Progress. Undoing completion removes the completion timestamp but leaves confidence and the review schedule intact, because they are separate learning signals.

## D-019 — Offline PWA

The production build registers a Workbox service worker that precaches the app shell, authored module chunks, fonts, and the lazy manifest. `Progress → Offline` shows cache state, a storage estimate, and a manual refresh. Progress remains in localStorage, so it is available offline without a server account. Planned modules and case files are not downloadable until they are authored.


## D-020 — Gate 2 approved

On 2026-11-10 the user approved the revised foundation and demo and authorized module-authoring waves. The approval covers Radix/cmdk controls, the flat `/curriculum` milestone path, undo completion, offline PWA, the design system, and the demo module. The manifest remains frozen. Wave 3 starts with the remaining standard exemplars; the case-file exemplar is deferred until the case-file renderer and accuracy-review flow are built.


## D-021 — Wave 3 integration

All ten Wave 3 exemplars are authored. The manifest rows were updated from `planned` to `authored` for the ten IDs. Content validation covers 11 authored modules (including the demo), the full test suite reports 147 passing tests, and the route crawl covers 22 routes with zero failures. Two read-only reviewers are auditing correctness, answer hiding, mobile layout, accessibility, and sourcing. Wave 4 waits for their findings and fixes.


## D-022 — Wave 3 review fixes

Reviewer findings changed shared behavior: experiment runs now scroll the simulator into view and stop from the simulated frame time rather than wall-clock time; the causal panel is collapsed by default; node health can produce a warning/critical banner even when no metric threshold is active; event logs are keyboard-scrollable; particle canvases stop when paused or off-screen; diagrams show a mobile scroll affordance. Module-specific fixes landed for route-table fix capacity, capacity freeze semantics, RPO node health, persistent metric trends, and cache-stampede warm-start behavior. P2 deferred: a generic decision-point block and a debrief reveal gate.


## D-023 — Wave 4 launch

Wave 4 targets the full Foundations track. Five authors are assigned 26 modules across queueing/measurement, reliability budgets, resilience controls, Linux saturation, and protocol capacity. Author F's six flow-control modules are queued until an agent slot frees, keeping the six-agent concurrency cap. Wave 3 is committed as `bbed52c`.


## D-024 — Wave 3 review corrections

Both reviewers are complete. P1 fixes: cache stampede is now explicitly a per-instance local cache with invariant total work and a jittered experiment setup; ALB uses a labeled illustrative connection ceiling and rejected-connection metric instead of a fictional AWS quota/5xx; MongoDB uses a real sync-source control; interview-mode Observe output is gated behind the explicit reveal. Shared fixes: node-health incident banner, collapsed causal panel, persistent model summaries, keyboard-scrollable event log, paused/off-screen particle canvas, diagram scroll affordance, preset highlight clearing, and radio-group keyboard behavior. P2 carried: generic decision-point blocks are still absent, and the manifest uses some planned counts that differ from authored implementations.


## D-025 — Wave 4 Foundations complete

All 32 Foundations modules are authored. The total is 43 authored modules including the demo and ten Wave 3 exemplars. The content validator passes all 43, 451 tests pass, the route crawl covers 54 routes, and Axe is clean across all 43 module pages. Wave 4 reviewers are still auditing before the final commit; the phone build is being refreshed so the authored set is browsable.


## D-026 — Wave 4 review corrections and freeze

Both Wave 4 reviewers completed. P1 fixes: queueing-knee now has a monotonic latency curve; retry-backoff-jitter no longer injects an outage in Healthy; capacity-headroom Recovery no longer keeps a failed AZ; connection-pools uses a continuous pool-wait curve and a flowing visual; file descriptors and conntrack cannot exceed their hard limits; password hashing normalizes attacker guesses against the real hash time and treats a short salt as per-user; linux CPU no longer double-counts steal; linux network separates link overflow from NIC drain drops. P2 fixes include event flags, negative-margin metrics, half-open probes, load-shedding hysteresis, per-hop timeouts, mobile slider wrapping, tag alignment, and model summaries. All 43 authored modules are marked `reviewed` in the manifest. P2 deferred: generic module decision blocks and the case-file renderer.


## D-027 — Wave 5 launch

Wave 5 targets the 33 remaining Observability modules. Six authors have disjoint IDs: metric semantics and PromQL, Datadog/VictoriaMetrics/cost, logs and tracing, OpenTelemetry sampling plus browser and profiling, alerting and incident reconstruction, and telemetry-pipeline resilience. The frozen manifest remains the source of truth for IDs, slugs, prerequisites, titles, and learning deltas. Known Wave 4 review failures are called out in each assignment: Healthy must load at `data-incident="ok"`, event flags must persist, queue visuals must have real queue metrics, and metrics must not contradict node or experiment values.


## D-028 — Wave 5 review corrections and freeze

All 33 Observability modules are reviewed. Both wave reviewers and a third model-integrity reviewer found P1s; every P1 was fixed before commit. Corrections include: metric values that contradicted their own labels (fragmentation, APM retention, trace retention cost, disk/CPU caps), experiment setups that did not apply the change being tested, stale incident banners, non-chronological incident replay, buffer-shrink loss, reset ignoring parameters, and mobile stepper/label overflow. The simulation kit gained a reusable trace waterfall and a clickable latency-histogram visual with a 44px exemplar target. The shared reset now applies the current parameters at t=0, particle canvases size from the client box, count metrics format with separators, and the incident live region no longer re-announces the clock every tick. P2 carried: generic decision blocks remain absent; two modules represent multi-decision intent with multiple experiments.


## D-029 — Wave 6 launch

Wave 6 completes the Caching track: all 26 remaining rows are assigned to five authors in disjoint directories. The prerequisite set is already reviewed (Foundations, the hot-key demo, and cache-stampede), so the track can progress without waiting on another track. Authors are grouped by Redis fundamentals, hot-key/sharding, expiry and write strategy, coherence and missing keys, and command/connection cost. Case files remain deferred.


## D-030 — Parallel Wave 7 start

To increase throughput without overlapping files, Wave 7 Traffic is split into six disjoint author groups and started in parallel with Wave 6. All six groups begin now; each owns a disjoint directory. Every Traffic row still uses the frozen manifest, the same authoring contract, and no shared-file edits. Completion and review remain per wave so Caching and Traffic can be committed independently.


## D-031 — Open every remaining track

Every remaining non-case track now has an active opener group: reliability, databases, streaming, cloud networking, deployment, containers, MongoDB, mesh, capacity, and compliance. Each group owns five early manifest rows in a disjoint directory. Later rows in each track are queued as Wave 9+ batches and refill as authors finish. This keeps every track moving without assigning an entire 20–32 module track to one agent. Case files remain deferred until the renderer and accuracy-review flow exist.


## D-032 — All non-case modules authored

All 396 non-case manifest rows now have a module. The production-preview gate passes: 396 content-valid, 4,371 tests, 24 Playwright tests including all 396 modules at 390px, 407-route crawl, typecheck, lint, and Axe clean on all 396. Search index is 396 entries; PWA precache is 455 entries / 11.9MB. Caching and Traffic are fully reviewed and fixed. The remaining 261 modules are authored but still require final read-only review; 135 are marked reviewed. Case files remain the only unauthored set and stay blocked on the renderer plus accuracy-review flow.


## D-033 — All 456 rows authored

The full manifest is authored: 396 non-case modules plus 60 case files. The case-file platform adds a typed `caseStudy`, a lazy registry, a renderer for timelines/decisions/postmortems/sources, validator rules, and public/composite accuracy labels. All 60 cases pass content validation; composites are explicitly labeled as non-real scenarios, and public incidents carry source-verification notes. The production gate passes 4,377 unit/component tests, 28 Playwright tests, 407-route crawl, Axe across all 456 routes, typecheck, lint, and build. 135 modules remain marked reviewed; the rest and the public case files still need final read-only/accuracy review. Case files can now be committed and deployed without presenting planned content as complete.
