import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "reliability-dependency-failure",
  slug: "dependency-failure",
  title: "Dependency Failure",
  track: "reliability",
  order: 18,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["foundations-graceful-degradation"],
  tags: ["dependency", "third party", "fallback", "isolation", "error budget"],
  productionQuestion:
    "A payment provider is failing and your service returns 500 for all requests. What do you do?",
  learningDelta:
    "Dependency failures need isolation, fallback, and clear failure semantics; retrying a third party is not a strategy",
  objectives: [
    "Contain a third-party failure so unrelated flows keep working.",
    "Choose an explicit failure semantic for the affected flow instead of a generic 500.",
    "Explain why retries against a failing provider make containment harder.",
    "Separate the provider's recovery from your service's recovery.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
