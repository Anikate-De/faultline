import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "deployment-canary",
  slug: "deployment-canary",
  title: "Canary Deployments",
  track: "deployment",
  order: 3,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["deployment-rolling"],
  tags: ["canary", "traffic slice", "gate", "promotion", "blast radius"],
  productionQuestion: "A release has a bug that affects 1% of requests. How does a canary help?",
  learningDelta:
    "A canary exposes a small traffic slice to the new version and gates promotion on observed signals",
  objectives: [
    "Explain how a canary limits blast radius without proving the release is safe.",
    "Compare per-version error rate with the blended service error rate.",
    "Detect a gate that passes because stable traffic dilutes canary errors.",
    "Decide when the canary slice is large enough to support promotion.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
