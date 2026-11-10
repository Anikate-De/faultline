import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "foundations-timeouts",
  slug: "foundations-timeouts",
  title: "Timeouts: Budgets That Travel With the Request",
  track: "foundations",
  order: 9,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["foundations-littles-law"],
  tags: ["timeout", "deadline propagation", "budget", "retry amplification", "cancellation"],
  productionQuestion:
    "A request has 800ms total and three calls; which timeout do you set?",
  learningDelta:
    "Timeouts must be smaller than the caller's remaining budget and must propagate a deadline, not restart it",
  objectives: [
    "Derive per-hop timeouts from an end-to-end request budget.",
    "Explain why a deadline is not the same as a fresh timeout at each hop.",
    "Recognize pool saturation caused by work that outlives the caller.",
    "Choose between a tighter timeout, a shorter chain, and load shedding.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
