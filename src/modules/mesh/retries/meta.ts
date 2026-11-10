import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "mesh-retries",
  slug: "retries",
  title: "Mesh Retries",
  track: "mesh",
  order: 6,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["foundations-retry-backoff-jitter"],
  tags: ["retry", "retry budget", "condition", "per-try timeout", "amplification"],
  productionQuestion:
    "Envoy retries every 503 three times and the dependency collapses. What do you change?",
  learningDelta:
    "Proxy retries are powerful and dangerous; retry budgets, conditions, and per-try timeout prevent amplification",
  objectives: [
    "Design a retry policy from the failure condition, attempt count, and per-try deadline.",
    "Calculate how retries change offered load against a dependency's capacity.",
    "Use a retry budget to bound amplification and explain its user-visible cost.",
    "Distinguish a retry that helps an isolated failure from one that sustains a shared failure.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
