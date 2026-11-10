import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "traffic-alb-sharding",
  slug: "alb-sharding",
  title: "Sharding ALBs by Tenant or Hostname",
  track: "traffic",
  order: 7,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["traffic-nlb-in-front-of-alb"],
  tags: ["sharding", "hostname", "tenant", "sticky sessions", "routing", "observability"],
  productionQuestion:
    "One tenant's traffic saturates its ALB while other ALBs are idle. How do you shard?",
  learningDelta:
    "Sharding by hostname, path, or tenant reduces per-ALB connection pressure but requires routing consistency and per-shard observability",
  objectives: [
    "Choose a shard key that matches the tenant and session model.",
    "Locate the hot shard instead of reading the fleet average.",
    "Predict when a new shard will and will not reduce per-ALB load.",
    "Preserve sessions while isolating a heavy tenant.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
