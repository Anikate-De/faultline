import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "deployment-immutable-artifacts",
  slug: "immutable-artifacts",
  title: "Immutable Artifacts",
  track: "deployment",
  order: 17,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["deployment-build-once"],
  tags: ["immutable artifact", "digest", "promote", "rebuild", "provenance"],
  productionQuestion:
    "Staging passed but production runs a different build. What went wrong?",
  learningDelta:
    "Immutable artifacts are built once, identified by digest, and promoted; rebuilding per environment changes the software",
  objectives: [
    "Explain why rebuilding per environment produces different software from the same commit.",
    "Use an image digest rather than a mutable tag as the deployment identity.",
    "Identify the controls that prove staging and production ran the same bits.",
    "Design a promotion and retention path that keeps rollback artifacts available.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
