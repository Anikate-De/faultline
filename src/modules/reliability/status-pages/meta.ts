import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "reliability-status-pages",
  slug: "status-pages",
  title: "Status Pages",
  track: "reliability",
  order: 24,
  difficulty: 1,
  minutes: 12,
  prerequisites: ["reliability-customer-comms"],
  tags: ["status page", "impact", "update", "communication", "trust"],
  productionQuestion: "Users report failures before the status page updates. What should it say?",
  learningDelta:
    "Status pages communicate known impact and next update time; they must not speculate on cause or blame a provider prematurely",
  objectives: [
    "Publish a first status update from known impact without waiting for a root cause.",
    "State a next update time and hold it even when nothing has changed.",
    "Keep speculation and premature blame out of the public page.",
    "Measure the support and trust cost of an outdated status page.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
