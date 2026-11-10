import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-composite-audit-gap",
  slug: "composite-audit-gap",
  title: "Composite: The Audit Log That Expired",
  track: "case-files",
  order: 44,
  difficulty: 2,
  minutes: 18,
  prerequisites: ["compliance-audit-logs"],
  tags: ["audit logs", "retention", "evidence", "compliance", "policy"],
  productionQuestion:
    "An auditor asks for six months of admin activity and logs were kept for 30 days. What now?",
  learningDelta:
    "Audit retention must match regulatory and contractual windows; deletion policy is a compliance control",
  objectives: [
    "Treat log retention as a designed control rather than a storage default.",
    "Respond honestly when required evidence no longer exists.",
    "Choose a retention and integrity design that matches the longest obligation.",
    "Verify retention with restore and query tests instead of policy documents alone.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
