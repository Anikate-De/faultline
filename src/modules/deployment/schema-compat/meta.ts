import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "deployment-schema-compat",
  slug: "schema-compat",
  title: "Schema Compatibility",
  track: "deployment",
  order: 24,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["deployment-expand-contract"],
  tags: ["schema compatibility", "backward", "forward", "rolling", "defaults"],
  productionQuestion:
    "Old and new versions run side by side for an hour. What schema rules apply?",
  learningDelta:
    "Rolling and canary releases require backward and forward compatible schemas; readers must tolerate missing and extra fields",
  objectives: [
    "Distinguish backward compatibility from forward compatibility during a rollout.",
    "Explain why a required field breaks old readers while an additive field does not.",
    "Sequence a schema change so old and new versions can coexist.",
    "Test schema compatibility before and during a mixed-version window.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
