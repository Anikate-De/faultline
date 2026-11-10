import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-composite-http2-goaway",
  slug: "composite-http2-goaway",
  title: "Composite: The GOAWAY Storm",
  track: "case-files",
  order: 54,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["foundations-http2-keepalive"],
  tags: ["HTTP/2", "GOAWAY", "connection reuse", "deploy", "reconnect"],
  productionQuestion:
    "A deploy causes clients to reconnect in waves and latency spikes. What protocol behavior is involved?",
  learningDelta:
    "HTTP/2 GOAWAY and connection reuse interact with deploys; draining and jittered reconnect prevent a thundering herd",
  objectives: [
    "Explain why a GOAWAY frame converts one server shutdown into many client reconnects.",
    "Separate in-flight request failure from connection-establishment cost during a deploy.",
    "Choose a drain sequence that keeps the load balancer and the client pool in agreement.",
    "Design reconnect jitter and connection-age limits that prevent synchronized waves.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
