import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "compliance-retention",
  slug: "compliance-retention",
  title: "Retention and Legal Hold",
  track: "compliance",
  order: 14,
  difficulty: 3,
  minutes: 16,
  prerequisites: ["compliance-audit-logs"],
  tags: ["retention", "legal hold", "deletion", "evidence", "suspension"],
  productionQuestion:
    "A legal hold arrives while the retention job is deleting records. What do you do?",
  learningDelta:
    "Retention schedules must be enforceable and suspendable; legal hold overrides deletion and requires evidence of preservation",
  objectives: [
    "Separate a retention schedule from a legal hold and explain how they interact.",
    "Trace a hold to every copy, index, cache, and backup that must preserve data.",
    "Design deletion that is enforceable, observable, and suspendable.",
    "Produce evidence that preserved records were not altered or deleted.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
