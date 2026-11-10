import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "foundations-circuit-breaking",
  slug: "foundations-circuit-breaking",
  title: "Circuit Breaking: Fail Fast, Recover Slowly",
  track: "foundations",
  order: 11,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["foundations-retry-backoff-jitter"],
  tags: ["closed", "open", "half-open", "failure threshold", "probe traffic"],
  productionQuestion:
    "The dependency is timing out; how do you stop making it worse without manual intervention?",
  learningDelta:
    "A breaker converts repeated failures into fast local failures and probes recovery with limited traffic",
  objectives: [
    "Trace the closed, open, and half-open states and the signal that moves between them.",
    "Choose a failure threshold and reset timeout that protect the caller without hiding a real outage.",
    "Explain why an open breaker restores latency and caller capacity but not correctness.",
    "Defend the probe budget and the fallback that remains necessary beside the breaker.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
