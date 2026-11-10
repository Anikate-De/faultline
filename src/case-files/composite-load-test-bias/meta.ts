import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-composite-load-test-bias",
  slug: "composite-load-test-bias",
  title: "Composite: The Load Test That Lied",
  track: "case-files",
  order: 40,
  difficulty: 4,
  minutes: 22,
  prerequisites: ["foundations-coordinated-omission"],
  tags: ["load testing", "closed loop", "coordinated omission", "tail latency", "capacity"],
  productionQuestion:
    "A load test passes at 20k RPS but production fails at 12k. What was measured wrong?",
  learningDelta:
    "Closed-loop load generators omit stalls and underreport tail latency; open-loop arrival and coordinated-omission correction are required",
  objectives: [
    "Explain how a closed-loop generator changes the request schedule when the system stalls.",
    "Identify coordinated omission in a reported latency percentile.",
    "Choose an open-loop test design that exercises the production bottleneck.",
    "Set a capacity gate that fails on corrected tail latency, not throughput alone.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
