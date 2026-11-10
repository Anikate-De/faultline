import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "compliance-hipaa",
  slug: "hipaa",
  title: "HIPAA for Engineers",
  track: "compliance",
  order: 1,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["cloud-networking-least-privilege"],
  tags: ["HIPAA", "safeguards", "PHI", "access", "audit"],
  productionQuestion:
    "A health-data workload needs HIPAA readiness. Which controls are actually required?",
  learningDelta:
    "HIPAA requires administrative, physical, and technical safeguards for protected health information; engineering owns access, audit, integrity, and transmission controls",
  objectives: [
    "Separate the Security Rule's administrative, physical, and technical safeguards and identify which ones engineering implements directly.",
    "Evaluate a health-data workload against access, audit, integrity, authentication, and transmission controls.",
    "Recognize when a control exists but its evidence is too stale to demonstrate operation.",
    "Scope a HIPAA readiness review without treating it as a legal opinion.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
