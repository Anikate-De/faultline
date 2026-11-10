import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "reliability-graceful-degradation",
  slug: "reliability-graceful-degradation",
  title: "Degrading in an Incident",
  track: "reliability",
  order: 17,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["foundations-graceful-degradation"],
  tags: ["degradation", "fallback", "dependency", "critical path", "communication"],
  productionQuestion:
    "Recommendation latency is causing checkout failures. What do you disable now?",
  learningDelta:
    "Incident degradation follows a pre-ranked dependency list and feature fallbacks; disabling fast is better than tuning slow",
  objectives: [
    "Rank optional dependencies by their impact on the critical path before an incident.",
    "Choose the smallest set of features to disable to restore checkout.",
    "Explain why a fast, reversible degradation beats latency tuning during an active incident.",
    "Tell customers which features are unavailable without exposing internal details.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
