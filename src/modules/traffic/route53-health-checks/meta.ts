import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "traffic-route53-health-checks",
  slug: "route53-health-checks",
  title: "Route 53 Health Checks",
  track: "traffic",
  order: 13,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["traffic-dns-ttl-failover"],
  tags: ["Route 53", "health check", "calculated check", "failover", "threshold"],
  productionQuestion:
    "Route 53 still sends traffic to a dead region. What does its health check actually observe?",
  learningDelta:
    "Route 53 health checks probe endpoints from multiple locations and can be calculated or CloudWatch-backed; thresholds determine failover speed",
  objectives: [
    "Explain what a Route 53 endpoint health check observes and what it cannot see.",
    "Choose an interval and failure threshold that meet a failover objective without flapping.",
    "Use calculated and CloudWatch-backed checks when a direct endpoint probe is the wrong signal.",
    "Diagnose a green health check while the user request path is failing.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
