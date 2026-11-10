import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "traffic-alb-connection-limit",
  slug: "alb-connection-limit",
  title: "ALB Connection Limit Reached: Sharding to NLB",
  track: "traffic",
  order: 4,
  difficulty: 3,
  minutes: 20,
  prerequisites: ["traffic-alb-health-checks"],
  tags: ["ALB", "connection limits", "LCU", "NLB", "ALB sharding", "target capacity"],
  productionQuestion:
    "Your ALB is healthy, targets are healthy, and you raised the capacity ceiling. New connections are still dropped at peak. What now?",
  learningDelta:
    "ALB scale limits are per load balancer and per node; at scale you shard across ALBs behind an NLB, not just raise a single ceiling",
  objectives: [
    "Locate a per-ALB connection bottleneck using rejected connections, node count, and LCU.",
    "Explain why raising an illustrative per-ALB ceiling cannot exceed the 100-node limit.",
    "Compare DNS-weighted ALB sharding with an NLB front door by cost, routing, and failure mode.",
    "Design a sharded path that keeps targets healthy and clients connected.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
