import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-composite-region-failover",
  slug: "composite-region-failover",
  title: "Composite: The Region Failover That Ran Out of Capacity",
  track: "case-files",
  order: 18,
  difficulty: 4,
  minutes: 24,
  prerequisites: ["databases-cross-region-rpo"],
  tags: ["multi-region", "capacity", "failover", "RTO", "headroom"],
  productionQuestion:
    "The DR region is healthy but cannot absorb the primary's traffic. What did the plan miss?",
  learningDelta:
    "Regional failover must reserve capacity for the full active load, not just prove the standby exists",
  objectives: [
    "Distinguish a reachable standby from a standby that can serve production load.",
    "Size failover capacity from measured peak demand and dependency limits.",
    "Choose mitigations that make the degraded region survivable before scaling arrives.",
    "Define an RTO that ends when users are served, not when DNS changes.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
