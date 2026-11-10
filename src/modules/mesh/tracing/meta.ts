import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "mesh-tracing",
  slug: "tracing",
  title: "Mesh Tracing",
  track: "mesh",
  order: 13,
  difficulty: 3,
  minutes: 16,
  prerequisites: ["observability-distributed-tracing"],
  tags: ["tracing", "sidecar span", "context", "sampling", "upstream"],
  productionQuestion: "Traces stop at the sidecar and do not show the upstream call. Why?",
  learningDelta:
    "Mesh tracing requires context propagation and proxy span generation; sampling and header handling decide continuity",
  objectives: [
    "Distinguish a missing proxy span from a broken trace context.",
    "Explain how injection, forwarding, and sampling change trace completeness.",
    "Read a trace waterfall that contains application and sidecar spans.",
    "Diagnose why an upstream call starts a new root span.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
