import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "traffic-sticky-sessions",
  slug: "sticky-sessions",
  title: "Sticky Sessions: Affinity and Its Cost",
  track: "traffic",
  order: 10,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["traffic-alb-health-checks"],
  tags: ["stickiness", "cookie", "affinity", "draining", "imbalance"],
  productionQuestion:
    "A session-heavy app loses carts when targets scale in. What is the tradeoff of stickiness?",
  learningDelta:
    "Sticky sessions preserve affinity but reduce load balance, complicate draining, and can concentrate load on a few targets",
  objectives: [
    "Explain how an ALB cookie binds a session to a target.",
    "Predict when stickiness concentrates load on one target.",
    "Trace what happens to a sticky session when a target drains or fails.",
    "Choose between target affinity and a shared session store.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
