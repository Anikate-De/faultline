import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "mesh-failover",
  slug: "failover",
  title: "Mesh Failover",
  track: "mesh",
  order: 18,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["mesh-locality"],
  tags: ["failover", "priority", "health", "endpoint", "zone"],
  productionQuestion: "A zone fails and Envoy keeps sending traffic to ejected endpoints. Why?",
  learningDelta:
    "Failover policy, priority groups, and health checks determine whether traffic moves; stale endpoints cause errors",
  objectives: [
    "Explain how Envoy priority levels decide when traffic moves to another zone.",
    "Distinguish a capacity shortfall from traffic sent to unhealthy endpoints.",
    "Relate health-check timing and priority configuration to failover behavior.",
    "Design a failover test that covers detection, capacity, and return traffic.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
