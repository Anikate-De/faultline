import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "capacity-autoscaling-policies",
  slug: "autoscaling-policies",
  title: "Autoscaling Policy Design",
  track: "capacity",
  order: 3,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["containers-target-tracking"],
  tags: ["autoscaling", "metric", "cooldown", "startup", "limit"],
  productionQuestion:
    "A service scales on CPU but the bottleneck is queue depth. What policy do you use?",
  learningDelta:
    "Scaling policies must follow the actual bottleneck metric and account for startup, cooldowns, and capacity limits",
  objectives: [
    "Match a scaling policy to the metric that actually limits throughput.",
    "Read desired capacity, in-service capacity, and startup lag as separate signals.",
    "Diagnose a policy that scales on a misleading resource metric.",
    "Choose a target, startup allowance, and capacity ceiling that survive a ramp.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
