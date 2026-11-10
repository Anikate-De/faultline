import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "compliance-right-to-erasure",
  slug: "right-to-erasure",
  title: "Right to Erasure",
  track: "compliance",
  order: 8,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["compliance-gdpr"],
  tags: ["erasure", "anonymization", "backups", "logs", "derived data"],
  productionQuestion:
    "A deletion request completes in the database but the data remains in logs and backups. What now?",
  learningDelta:
    "Erasure requires discovery and deletion or irreversible anonymization across primary data, derived data, logs, and backup policy",
  objectives: [
    "Choose between deletion, irreversible anonymization, and suppression for each class of store.",
    "Trace a deletion request through primary data, derived data, logs, and backups.",
    "Design a backup policy that prevents a restore from resurrecting an erased record.",
    "Prove completion with per-system evidence instead of a single database row count.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
