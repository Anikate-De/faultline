import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "compliance-gdpr",
  slug: "gdpr",
  title: "GDPR for Engineers",
  track: "compliance",
  order: 6,
  difficulty: 2,
  minutes: 18,
  prerequisites: ["compliance-data-classification"],
  tags: ["GDPR", "lawful basis", "data subject", "discovery", "deletion"],
  productionQuestion:
    "A user asks for their data. Which systems must answer?",
  learningDelta:
    "GDPR rights require data discovery, deletion, export, and lawful basis across primary stores, caches, logs, and backups",
  objectives: [
    "Translate data-subject rights into discovery, export, correction, and deletion operations across every store.",
    "Find the systems that make a request incomplete even when the primary database reports success.",
    "Separate a documented lawful basis from the engineering controls that enforce purpose and retention.",
    "Scope a rights-readiness review without treating it as a legal opinion.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
