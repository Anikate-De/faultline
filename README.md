# Faultline

An interactive SRE and DevOps field lab. Break a realistic system, read the signals, and learn the fix and its tradeoff.

**Status:** foundation complete, Gate 2 approved, all 456 manifest rows authored: 396 modules across fifteen tracks plus 60 case files. 135 modules are reviewed; the rest and the public-case accuracy review remain. Case files are clearly labeled public or composite.

## TODO

- [ ] Fill in project overview, screenshots, and usage notes.
- [ ] Add contributor and deployment documentation.

Live site: https://anikate-de.github.io/faultline/

## Run

```bash
cd faultline
npm install
npm run dev
```

Production check:

```bash
npm run typecheck
npm run validate:manifest
npm run validate:content
npm run test
npm run build
npm run test:e2e
```

The app is static. There is no backend, auth, analytics, or runtime API. To host under a subpath such as `/faultline/`, build with `FAULTLINE_BASE=/faultline/ npm run build` and start preview with the same environment variable.

## Routes

`/`, `/tracks`, `/tracks/:trackId`, `/curriculum`, `/modules/:slug`, `/case-files`, `/case-files/:slug`, `/review`, `/glossary`, `/progress`, `/about`, `/_lab`, `*`.

`/_lab` is the hidden component and simulation gallery for authors and QA. `/curriculum` is the flat learning path: monotonic levels, prerequisites first, categories rotated, and case files highlighted as dark-purple milestones.

The production build is a PWA. After the first online load, `Progress → Offline` confirms the app shell, authored modules, fonts, and simulation code are cached for use without a connection.

## Modules

The Gate 2 demo is `/modules/hot-key-sharding`. The library now covers all 396 non-case manifest rows across Foundations, Observability, Caching, Traffic, Reliability, Databases, Streaming, Cloud Networking, Deployment, Containers, MongoDB, Mesh, Capacity, and Compliance. Every authored module has a deterministic model, presets, an incident state, a guided experiment, hidden interview answers, and model tests. Trace modules use a span waterfall; exemplars use a clickable latency histogram.

## Project map

```
docs/                 product, curriculum, manifest, contracts, decisions, gate packet
scripts/              manifest/content validation, search index, crawl, screenshots
src/app/              app shell and routing
src/components/       UI primitives, layout, content, interview
src/content/          tracks, glossary, drills, manifest reader
src/design/           tokens and typography
src/generated/        manifest JSON and search index (generated)
src/modules/          authored module folders; import.meta.glob discovery
src/routes/           page routes
src/simulation/       deterministic engine, standard kit, visuals
tests/                unit and component tests
e2e/                  Playwright checks
```

## Gates

- Gate 0: setup complete.
- Gate 1: full manifest complete, reviewed, validated, frozen at 456 modules.
- Gate 2: demo awaiting explicit approval. No module-authoring agents have been spawned.
- Gate 3: blocked until approval.

See `docs/BUILD_LEDGER.md` and `docs/GATE2_PACKET.md`.
