import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "capacity-scheduled-scaling",
  slug: "scheduled-scaling",
  title: "Scheduled Scaling",
  track: "capacity",
  order: 6,
  difficulty: 2,
  minutes: 14,
  prerequisites: ["capacity-autoscaling-policies"],
  tags: ["scheduled scaling", "pattern", "time zone", "reactive", "capacity"],
  productionQuestion:
    "Traffic doubles every weekday at 9 a.m. Why wait for reactive scaling?",
  learningDelta:
    "Scheduled scaling handles predictable demand; it must be combined with reactive policies for surprises",
  objectives: [
    "Map a known demand pattern to a scheduled capacity change.",
    "Convert a UTC schedule into the local time the workload actually follows.",
    "Diagnose a schedule that fires late or outside the traffic window.",
    "Combine scheduled and reactive scaling without letting one erase the other.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
