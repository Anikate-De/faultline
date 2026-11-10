import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "reliability-retry-storms",
  slug: "retry-storms",
  title: "Retry Storms in Production",
  track: "reliability",
  order: 19,
  difficulty: 4,
  minutes: 20,
  prerequisites: ["foundations-retry-backoff-jitter"],
  tags: ["retry storm", "amplification", "breaker", "budget", "incident action"],
  productionQuestion:
    "A dependency blips and the whole platform melts down for 20 minutes. What is the first move?",
  learningDelta:
    "In a retry storm, reduce retries and load before tuning the dependency; retry budgets and breakers stop the feedback loop",
  objectives: [
    "Diagnose amplification by comparing dependency load with original request rate.",
    "Stop a retry storm with a budget or breaker before attempting a dependency fix.",
    "Explain why a dependency can stay down after the original fault clears.",
    "Order the recovery actions so the backlog does not restart the storm.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
