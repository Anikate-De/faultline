import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-composite-vendor-failure",
  slug: "composite-vendor-failure",
  title: "Composite: The Payment Provider Outage",
  track: "case-files",
  order: 39,
  difficulty: 3,
  minutes: 20,
  prerequisites: ["reliability-dependency-failure"],
  tags: ["vendor", "payment", "fallback", "isolation", "error budget"],
  productionQuestion:
    "A payment provider is down and checkout returns 500 for every cart. What do you do?",
  learningDelta:
    "Third-party failure needs isolation, fallback, and explicit failure semantics; not every flow should fail with the provider",
  objectives: [
    "Contain a payment provider failure without failing unrelated flows.",
    "Map provider errors to explicit checkout semantics.",
    "Reconcile ambiguous charges before inviting a retry.",
    "Isolate providers with bulkheads, breakers, and fallback routing.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
