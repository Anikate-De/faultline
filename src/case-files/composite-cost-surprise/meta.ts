import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-composite-cost-surprise",
  slug: "composite-cost-surprise",
  title: "Composite: The Bill That Arrived After the Launch",
  track: "case-files",
  order: 59,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["capacity-unit-economics"],
  tags: ["cost", "launch", "forecast", "data transfer", "telemetry"],
  productionQuestion:
    "A launch succeeds and the next bill is 3× forecast. Which usage dimension was missed?",
  learningDelta:
    "Launch economics need per-request cost, data transfer, storage growth, and telemetry; forecasts miss the fastest-growing dimension",
  objectives: [
    "Attribute a post-launch bill to services, usage types, and tags.",
    "Build a forecast from fixed and variable unit costs rather than totals.",
    "Find the dimension growing faster than request volume.",
    "Put launch gates and budget alarms around the modeled run rate.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
