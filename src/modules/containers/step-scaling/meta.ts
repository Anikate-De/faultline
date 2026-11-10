import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "containers-step-scaling",
  slug: "step-scaling",
  title: "Step Scaling",
  track: "containers",
  order: 5,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["containers-target-tracking"],
  tags: ["step scaling", "threshold", "cooldown", "stabilization", "flapping"],
  productionQuestion:
    "Traffic crosses a threshold repeatedly and the service flaps between 4 and 20 tasks. Why?",
  learningDelta:
    "Step scaling uses thresholds and cooldowns; missing scale-in stabilization causes oscillation and cold starts",
  objectives: [
    "Explain how a step scaling policy turns CloudWatch alarm breaches into task count changes.",
    "Predict how threshold placement and scale-in stabilization interact with a repeating traffic wave.",
    "Distinguish a capacity shortfall from a policy that is oscillating between scale-out and scale-in.",
    "Design a step policy that holds enough ready capacity through the wave without flapping.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
