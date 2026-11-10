import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "observability-rum-web-vitals",
  slug: "rum-web-vitals",
  title: "RUM and Core Web Vitals",
  track: "observability",
  order: 25,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["observability-golden-signals"],
  tags: ["RUM", "LCP", "CLS", "INP", "field data", "percentile"],
  productionQuestion:
    "Server p95 is 200ms but mobile users see a 4s LCP. Where do you look?",
  learningDelta:
    "RUM captures real device, network, and rendering performance; field percentiles differ from lab and server metrics",
  objectives: [
    "Separate server response time from the browser experience a user actually has.",
    "Read LCP, CLS, and INP as field metrics with percentile budgets.",
    "Explain why a p75 can miss while an average or a server metric passes.",
    "Prioritize a frontend fix using device, network, and third-party evidence.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
