import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "observability-scrape-resolution",
  slug: "scrape-resolution",
  title: "Scrape Interval and Resolution",
  track: "observability",
  order: 29,
  difficulty: 2,
  minutes: 14,
  prerequisites: ["observability-promql-rate"],
  tags: ["scrape interval", "resolution", "aliasing", "ingest", "detection"],
  productionQuestion:
    "A 15-second scrape cannot show a 5-second spike. What do you change, and what does it cost?",
  learningDelta:
    "Sampling resolution bounds what you can detect; shorter intervals improve detection but increase ingest and cost",
  objectives: [
    "Relate scrape interval to the shortest outage the system can see.",
    "Explain why a short spike can fall entirely between scrapes.",
    "Quantify the ingest cost of a shorter interval.",
    "Choose a resolution from the detection requirement and the budget.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
