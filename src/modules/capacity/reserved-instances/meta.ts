import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "capacity-reserved-instances",
  slug: "reserved-instances",
  title: "Reserved Instances",
  track: "capacity",
  order: 8,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["capacity-savings-plans"],
  tags: ["reserved instances", "commitment", "coverage", "family", "term"],
  productionQuestion:
    "RI coverage is 80% but the bill still rises. What changed?",
  learningDelta:
    "RIs discount steady-state usage but are tied to instance family, region, and term; workload drift wastes coverage",
  objectives: [
    "Distinguish Reserved Instance coverage from utilization.",
    "Explain which attributes a reservation must match to apply.",
    "Diagnose a bill increase when headline coverage looks healthy.",
    "Choose between modifying, exchanging, or re-buying coverage as the fleet changes.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
