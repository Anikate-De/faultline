import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "foundations-percentiles",
  slug: "percentiles",
  title: "Percentiles: What the Average Hides",
  track: "foundations",
  order: 4,
  difficulty: 1,
  minutes: 14,
  prerequisites: ["foundations-use-red"],
  tags: ["p50", "p95", "p99", "p999", "histogram", "tail latency"],
  productionQuestion:
    "Mean latency is 80ms and p99 is 1.9s; which number describes the user experience?",
  learningDelta:
    "Averages hide tail pain; p99 and p999 describe the slow requests that drive timeouts and retries",
  objectives: [
    "Read a latency distribution instead of a single average.",
    "Choose a percentile based on the user action and the traffic volume.",
    "Explain why a small slow cohort can dominate timeouts and retries.",
    "Avoid averaging percentiles across instances or time windows.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
