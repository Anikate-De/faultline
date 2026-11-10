import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "observability-log-volume-cost",
  slug: "log-volume-cost",
  title: "Log Volume and Cost",
  track: "observability",
  order: 27,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["observability-structured-logging"],
  tags: ["log volume", "sampling", "retention", "ingestion cost", "log level"],
  productionQuestion:
    "A verbose release multiplies log volume and the ingestion budget is gone. What do you change?",
  learningDelta:
    "Log cost is volume × retention; level, sampling, and routing keep high-value logs while cutting noise",
  objectives: [
    "Compute log volume from request rate, lines per request, and retained copies.",
    "Separate log level, sampling, routing, and retention as cost levers.",
    "Cut spend without removing the evidence an incident needs.",
    "Explain why a cheaper tier is not the same as a lower-volume pipeline.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
