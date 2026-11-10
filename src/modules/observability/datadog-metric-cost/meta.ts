import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "observability-datadog-metric-cost",
  slug: "datadog-metric-cost",
  title: "Custom Metric Cost: The Multiplier Stack",
  track: "observability",
  order: 7,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["observability-datadog-tags"],
  tags: ["custom metrics", "host count", "tag cardinality", "billing", "aggregation"],
  productionQuestion:
    "One custom metric across hosts and tags looks cheap in the UI; what does it cost at scale?",
  learningDelta:
    "Custom metric cost multiplies metric name, hosts, and tag combinations; a small tag change can dominate the bill",
  objectives: [
    "Estimate billable series from metric names, hosts, and tag values before a release.",
    "Explain why submission frequency and query count do not set the custom metric bill.",
    "Find the metric and tag that caused a bill step change.",
    "Propose a tag governance rule that keeps the product question answerable.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
