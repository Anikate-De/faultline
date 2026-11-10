import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "mesh-policy-conflict",
  slug: "policy-conflict",
  title: "Policy Conflicts",
  track: "mesh",
  order: 20,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["mesh-kuma-control-plane"],
  tags: ["policy", "precedence", "scope", "selector", "conflict"],
  productionQuestion: "Two policies set different timeouts for the same service. Which one applies?",
  learningDelta:
    "Mesh policy precedence depends on scope and specificity; conflicting policies are hard to debug without a clear ownership model",
  objectives: [
    "Explain how Kuma selects one policy when several match a proxy.",
    "Distinguish an intended policy from the effective configuration.",
    "Predict the effect of a selector that matches only part of a workload.",
    "Design policy ownership that keeps overlapping scopes debuggable.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
