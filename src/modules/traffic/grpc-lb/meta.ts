import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "traffic-grpc-lb",
  slug: "grpc-lb",
  title: "gRPC Load Balancing",
  track: "traffic",
  order: 32,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["traffic-l4-vs-l7"],
  tags: ["gRPC", "HTTP/2", "stream", "connection balancing", "proxy", "L7"],
  productionQuestion: "gRPC clients pin to one backend despite many replicas. Why?",
  learningDelta:
    "gRPC uses long-lived HTTP/2 connections; connection-level balancing pins streams, so request-level or proxy balancing is required",
  objectives: [
    "Explain why a Layer 4 load balancer chooses a backend once per HTTP/2 connection.",
    "Relate client count, backend count, and stream concurrency to load skew.",
    "Compare connection-level, proxy, and client-side gRPC balancing.",
    "Choose a balancing design from connection count, latency, and operational cost.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
