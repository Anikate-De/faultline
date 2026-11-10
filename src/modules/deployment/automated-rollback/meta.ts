import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "deployment-automated-rollback",
  slug: "automated-rollback",
  title: "Automated Rollback",
  track: "deployment",
  order: 6,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["deployment-canary-metric-gate"],
  tags: ["automated rollback", "health gate", "artifact", "detection", "recovery"],
  productionQuestion: "A release raises 5xx at 3 a.m. How fast can rollback happen without a human?",
  learningDelta:
    "Automated rollback uses health and metric gates plus a tested rollback path; the recovery time is bounded by detection and artifact availability",
  objectives: [
    "Break recovery time into detection, decision, and rollback execution.",
    "Explain how a metric gate triggers an automated rollback without a human.",
    "Identify the artifact and schema conditions that make rollback possible.",
    "Choose detection sensitivity that limits exposure without causing rollback loops.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
