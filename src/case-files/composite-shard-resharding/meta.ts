import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-composite-shard-resharding",
  slug: "composite-shard-resharding",
  title: "Composite: The Reshard That Broke Clients",
  track: "case-files",
  order: 52,
  difficulty: 3,
  minutes: 20,
  prerequisites: ["caching-cluster-resharding"],
  tags: ["Redis Cluster", "MOVED", "ASK", "reshard", "clients"],
  productionQuestion:
    "A reshard starts and clients that do not follow redirects fail. What do you verify first?",
  learningDelta:
    "Cluster resharding requires redirect-aware clients, connection handling, and a rollback plan",
  objectives: [
    "Explain MOVED and ASK behavior during slot migration.",
    "Verify client redirect support before moving production slots.",
    "Choose a safe reshard pace and a reversible stopping point.",
    "Design a compatibility gate for future cluster changes.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
