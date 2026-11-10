import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "deployment-canary-metric-gate",
  slug: "canary-metric-gate",
  title: "Canary with a Metric Gate",
  track: "deployment",
  order: 5,
  difficulty: 4,
  minutes: 20,
  prerequisites: ["deployment-canary"],
  tags: ["canary", "metric gate", "capacity", "sample size", "rollback", "SLO"],
  productionQuestion:
    "The canary passes error rate but fails at full rollout because of capacity. What gate was missing?",
  learningDelta:
    "A canary gate must cover error rate, latency, saturation, and capacity at the target scale, with enough traffic for confidence",
  objectives: [
    "Separate error-rate gates from latency, saturation, and capacity gates.",
    "Explain why a canary at low traffic can pass while full rollout saturates a shared dependency.",
    "Choose a canary share and gate window that produce enough samples for the decision.",
    "Design a promotion sequence with a rollback path when a gate fails.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
