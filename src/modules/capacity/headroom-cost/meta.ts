import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "capacity-headroom-cost",
  slug: "headroom-cost",
  title: "The Cost of Headroom",
  track: "capacity",
  order: 4,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["foundations-capacity-headroom"],
  tags: ["headroom", "N+1", "cost", "peak", "failure domain"],
  productionQuestion:
    "Finance asks why 40% of capacity is idle. How do you justify it?",
  learningDelta:
    "Headroom is insurance against failure and peaks; the right level depends on SLO, failure domain size, and traffic variability",
  objectives: [
    "Quantify the monthly cost of headroom above peak demand.",
    "Size N+1 from the largest failure domain and the post-failure SLO target.",
    "Distinguish exact N+1 from headroom that absorbs variability and failover.",
    "Defend a headroom level with a cost and risk comparison.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
