import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "traffic-alb-target-groups",
  slug: "alb-target-groups",
  title: "ALB Target Groups: Registration and Health",
  track: "traffic",
  order: 2,
  difficulty: 1,
  minutes: 14,
  prerequisites: ["traffic-l4-vs-l7"],
  tags: ["target group", "registration", "health check", "port", "503", "ECS"],
  productionQuestion:
    "The ALB returns 503 while the tasks are running and healthy. What do you check?",
  learningDelta:
    "An ALB only routes to healthy registered targets; health check path, port, and security groups decide registration",
  objectives: [
    "Distinguish a running task from a registered, healthy target.",
    "Explain which conditions produce an ALB 503 and which produce a target error.",
    "Read target health reason codes and map them to path, port, or security group causes.",
    "Fix registration before tuning capacity or health-check timing.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
