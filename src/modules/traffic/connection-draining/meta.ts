import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "traffic-connection-draining",
  slug: "connection-draining",
  title: "Connection Draining and Deregistration Delay",
  track: "traffic",
  order: 11,
  difficulty: 2,
  minutes: 14,
  prerequisites: ["traffic-alb-target-groups"],
  tags: ["connection draining", "deregistration delay", "in-flight", "rollout", "502"],
  productionQuestion:
    "A rolling deploy causes 502s even though the new tasks are healthy. What setting do you change?",
  learningDelta:
    "Deregistration delay lets in-flight requests finish before a target is removed; too short cuts requests, too long slows deploys",
  objectives: [
    "Trace the target lifecycle from deregistration to draining to removal.",
    "Predict 502s from request duration and deregistration delay.",
    "Tune the delay for rollout speed without cutting requests.",
    "Separate draining failures from health-check and capacity failures.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
