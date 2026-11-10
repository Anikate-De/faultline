import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-composite-read-replica-lag",
  slug: "composite-read-replica-lag",
  title: "Composite: The Stale Read After a Write",
  track: "case-files",
  order: 53,
  difficulty: 3,
  minutes: 20,
  prerequisites: ["databases-read-after-write"],
  tags: ["read-after-write", "replica", "lag", "sticky", "version"],
  productionQuestion: "A user saves a change and sees the old value on refresh. What is the cheapest correct fix?",
  learningDelta:
    "Read-your-writes needs a consistency boundary; sticky reads, version tokens, or primary reads for a window solve it at different costs",
  objectives: [
    "Distinguish replica lag from a failed write or a cache problem.",
    "Choose a read-your-writes mechanism that preserves replica offload.",
    "Scope a consistency guarantee to the session and data that need it.",
    "Design monitoring that catches user-visible staleness, not just lag.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
