import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-composite-erasure-backups",
  slug: "composite-erasure-backups",
  title: "Composite: The Erasure Request and the Backup",
  track: "case-files",
  order: 45,
  difficulty: 3,
  minutes: 20,
  prerequisites: ["compliance-right-to-erasure"],
  tags: ["erasure", "backups", "derived data", "anonymization", "retention"],
  productionQuestion:
    "A user is erased from the primary database but remains in backups and logs. Is the request complete?",
  learningDelta:
    "Erasure requires a documented policy for backups and derived data, with anonymization or expiry rather than impossible immediate deletion",
  objectives: [
    "Map every copy of personal data before declaring an erasure complete.",
    "Choose a defensible backup strategy that does not promise impossible deletion.",
    "Propagate deletion to derived stores such as indexes and analytics tables.",
    "Document residual copies, expiry dates, and suppression rules for restores.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
