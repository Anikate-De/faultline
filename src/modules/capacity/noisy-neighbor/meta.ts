import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "capacity-noisy-neighbor",
  slug: "noisy-neighbor",
  title: "Noisy Neighbor",
  track: "capacity",
  order: 17,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["foundations-bulkheads"],
  tags: ["noisy neighbor", "tenant", "quota", "isolation", "utilization"],
  productionQuestion:
    "One tenant's batch workload doubles the latency of everyone else. What do you do?",
  learningDelta:
    "Noisy neighbors need per-tenant quotas, isolation, or scheduling; shared pools maximize utilization and risk",
  objectives: [
    "Explain how one tenant's CPU demand reaches another tenant's latency in a shared pool.",
    "Distinguish a quota, a reserved capacity share, and separate pools as isolation mechanisms.",
    "Diagnose the noisy neighbor from per-tenant latency and shared-pool saturation.",
    "Choose an isolation level and defend its utilization cost.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
