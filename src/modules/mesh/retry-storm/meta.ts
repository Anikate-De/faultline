import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "mesh-retry-storm",
  slug: "retry-storm",
  title: "Envoy Retry Storm",
  track: "mesh",
  order: 19,
  difficulty: 4,
  minutes: 20,
  prerequisites: ["mesh-retries"],
  tags: ["retry storm", "amplification", "retry budget", "jitter", "breaker"],
  productionQuestion: "A dependency fails for 5 seconds and request volume triples for 5 minutes. What caused it?",
  learningDelta:
    "Coordinated proxy retries amplify failure; retry budgets, jitter, and circuit breaking bound the amplification",
  objectives: [
    "Distinguish a dependency fault from the retry amplification that follows it.",
    "Calculate how attempts, retry budgets, and breakers change offered load.",
    "Explain why a jittered retry policy still produces a sustained storm.",
    "Choose a retry control whose fail-fast tradeoff you can defend.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
