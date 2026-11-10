import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "capacity-queueing-headroom",
  slug: "queueing-headroom",
  title: "Queueing Headroom",
  track: "capacity",
  order: 18,
  difficulty: 3,
  minutes: 16,
  prerequisites: ["foundations-queueing-knee"],
  tags: ["utilization", "queueing", "headroom", "variability", "target"],
  productionQuestion:
    "The fleet runs at 85% CPU and p99 is unstable. What utilization target should you set?",
  learningDelta:
    "Latency rises nonlinearly near saturation; the safe target depends on variability and failure headroom, not a universal percentage",
  objectives: [
    "Relate a utilization target to the latency budget it leaves at the queue.",
    "Explain why the same 85% target is safe for calm traffic and unsafe for bursty traffic.",
    "Reserve headroom for a zone failure before choosing the target.",
    "Defend the cost of headroom against the cost of an SLO breach.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
