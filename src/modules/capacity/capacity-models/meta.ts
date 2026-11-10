import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "capacity-capacity-models",
  slug: "capacity-models",
  title: "Capacity Models",
  track: "capacity",
  order: 15,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["foundations-littles-law"],
  tags: ["capacity model", "arrival rate", "service time", "concurrency", "headroom"],
  productionQuestion:
    "The quarterly forecast is a spreadsheet with no queueing. What is missing?",
  learningDelta:
    "Capacity models combine arrival rate, service time, concurrency, headroom, and failure domains; averages alone mislead",
  objectives: [
    "Convert peak arrival rate and service time into required concurrency.",
    "Apply a utilization target and a failure-domain reserve to the model.",
    "Compare a provisioned plan with the model requirement.",
    "Defend the assumptions that move the capacity number most.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
