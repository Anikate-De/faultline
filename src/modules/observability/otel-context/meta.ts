import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "observability-otel-context",
  slug: "otel-context",
  title: "OpenTelemetry Context Propagation",
  track: "observability",
  order: 12,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["observability-distributed-tracing"],
  tags: ["context propagation", "traceparent", "baggage", "async", "instrumentation"],
  productionQuestion:
    "The trace stops at the queue consumer and shows two unrelated traces. What broke?",
  learningDelta:
    "Trace context must be injected and extracted across every hop, including queues and background jobs",
  objectives: [
    "Read a traceparent header and name the trace and parent span it carries.",
    "Find the hop where context is lost by comparing root spans with the expected request path.",
    "Carry context across a queue message and a background job without starting a new root.",
    "Separate trace continuity from baggage, which travels with the request but does not join spans.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
