# Faultline — Gate 2 Approval Packet

## What was built

- Vite + React + TypeScript strict, React Router lazy routes, Tailwind 4 with CSS-variable tokens, Zustand, Motion, lucide-react.
- App shell with desktop sidebar, mobile bottom tabs, top bar, search palette, interview mode, theme toggle, skip link, reading progress.
- Typed block renderer with escaped inline markdown, diagrams, tables, comparisons, callouts, code, glossaries, timelines, checklists, references.
- Deterministic simulation engine with seeded RNG, fixed 100ms timestep, threshold reconciliation, event dedupe, series ring buffers, clamping, off-screen pause, hidden-tab pause, reset, step, speed, and fast-forward.
- Simulation kit: incident banner, metric strip, sparklines, heatmap, gauge, area chart, parameter sliders with number inputs and steppers, presets, event feed, causal panel, summary, focus mode, node detail sheet.
- Standard visuals: flow, shards, queue, replication, deployment, topology, heatmap, timeline.
- Store: progress, bookmarks, confidence, spaced review, theme, interview mode, export/import/reset, undo completion.
- Radix Switch for interview mode; Radix Dialog + cmdk for the search palette.
- Flat `/curriculum` path with monotonic effective levels, prerequisite ordering, rotating categories, and purple case-file milestones.
- PWA service worker with full authored-content precache and an Offline panel in Progress.
- Content validator, manifest validator, search index builder, route crawl, screenshot script.
- Unit, component, and Playwright tests.
- Hidden `/_lab` gallery.
- Demo module: `/modules/hot-key-sharding`.

## How to run

```bash
cd faultline
npm install
npm run dev
```

Then open the printed URL. For production: `npm run build && npm run preview`.

Validation:

```bash
npm run typecheck
npm run validate:manifest
npm run validate:content
npm run test
npm run build
npm run test:e2e
npm run crawl
```

## Screenshots

Stored in `artifacts/screenshots/`:

- `module-390-healthy.png` — full mobile healthy state.
- `module-390-failure.png` — mobile incident state.
- `module-390-focus.png` — mobile focus mode.
- `module-390-light.png` — mobile light theme.
- `home-390-toggle.png` — Radix interview-mode switch.
- `search-390-new.png`, `search-390-results.png` — cmdk search palette.
- `curriculum-390.png`, `curriculum-top-390.png`, `curriculum-milestone-390.png` — flat learning path and case-file milestones.
- `offline-390.png` — offline reload of the demo.
- `module-1440-healthy.png` — desktop two-column layout.
- `module-1440-failure.png` — desktop incident state.
- `module-1440-focus.png` — desktop focus mode.
- `home-390.png`, `lab-360.png` — home and lab.

## Component usage

| Component | Where used | Why | Reused by |
|---|---|---|---|
| `SimShell` | module right panel and `/_lab` | Assembles toolbar, metrics, visual, presets, parameters, events, causal panel, focus mode | every standard module |
| `SimVisual` switch | module + lab | Standard flow/shards/queue/replication/deployment/topology/heatmap/timeline visuals | all tracks |
| `ParamSlider` / `ParamPanel` | demo + lab | 44px range, numeric entry, steppers, unit and help text | every sim module |
| `PresetBar` | demo + lab | Healthy/peak/failure/recovery and mitigation presets | every sim module |
| `IncidentBanner` | demo + lab + module | Severity, cause, affected metric, and “check first” | every sim module |
| `MetricStrip` / `MetricCard` | demo + lab | Threshold-aware metrics plus a full data table | every sim module |
| `EventFeed` | demo + lab | Timestamped, text-labeled telemetry events | every sim module |
| `CausalPanel` | demo + lab | Explains the chain and the fix path | every sim module |
| `FocusMode` | demo + lab | Full-screen phone/desktop simulation with focus trap | every sim module |
| `NodeCard` / `ShardCard` | flow/shards visuals | Tap targets with health, utilization, throughput | traffic, caching, databases, containers |
| `Heatmap` | shards visual + lab | Time × shard CPU; text alternative included | caching, databases, streaming, observability |
| `ExperimentCard` | demo + lab model | Prediction, live run, skip, observation, hidden explanation, fix re-run | every module with an experiment |
| `InterviewQuestion` / `RevealPanel` | demo + lab | Hints one at a time and hidden model answers | every module |
| `PredictionPicker` / `Quiz` | experiment + lab | Hidden keys and explicit reveal | every module |
| `ProgressRing`, `BookmarkButton`, `CompletionButton`, `ConfidencePicker` | demo, module pages, progress | Local learning state | every module |
| `SearchPalette` | app shell | Radix Dialog + cmdk, fuzzy search over authored modules, keyboard navigation | global |
| `InterviewModeToggle` | top bar | Radix Switch with visible state and label | global |
| `/curriculum` | navigation | Monotonic level path, prerequisite ordering, purple case-file milestones | global |
| `OfflinePanel` | Progress | PWA cache status, save/refresh, storage estimate | global |
| `TrackCard`, `ModuleCard`, `CaseFileCard` | home, tracks, lab | Manifest-driven navigation with honest planned state | global |
| `Dialog`, `Sheet`, `Tabs`, `Accordion` | lab and content | Accessible overlays and disclosures | global |

