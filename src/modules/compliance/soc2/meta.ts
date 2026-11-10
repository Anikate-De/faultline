import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "compliance-soc2",
  slug: "soc2",
  title: "SOC 2 for Engineers",
  track: "compliance",
  order: 10,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["compliance-audit-logs"],
  tags: ["SOC 2", "trust criteria", "control", "evidence", "audit"],
  productionQuestion:
    "An enterprise customer asks for SOC 2. Which controls need evidence?",
  learningDelta:
    "SOC 2 reports on security, availability, processing integrity, confidentiality, and privacy; evidence must come from operating controls",
  objectives: [
    "Map the five SOC 2 trust services criteria to concrete engineering controls.",
    "Distinguish a control that exists in policy from one that produced operating evidence during the period.",
    "Design evidence capture that is continuous, attributable, and fresh enough to sample.",
    "Explain what an exception in a SOC 2 report does and does not mean.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
