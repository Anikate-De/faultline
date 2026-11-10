import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "deployment-canary-capacity",
  slug: "canary-capacity",
  title: "Canary Capacity Fallacy",
  track: "deployment",
  order: 23,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["deployment-canary-metric-gate"],
  tags: ["canary", "capacity", "scale", "load", "gate"],
  productionQuestion:
    "A canary passes at 5% traffic and the service fails at 100%. Why?",
  learningDelta:
    "A canary at low traffic does not exercise capacity, caches, locks, or downstream limits at full scale",
  objectives: [
    "Explain why error rate and latency at a small traffic share can miss a capacity failure.",
    "Project full-scale resource demand from per-request behavior.",
    "Choose a load test or traffic step that exercises the resource that will break.",
    "Design a gate that fails before full rollout saturates a shared limit.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
