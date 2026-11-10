import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "observability-continuous-profiling",
  slug: "continuous-profiling",
  title: "Continuous Profiling: Find the Hot Function",
  track: "observability",
  order: 26,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["observability-trace-critical-path"],
  tags: ["profiling", "flame graph", "sample", "CPU", "allocation", "self time"],
  productionQuestion:
    "Latency rose after a release and traces point to one service. Which function is burning CPU?",
  learningDelta:
    "Continuous profiles aggregate stack samples; flame graphs show self time and call paths that metrics and traces cannot",
  objectives: [
    "Distinguish a service-level CPU rise from the function that consumes the CPU.",
    "Read self time in a flame graph and explain why a waiting span is not a hot frame.",
    "Compare allocation-driven and compute-driven cost in the same profile.",
    "Use a release diff to confirm a regression before changing code.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
