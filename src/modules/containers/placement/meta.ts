import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "containers-placement",
  slug: "placement",
  title: "ECS Placement",
  track: "containers",
  order: 3,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["containers-services"],
  tags: ["placement", "spread", "binpack", "constraint", "AZ"],
  productionQuestion:
    "All tasks land on one container instance and it saturates. How do you spread them?",
  learningDelta:
    "Placement strategies and constraints control bin packing and spread; Fargate abstracts instances but not AZ spread",
  objectives: [
    "Compare spread across Availability Zones, spread across instances, and binpack.",
    "Explain why a binding constraint can prevent placement while a strategy only guides it.",
    "Read per-instance utilization instead of trusting the cluster average.",
    "Choose a placement policy that preserves both capacity and Availability Zone spread.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
