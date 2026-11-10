import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "foundations-bulkheads",
  slug: "bulkheads",
  title: "Bulkheads: Isolate the Blast Radius",
  track: "foundations",
  order: 12,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["foundations-queueing-knee"],
  tags: ["bulkhead", "pool isolation", "tenant fairness", "concurrency limit", "noisy neighbor"],
  productionQuestion:
    "One tenant's batch job is starving interactive traffic; how do you isolate it?",
  learningDelta:
    "Pools, queues, and concurrency limits per workload contain saturation to one bulkhead",
  objectives: [
    "Explain how a shared worker pool turns one workload's backlog into another workload's latency.",
    "Compare shared and isolated pools by interactive SLO and aggregate utilization.",
    "Choose a reservation size and defend the idle capacity it creates.",
    "Recognize when isolation moves the bottleneck instead of removing it.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
