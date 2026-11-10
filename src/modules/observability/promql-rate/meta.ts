import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "observability-promql-rate",
  slug: "promql-rate",
  title: "PromQL Rate: Windows, Resets, and Aliasing",
  track: "observability",
  order: 3,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["observability-metrics-types"],
  tags: ["PromQL", "rate", "irate", "scrape interval", "extrapolation", "counter reset"],
  productionQuestion:
    "Your rate query shows spikes every minute that do not match user impact. Why?",
  learningDelta:
    "rate() extrapolates over a window; the window must cover several scrapes and align with the counter's reset behavior",
  objectives: [
    "Choose a rate window that covers enough scrapes for a stable result.",
    "Explain how a short window aliases a burst into an invented spike.",
    "Distinguish rate() from irate() by smoothing and reset behavior.",
    "Read an extrapolation factor and decide when a panel is under-sampled.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
