import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "foundations-retry-backoff-jitter",
  slug: "retry-backoff-jitter",
  title: "Retries, Backoff, and Jitter",
  track: "foundations",
  order: 10,
  difficulty: 2,
  minutes: 18,
  prerequisites: ["foundations-timeouts"],
  tags: ["retry budget", "exponential backoff", "jitter", "retry storm", "idempotency"],
  productionQuestion:
    "A dependency returns 503 for two seconds; why did traffic triple?",
  learningDelta:
    "Synchronized retries amplify failure; exponential backoff with jitter spreads retries and caps amplification",
  objectives: [
    "Calculate retry amplification from attempts, failure rate, and a retry budget.",
    "Explain why synchronized retries keep a dependency down after the trigger clears.",
    "Choose a backoff, jitter, and budget combination that recovers inside the SLO.",
    "Distinguish a retry policy problem from a dependency capacity problem.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
