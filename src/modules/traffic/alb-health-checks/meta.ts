import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "traffic-alb-health-checks",
  slug: "alb-health-checks",
  title: "Health Checks: Fast Detection vs Flapping",
  track: "traffic",
  order: 3,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["traffic-alb-target-groups"],
  tags: ["health check", "interval", "timeout", "threshold", "grace period", "flapping"],
  productionQuestion:
    "A single slow health check removed every task at once. What settings caused it?",
  learningDelta:
    "Interval, timeout, healthy/unhealthy thresholds, and grace period trade detection speed against false positives",
  objectives: [
    "Calculate detection and recovery time from health-check settings.",
    "Explain why a shared dependency can remove every target at once.",
    "Tune thresholds to survive a transient blip without hiding a real failure.",
    "Place the grace period at the orchestrator, not the target group.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
