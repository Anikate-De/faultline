import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "reliability-multi-region",
  slug: "multi-region",
  title: "Multi-Region Failover",
  track: "reliability",
  order: 22,
  difficulty: 4,
  minutes: 20,
  prerequisites: ["databases-cross-region-rpo"],
  tags: ["multi-region", "failover", "RPO", "capacity", "runbook"],
  productionQuestion: "One region is degraded but not down. Do you fail over and risk data loss?",
  learningDelta:
    "Regional failover trades availability for data loss and capacity; the decision needs RPO, capacity, and a tested runbook",
  objectives: [
    "Compare staying in a degraded region with failing over to a standby.",
    "Quantify data loss from replication lag before making the cutover decision.",
    "Verify standby capacity against current demand before promoting a region.",
    "Decide when a partial degradation does not justify a regional failover.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
