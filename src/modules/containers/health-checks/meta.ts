import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "containers-health-checks",
  slug: "health-checks",
  title: "Container Health Checks",
  track: "containers",
  order: 15,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["traffic-alb-health-checks"],
  tags: ["liveness", "readiness", "health check", "restart", "target group"],
  productionQuestion:
    "A task is healthy but not ready, or ready but dead. Which check do you fix?",
  learningDelta:
    "Container and load balancer health checks answer different questions; liveness restarts, readiness removes traffic",
  objectives: [
    "Separate container health checks from target group health checks by what each one controls.",
    "Predict whether a warm-up will be restarted, removed from traffic, or both.",
    "Tune grace period, interval, and retries from startup time and detection budget.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
