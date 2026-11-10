import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "foundations-consistency-models",
  slug: "consistency-models",
  title: "Consistency Models: What a Read Can Promise",
  track: "foundations",
  order: 16,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["foundations-cap-pacelc"],
  tags: [
    "linearizability",
    "read-your-writes",
    "monotonic reads",
    "eventual consistency",
    "staleness",
  ],
  productionQuestion:
    "A user updates a profile and immediately sees the old value; which consistency guarantee is missing?",
  learningDelta:
    "Strong, read-your-writes, monotonic, and eventual consistency are different promises with different costs",
  objectives: [
    "Name the guarantee a user experience actually requires.",
    "Diagnose a stale read from replica lag, routing, and session affinity.",
    "Choose between weakening the promise and routing reads to the primary.",
    "Defend the latency and availability cost of each model.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
