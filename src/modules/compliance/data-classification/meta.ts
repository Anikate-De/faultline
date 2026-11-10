import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "compliance-data-classification",
  slug: "data-classification",
  title: "Data Classification",
  track: "compliance",
  order: 13,
  difficulty: 2,
  minutes: 14,
  prerequisites: ["compliance-phi"],
  tags: ["classification", "sensitivity", "label", "control", "mixed data"],
  productionQuestion:
    "One bucket holds public, internal, and customer data. What is the classification?",
  learningDelta:
    "Classification drives access, encryption, retention, and incident handling; mixed datasets inherit the highest sensitivity",
  objectives: [
    "Assign a sensitivity label from the data a dataset actually contains.",
    "Explain why a mixed dataset inherits its highest sensitivity.",
    "Trace a classification label to the controls that must follow it.",
    "Find datasets whose controls are weaker than their contents.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
