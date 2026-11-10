import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-fastly-2021",
  slug: "fastly-2021",
  title: "Fastly 2021: A Config Push That Returned 503 Everywhere",
  track: "case-files",
  order: 8,
  difficulty: 4,
  minutes: 24,
  prerequisites: ["traffic-cdn-cache-keys"],
  tags: ["CDN", "config", "503", "canary", "rollback"],
  productionQuestion:
    "A valid config passes validation and breaks every PoP. What is the safe deployment unit?",
  learningDelta:
    "Edge config needs canaries, independent validation, and a rollback path that does not depend on the failing system",
  objectives: [
    "Separate configuration validity from configuration safety at the edge.",
    "Explain how a latent software bug can stay dormant for weeks before a valid change triggers it.",
    "Choose a first mitigation that disables the trigger instead of rebuilding the platform.",
    "Design a deployment unit that bounds the blast radius of a global config activation.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
