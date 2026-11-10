import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "compliance-evidence",
  slug: "evidence",
  title: "Evidence Collection",
  track: "compliance",
  order: 16,
  difficulty: 2,
  minutes: 14,
  prerequisites: ["compliance-soc2"],
  tags: ["evidence", "automation", "timestamp", "ownership", "retention"],
  productionQuestion:
    "The audit starts tomorrow and evidence lives in screenshots. How do you prepare?",
  learningDelta:
    "Evidence should be generated continuously from systems of record with timestamps, ownership, and retention",
  objectives: [
    "Distinguish evidence produced by an operating control from a screenshot assembled after the fact.",
    "Design an evidence pipeline that captures scope, timestamp, owner, and source for every sample.",
    "Match retention to the audit window and test the lifecycle policy before it deletes proof.",
    "Prepare a defensible evidence set without turning audit preparation into a manual scramble.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
