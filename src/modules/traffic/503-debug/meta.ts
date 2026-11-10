import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "traffic-503-debug",
  slug: "503-debug",
  title: "Debugging 503 Service Unavailable",
  track: "traffic",
  order: 27,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["traffic-alb-connection-limit"],
  tags: ["503", "no registered targets", "connection limit", "overload", "target"],
  productionQuestion:
    "The ALB returns 503 but CPU is 40%. What are the possible causes?",
  learningDelta:
    "A 503 can be ELB-generated when no target is registered, or target-generated when a concurrency or pool limit rejects work; CPU alone does not explain it",
  objectives: [
    "Separate an ELB-generated 503 from a target-generated 503 using ELB and target metrics and access-log status fields.",
    "Recognize deregistered or unused targets as an ELB 503 even when target CPU is idle.",
    "Identify a target concurrency or connection-pool limit as a 503 cause at moderate CPU.",
    "Choose between registering capacity, raising a target limit, and shedding load.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
