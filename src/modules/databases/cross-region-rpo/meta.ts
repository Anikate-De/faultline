import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "databases-cross-region-rpo",
  slug: "cross-region-rpo",
  title: "Cross-Region Lag and RPO",
  track: "databases",
  order: 5,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["databases-aurora-global"],
  tags: ["RPO", "RTO", "replication lag", "promotion", "data loss", "reconciliation"],
  productionQuestion:
    "The primary region is failing and replica lag is 90 seconds. How much data do you lose on promotion?",
  learningDelta:
    "RPO is bounded by replication lag at failover; promotion discards unreplicated writes and requires application reconciliation",
  objectives: [
    "Calculate the data-loss window from replication lag and write rate at the moment of promotion.",
    "Separate RPO from RTO when deciding whether a regional failover is safe.",
    "Explain why a planned switchover can reach RPO 0 while an unplanned failover cannot.",
    "Plan reconciliation for writes the promoted secondary never received.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
