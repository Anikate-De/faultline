import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-composite-mesh-retry",
  slug: "composite-mesh-retry",
  title: "Composite: The Mesh Retry Policy Nobody Owned",
  track: "case-files",
  order: 32,
  difficulty: 4,
  minutes: 22,
  prerequisites: ["mesh-retry-storm"],
  tags: ["mesh", "retry", "budget", "ownership", "amplification"],
  productionQuestion:
    "Every service retries three times and one dependency failure triples platform traffic. Where do you fix it?",
  learningDelta:
    "Retry policy is a shared dependency contract; mesh defaults and per-service overrides need ownership and budgets",
  objectives: [
    "Trace multiplicative retry amplification across proxy hops.",
    "Choose a first mitigation at the shared layer rather than per service.",
    "Define ownership for mesh defaults and per-route overrides.",
    "Set a retry budget that bounds total attempts during an outage.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
