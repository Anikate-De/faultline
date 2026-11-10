import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "capacity-committed-use",
  slug: "committed-use",
  title: "Committed Use",
  track: "capacity",
  order: 20,
  difficulty: 3,
  minutes: 16,
  prerequisites: ["capacity-savings-plans"],
  tags: ["commitment", "term", "coverage", "flexibility", "break-even"],
  productionQuestion:
    "A three-year commitment saves 40% but the workload may change. How do you decide?",
  learningDelta:
    "Commitments trade flexibility for discount; forecast confidence, term, and coverage determine the break-even",
  objectives: [
    "Compute the break-even between a commitment discount and unused committed spend.",
    "Separate coverage from utilization when judging a commitment.",
    "Diagnose a commitment that outlives the workload it was bought for.",
    "Choose a term and coverage level from forecast confidence, not from the discount alone.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
