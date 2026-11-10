import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "observability-trace-critical-path",
  slug: "trace-critical-path",
  title: "Critical Path: Where the Time Actually Goes",
  track: "observability",
  order: 18,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["observability-distributed-tracing"],
  tags: ["critical path", "self time", "wait time", "parallel calls", "serialization"],
  productionQuestion:
    "Service B is slow and Service C is fast, yet C is on the critical path. Why?",
  learningDelta:
    "Span self-time and waiting time distinguish work from blocked time; the longest span is not always the cause",
  objectives: [
    "Compute the critical path from a span tree with parallel and serial work.",
    "Separate a span's self time from the time it spends waiting on a child.",
    "Predict which optimization lowers end-to-end latency before making it.",
    "Explain why optimizing an off-path span can leave p99 unchanged.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
