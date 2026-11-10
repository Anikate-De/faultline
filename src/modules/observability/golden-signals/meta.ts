import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "observability-golden-signals",
  slug: "golden-signals",
  title: "Golden Signals: Latency, Traffic, Errors, Saturation",
  track: "observability",
  order: 1,
  difficulty: 1,
  minutes: 14,
  prerequisites: ["foundations-use-red"],
  tags: ["latency", "traffic", "errors", "saturation", "RED", "USE"],
  productionQuestion:
    "CPU is normal, the dashboard is green, and users are complaining. Which signal did you not graph?",
  learningDelta:
    "The four golden signals answer different questions; saturation can hide while latency, errors, or traffic already show the incident",
  objectives: [
    "Read latency, traffic, errors, and saturation as four different questions.",
    "Explain why a healthy CPU graph can coexist with a failing request path.",
    "Separate failed-request latency from successful-request latency.",
    "Choose the first signal to graph for a service incident and defend the coverage gap.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
