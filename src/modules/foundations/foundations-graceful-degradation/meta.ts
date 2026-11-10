import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "foundations-graceful-degradation",
  slug: "foundations-graceful-degradation",
  title: "Graceful Degradation: Cut Features, Keep Promises",
  track: "foundations",
  order: 14,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["foundations-bulkheads"],
  tags: ["dependency tiering", "feature fallback", "timeout isolation", "critical path", "partial failure"],
  productionQuestion:
    "Recommendations are down and the product is timing out; what do you disable first?",
  learningDelta:
    "Degradation is a designed dependency hierarchy; non-critical work must fail without taking the core path",
  objectives: [
    "Rank dependencies by what the product promises, not by how visible they are.",
    "Separate an optional call's timeout and failure path from the critical request budget.",
    "Design a fallback that is useful, bounded, and honest about being degraded.",
    "Explain why a 200 response with a missing module can be better than a 500.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
