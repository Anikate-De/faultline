import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "capacity-load-testing",
  slug: "load-testing",
  title: "Load Testing",
  track: "capacity",
  order: 14,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["foundations-coordinated-omission"],
  tags: ["load test", "traffic mix", "open loop", "dependency", "coordinated omission"],
  productionQuestion:
    "A load test passes at 10k RPS and production fails at 6k. What was unrealistic?",
  learningDelta:
    "Load tests must model traffic mix, data, dependencies, and open-loop arrival; a closed-loop test hides queueing and coordinated omission",
  objectives: [
    "Distinguish open-loop arrival from closed-loop virtual users.",
    "Detect a test that never applied its intended load.",
    "Explain how traffic mix and dependency latency move the capacity knee.",
    "Design a test that finds the production knee before production does.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
