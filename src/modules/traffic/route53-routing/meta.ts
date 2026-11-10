import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "traffic-route53-routing",
  slug: "route53-routing",
  title: "Route 53 Routing Policies",
  track: "traffic",
  order: 14,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["traffic-route53-health-checks"],
  tags: ["weighted", "failover", "latency", "geolocation", "multivalue", "rollback"],
  productionQuestion:
    "You need gradual regional migration with fast rollback. Which routing policy fits?",
  learningDelta:
    "Weighted routing shifts traffic gradually; failover is binary; latency optimizes user location; geolocation enforces locality",
  objectives: [
    "Compare failover, weighted, latency, geolocation, and multivalue routing for a migration.",
    "Explain why a policy can be healthy but unable to express the desired traffic split.",
    "Design a gradual migration and rollback that accounts for DNS TTL and new-region capacity.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
