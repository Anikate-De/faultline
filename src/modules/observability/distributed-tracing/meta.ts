import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "observability-distributed-tracing",
  slug: "distributed-tracing",
  title: "Distributed Tracing: Spans and Causality",
  track: "observability",
  order: 17,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["observability-structured-logging"],
  tags: ["span", "trace", "parent", "child", "span kind", "waterfall"],
  productionQuestion:
    "A trace shows 12 spans and the slow one is not the service you expected. How do you read it?",
  learningDelta:
    "A trace is a causal tree; parent/child timing and span kind reveal where time is spent and where it is waited on",
  objectives: [
    "Read a span tree as causality rather than a flat list of timings.",
    "Use span kind and parent IDs to find where context propagation breaks.",
    "Explain why a missing span hides the real latency contributor.",
    "Choose what to instrument so a trace answers an incident question.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
