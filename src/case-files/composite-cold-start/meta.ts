import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-composite-cold-start",
  slug: "composite-cold-start",
  title: "Composite: The Autoscaler That Arrived Late",
  track: "case-files",
  order: 41,
  difficulty: 3,
  minutes: 20,
  prerequisites: ["containers-fargate-cold-start"],
  tags: ["autoscaling", "cold start", "ramp", "prediction", "warm capacity"],
  productionQuestion:
    "A traffic spike is over before new tasks become healthy. What should the policy have done?",
  learningDelta:
    "Autoscaling must account for startup latency and predict the ramp; reactive scaling on a short spike is too late",
  objectives: [
    "Separate scaling reaction time from task startup time.",
    "Decide when reactive autoscaling cannot meet a short traffic ramp.",
    "Design a warm-capacity and predictive-scaling policy around measured startup time.",
    "Explain why capacity that arrives after the spike still creates cost and latency debt.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
