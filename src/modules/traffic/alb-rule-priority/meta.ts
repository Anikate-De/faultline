import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "traffic-alb-rule-priority",
  slug: "alb-rule-priority",
  title: "ALB Rule Priority and Order",
  track: "traffic",
  order: 29,
  difficulty: 2,
  minutes: 14,
  prerequisites: ["traffic-alb-target-groups"],
  tags: ["listener rule", "priority", "host", "path", "first match"],
  productionQuestion:
    "A new host rule works in staging but not production. What wins?",
  learningDelta:
    "ALB listener rules evaluate in priority order; the first match wins, so broad rules can shadow specific ones",
  objectives: [
    "Trace a request through listener rules in priority order.",
    "Explain why a more specific condition does not automatically win.",
    "Diagnose a shadowed rule from target group traffic and access logs.",
    "Design a rule order that keeps specific routes ahead of broad fallbacks.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
