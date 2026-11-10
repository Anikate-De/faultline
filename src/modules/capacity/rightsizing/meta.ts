import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "capacity-rightsizing",
  slug: "rightsizing",
  title: "Rightsizing",
  track: "capacity",
  order: 13,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["capacity-cost-per-request"],
  tags: ["rightsizing", "utilization", "memory", "burst", "SLO"],
  productionQuestion:
    "Half the fleet runs at 15% CPU and the bill is high. Why not downsize everything?",
  learningDelta:
    "Rightsizing uses utilization, memory, and burst behavior; averages hide peaks, and downsizing can break latency SLOs",
  objectives: [
    "Separate average utilization from the peak that sets latency.",
    "Identify when memory, not CPU, blocks a smaller instance size.",
    "Choose a rightsizing change that keeps p99 inside the SLO.",
    "Explain the cost and risk of sizing for the peak instead of the average.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
