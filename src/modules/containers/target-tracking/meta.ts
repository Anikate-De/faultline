import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "containers-target-tracking",
  slug: "target-tracking",
  title: "Target Tracking Scaling",
  track: "containers",
  order: 4,
  difficulty: 2,
  minutes: 18,
  prerequisites: ["containers-services"],
  tags: ["target tracking", "metric", "target value", "cooldown", "scale-out"],
  productionQuestion:
    "CPU stays at 40% while latency rises and the service does not scale. What metric should drive scaling?",
  learningDelta:
    "Target tracking follows a metric and a target; choosing CPU when the bottleneck is queue depth or concurrency causes late scaling",
  objectives: [
    "Explain how a target tracking policy turns a metric and a target into a task count.",
    "Choose a scaling metric that moves with the real bottleneck.",
    "Predict when a policy will not scale because its metric stays below target.",
    "Tune the target and cooldown without creating oscillation or sustained shortfall.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
