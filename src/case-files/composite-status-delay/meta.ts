import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-composite-status-delay",
  slug: "composite-status-delay",
  title: "Composite: The Status Page That Lagged the Incident",
  track: "case-files",
  order: 38,
  difficulty: 2,
  minutes: 18,
  prerequisites: ["reliability-status-pages"],
  tags: ["status page", "communication", "impact", "cadence", "trust"],
  productionQuestion:
    "Customers know about the outage before the status page updates. What is the right communication?",
  learningDelta:
    "Status communication can start with known impact and next update time before root cause is known",
  objectives: [
    "Write a first external update from known impact, not root cause.",
    "Choose a communication cadence that reduces support load.",
    "Separate the internal incident channel from customer messaging.",
    "Design a status page that does not depend on the failing system.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
