import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "containers-alb-target-registration",
  slug: "alb-target-registration",
  title: "ALB Target Registration for ECS",
  track: "containers",
  order: 11,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["traffic-alb-target-groups"],
  tags: ["target registration", "IP mode", "port", "health", "security group"],
  productionQuestion:
    "A task is running but receives no traffic. What registration state do you check?",
  learningDelta:
    "ECS registers tasks by IP or instance; target group health, security groups, and ports decide traffic",
  objectives: [
    "Trace a task from RUNNING to healthy target through registration, health check, port, and security group.",
    "Explain why an awsvpc task needs IP targets and what fails with instance targets.",
    "Separate a registration failure from a target health check failure using target health state and reason codes.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
