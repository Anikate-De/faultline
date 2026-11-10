import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "foundations-capacity-headroom",
  slug: "capacity-headroom",
  title: "Capacity Headroom and N+1",
  track: "foundations",
  order: 7,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["foundations-queueing-knee"],
  tags: ["headroom", "N+1", "peak multiplier", "AZ failure", "failover capacity"],
  productionQuestion:
    "You are at 60% peak utilization with three AZs; what happens when one AZ is lost?",
  learningDelta:
    "N+1 headroom must cover the loss of the largest failure domain at peak, not at average",
  objectives: [
    "Calculate post-failure utilization from pre-failure utilization and zone count.",
    "Distinguish N+1 from N+2 and name when each is justified.",
    "Explain why average utilization overstates available headroom.",
    "Size a fleet from peak demand and the largest failure domain.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
