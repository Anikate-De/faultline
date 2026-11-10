import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "foundations-queueing-knee",
  slug: "queueing-knee",
  title: "The Queueing Knee: Why 70% Is the New 100%",
  track: "foundations",
  order: 3,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["foundations-littles-law"],
  tags: ["utilization", "queueing delay", "service time", "variability", "knee"],
  productionQuestion:
    "CPU is at 75% and p99 doubled; is the system healthy?",
  learningDelta:
    "Queueing latency is nonlinear; near saturation, small load increases create large latency increases",
  objectives: [
    "Explain why queueing delay grows faster than utilization near the knee.",
    "Predict when a small load increase will breach a latency SLO.",
    "Separate utilization headroom from variability headroom.",
    "Choose a mitigation that addresses load, service time, or arrival burstiness.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
