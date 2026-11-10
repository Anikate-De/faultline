import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "mesh-circuit-breaking",
  slug: "mesh-circuit-breaking",
  title: "Mesh Circuit Breaking",
  track: "mesh",
  order: 8,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["foundations-circuit-breaking"],
  tags: ["circuit breaker", "max connections", "pending requests", "retry budget", "outlier"],
  productionQuestion: "A dependency is slow and Envoy keeps opening new connections. What limits do you set?",
  learningDelta:
    "Envoy circuit breakers cap connections, pending requests, and retries; they protect the upstream and fail fast locally",
  objectives: [
    "Calculate the concurrency a dependency needs from rate and latency.",
    "Set connection, pending request, and retry limits that shed load locally.",
    "Distinguish a local breaker rejection from an upstream failure.",
    "Explain what happens when limits are raised past the upstream's capacity.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
