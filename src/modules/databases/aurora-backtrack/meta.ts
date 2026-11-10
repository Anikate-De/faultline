import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "databases-aurora-backtrack",
  slug: "aurora-backtrack",
  title: "Aurora Backtrack",
  track: "databases",
  order: 31,
  difficulty: 3,
  minutes: 16,
  prerequisites: ["databases-backups-pitr"],
  tags: ["Aurora Backtrack", "rewind", "retention", "restore", "migration"],
  productionQuestion: "A bad migration changed data 20 minutes ago. Can you rewind instead of restoring?",
  learningDelta:
    "Aurora Backtrack rewinds cluster state within a retention window, but it is not a substitute for backups and has limits",
  objectives: [
    "Compare backtrack, point-in-time recovery, and restore by RTO and scope.",
    "Explain the retention window and target-time constraints.",
    "Quantify the writes lost when rewinding to before a bad change.",
    "Decide when backtrack is unsafe or insufficient.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