## Interaction checklist

1. Open `/modules/hot-key-sharding`.
2. Move **Total request rate**, **Hot key share**, **Redis shards**, **Local cache hit rate**, **Key salt fan-out**, and **Read replica offload**. Watch the metric strip and shard grid.
3. Apply **Hot key**. Confirm the critical banner, the red shard, the threshold lines, the event, and the causal panel.
4. Switch between **Shards**, **Flow**, and **Heatmap**.
5. Run the guided experiment: predict, run or skip, reveal the explanation, apply the fix.
6. Reveal an interview model answer. Confirm it was not in the DOM before the reveal.
7. Open **All modules** from the sidebar or the Tracks link. Confirm case files are purple milestones after their prerequisites and the level rises.
8. Use **Undo** next to a completed module; the badge disappears and Mark complete returns.
9. Open Progress → Offline while online. Confirm the cache is ready, then go offline and reload a module.
10. Toggle interview mode with the Radix switch and open search with ⌘K / Ctrl+K.
11. Open **Focus mode**, use play/pause/step/reset/speed, close with Escape.
12. Toggle light/dark and reload. Completion, confidence, bookmark, and theme persist.
13. Visit `/_lab` for every primitive and visual state.
14. Check 360px and 390px: no horizontal page scroll, controls at least 44px, bottom nav does not obscure content.

## Manifest summary

- Total: **456** modules (396 core + 60 case files).
- Tracks: 14 active + Kubernetes reserved (0 modules) + case files.
- Case files: 60 planned (17 public-incident candidates + 43 clearly labeled composites).
- Manifest: `docs/MODULE_MANIFEST.md`.
- Review: `docs/CURRICULUM_REVIEW.md` with the frozen attestation.
- Generated metadata: `src/generated/module-manifest.json`.
- Only the demo is authored; all other rows show “in authoring” and never render placeholder lessons.

## Design decisions

- Dark-first obsidian control-room palette; light is a complete theme.
- Per-shard and per-metric visual hierarchy; incident language uses icon, label, text, threshold, and live region.
- Desktop prose left and a sticky, internally scrollable simulator right; mobile stacks primer, simulator, experiments.
- Standard visuals and controls are reused; the demo’s custom model is data, not a custom page.
- Experiments run live and offer “Skip to result”; model tests use deterministic fast-forward.
- Answers are not rendered until the reveal action.
- No backend, no runtime API, no tracking.

## Known gaps

- 455 modules are planned, not authored. This is intentional at Gate 2.
- Case files are planned; no case-file content has been verified or authored yet.
- The manifest validator checks similarity and graph integrity, not editorial truth. Accuracy review starts with authoring.
- The initial JavaScript bundle is 83.9KB gzip; the module chunk is 10.3KB gzip; CSS is 12.0KB gzip. The 456-row manifest is a lazy 70KB gzip chunk loaded by browse/detail routes, not the initial route. The PWA precache is 60 entries / 1.2MB for the authored build.
- ESLint is clean; no blocked rule exceptions in authored content.
- LCP measured 2.45s and CLS 0.0 on a production build at 390px with 1.6Mbps/150ms latency and 4× CPU throttling. This is under the 2.5s budget on that profile. Offline reload of the demo was verified with Playwright after the service worker installed.
- `/` “Today’s drill” selects from a small authored drill set; the full set arrives with modules.
- Offline precache covers authored content only; planned modules and case files are not downloadable until authored.
- The flat path ordering is generated and tested, but case-file placement is based on manifest prerequisites, not editorial sequencing by a track architect.

## Explicit question

**Approve this foundation and demo to begin module-authoring waves?**
