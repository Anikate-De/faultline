import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "compliance-iso27001",
  slug: "iso27001",
  title: "ISO 27001",
  track: "compliance",
  order: 11,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["compliance-soc2"],
  tags: ["ISO 27001", "risk assessment", "treatment", "management system", "audit"],
  productionQuestion:
    "The ISO audit finds policies but no risk treatment. What is missing?",
  learningDelta:
    "ISO 27001 requires a risk-based management system with ownership, treatment plans, and continual improvement",
  objectives: [
    "Distinguish an information security management system from a document set.",
    "Trace a high risk from assessment through an owned, approved treatment.",
    "Identify the evidence an internal audit and management review must produce.",
    "Prioritize remediation when the risk register and treatment plan disagree.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
