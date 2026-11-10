import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "traffic-zonal-isolation",
  slug: "zonal-isolation",
  title: "Zonal Isolation: Survive an AZ Loss",
  track: "traffic",
  order: 9,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["foundations-capacity-headroom"],
  tags: ["zonal isolation", "AZ failure", "cross-zone", "dependency", "failover"],
  productionQuestion:
    "One AZ is impaired and the service degrades more than expected. What shared dependency crossed zones?",
  learningDelta:
    "Zonal isolation requires independent targets, load balancer nodes, NAT, and dependencies per zone",
  objectives: [
    "Size each zone for the loss of another zone, not for its even share.",
    "Find dependencies that cross the zone boundary and correlate failures.",
    "Explain what cross-zone load balancing does and does not fix.",
    "Design a failover test that exercises the real dependency graph.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
