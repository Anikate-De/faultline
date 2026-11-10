import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "databases-backups-pitr",
  slug: "backups-pitr",
  title: "Backups and Point-in-Time Recovery",
  track: "databases",
  order: 13,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["databases-dr-drills"],
  tags: ["backup", "PITR", "WAL", "restore", "RTO", "RPO"],
  productionQuestion: "A bad migration deletes rows at 14:07. How do you restore without losing 14:00–14:07?",
  learningDelta:
    "PITR combines a base backup with continuous logs; recovery point and restore time are different objectives",
  objectives: [
    "Explain how a base backup plus archived write-ahead log defines a recoverable window.",
    "Choose a recovery target second and distinguish it from the time the restore finishes.",
    "Calculate the data-loss window when the target is outside retention or its log is not archived yet.",
    "Design and test a restore that reports achieved RPO and RTO rather than configured values.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
