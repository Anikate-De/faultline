import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "compliance-vendor-risk",
  slug: "vendor-risk",
  title: "Vendor Risk",
  track: "compliance",
  order: 17,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["compliance-dpa"],
  tags: ["vendor risk", "criticality", "assessment", "subcontractor", "exit"],
  productionQuestion:
    "A critical vendor has no security review and an outage exposes customer data. What did you miss?",
  learningDelta:
    "Vendor risk covers security, availability, data handling, subcontractors, and exit; criticality determines depth",
  objectives: [
    "Assign vendor criticality from data access, availability dependency, and substitutability.",
    "Match assessment depth and evidence to each tier instead of applying one questionnaire to every vendor.",
    "Evaluate subcontractor visibility and a tested exit path as part of the same risk decision.",
    "Prioritize a vendor portfolio before an incident forces the review.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
