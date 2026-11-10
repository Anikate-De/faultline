import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "foundations-cap-pacelc",
  slug: "cap-pacelc",
  title: "CAP and PACELC: The Trade You Cannot Avoid",
  track: "foundations",
  order: 15,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["foundations-use-red"],
  tags: ["CAP", "PACELC", "partition", "availability", "latency", "consistency"],
  productionQuestion:
    "The network partition is real; which writes do you accept and which do you refuse?",
  learningDelta:
    "CAP applies only during partitions; PACELC extends the tradeoff to latency versus consistency in normal operation",
  objectives: [
    "State CAP precisely: consistency, availability, and partition tolerance are not three everyday choices.",
    "Predict read and write outcomes for strong, available, and quorum modes during a partition.",
    "Use PACELC to explain the latency cost of consistency when the network is healthy.",
    "Defend a consistency choice by naming the conflict policy and the user-visible failure.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
