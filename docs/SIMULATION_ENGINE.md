# Faultline — Simulation Engine

## Contract

A model is pure at the boundary:

```ts
interface SimModel {
  id: string;
  visual: "flow" | "shards" | "queue" | "replication" | "deployment" | "topology" | "heatmap" | "timeline" | "custom";
  params: ParamSpec[];
  init(ctx: { seed: number }): SimFrame;
  step(frame: SimFrame, params: Params, dt: number, rng: Rng): SimFrame;
  thresholds: ThresholdSpec[];
  insights(frame: SimFrame, params: Params): string[];
  legend?: LegendItem[];
}
```

`SimFrame` carries nodes, edges, metrics, events, capped series, flags, and a text summary. Models never call `Math.random()` or `Date.now()`. Randomness comes from the injected seeded RNG. Time is simulated seconds.

## Engine behavior

- Fixed 100ms timestep; React frame updates at 10Hz; canvas visuals animate with `requestAnimationFrame`.
- Speed 0.5×, 1×, 2×, 4×; play, pause, step, reset, preset.
- Pause when hidden or off-screen.
- Clamp `dt`, utilization, and all metric values. No `NaN`, `Infinity`, or negative utilization reaches the UI.
- Series are ring buffers capped at 120 points.
- Events are deduplicated by id within a short window; the first critical event is kept.
- `runFor(seconds)` steps synchronously with a tick cap; live experiments animate and can skip to result.
- Threshold crossings create events and drive the incident banner, causal panel, and “what to check first” list.

## Presets

Every simulation provides `healthy`, `peak`, `failure`, and `recovery`; optional `quota-raised`, `sharded`, `cold-cache`, `failover`, `rollback`.

## Visuals

- `flow`: request path with animated particles, node health.
- `shards`: shard cards with CPU, memory, hot-key badge, heat grid.
- `heatmap`: time × bucket heat.
- `queue`: producer → queue → consumers, depth, retries, DLQ.
- `replication`: primary/replica lag and failover.
- `deployment`: instance chips through rollout stages.
- `topology`: VPC/subnet/route path.
- `timeline`: incident replay with scrubber.

All visuals reflow vertically under 640px, report a text summary, open node detail in a bottom sheet, respect reduced motion, and cap particles at 150 mobile / 300 desktop.

## Performance

Lazy-load sims per module. Do not run off-screen sims. Cap canvas DPR at 2. Update React at 10Hz, not 60Hz. Keep module chunks under 120KB gzip.

## Tests

Every module test verifies determinism, finite values, failure crossing critical within 60 simulated seconds, recovery within 60 simulated seconds, event dedupe, and `runFor` equivalence. Shared engine tests cover pause/reset/speed, hidden-tab pause, series buffers, threshold transitions, and clamping.
