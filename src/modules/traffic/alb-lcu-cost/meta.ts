import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "traffic-alb-lcu-cost",
  slug: "alb-lcu-cost",
  title: "ALB LCU: Capacity and Cost Together",
  track: "traffic",
  order: 5,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["traffic-alb-connection-limit"],
  tags: [
    "LCU",
    "new connections",
    "active connections",
    "bytes",
    "rule evaluation",
    "cost",
  ],
  productionQuestion:
    "The bill doubled after a traffic change and the ALB is near its LCU limit. Which dimension moved?",
  learningDelta:
    "LCU bills the highest of new connections, active connections, processed bytes, and rule evaluations; the same traffic can be limited by different dimensions",
  objectives: [
    "Attribute an ALB bill to the LCU dimension that actually sets it.",
    "Predict how response size, connection lifetime, reuse, and rule count move cost.",
    "Distinguish an LCU cost overrun from an availability incident.",
    "Reduce LCU demand without moving the bottleneck to targets or clients.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
