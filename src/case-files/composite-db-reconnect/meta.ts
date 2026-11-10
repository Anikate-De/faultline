import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-composite-db-reconnect",
  slug: "composite-db-reconnect",
  title: "Composite: The Reconnect Storm After Failover",
  track: "case-files",
  order: 25,
  difficulty: 4,
  minutes: 22,
  prerequisites: ["databases-connection-storm"],
  tags: ["failover", "reconnect", "DNS", "pool", "recovery"],
  productionQuestion: "The database failed over successfully and the app is still down. Why?",
  learningDelta:
    "Database recovery is not application recovery; DNS, pools, and reconnect storms determine when traffic actually returns",
  objectives: [
    "Define database recovery and application recovery as separate checkpoints.",
    "Trace failed application connects through DNS, pool state, and server limits.",
    "Jitter reconnects and cap pools before adding database connections.",
    "Validate failover end to end instead of trusting the managed-service event.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
