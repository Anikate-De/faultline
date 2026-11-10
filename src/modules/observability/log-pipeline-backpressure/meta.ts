import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "observability-log-pipeline-backpressure",
  slug: "log-pipeline-backpressure",
  title: "Log Pipeline Backpressure",
  track: "observability",
  order: 31,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["foundations-backpressure"],
  tags: ["backpressure", "agent buffer", "drop policy", "priority", "disk buffer"],
  productionQuestion:
    "The log agent queue is full during a traffic spike and logs are dropped. How do you protect the pipeline?",
  learningDelta:
    "Agents need bounded buffers and prioritization; dropping debug logs is better than blocking application threads or losing errors",
  objectives: [
    "Separate a local agent buffer problem from a downstream egress problem.",
    "Choose a drop policy that preserves errors and explicitly accepts losing debug and info logs.",
    "Explain why a disk buffer delays loss and raises log age instead of adding capacity.",
    "Design a bounded pipeline whose failure is visible in drop and age metrics before application latency moves.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
