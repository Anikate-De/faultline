import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "traffic-upstream-connection-reuse",
  slug: "upstream-connection-reuse",
  title: "Upstream Connection Reuse",
  track: "traffic",
  order: 34,
  difficulty: 3,
  minutes: 16,
  prerequisites: ["traffic-keepalive-idle-timeout"],
  tags: ["connection pool", "warmup", "reuse", "deploy", "handshake"],
  productionQuestion:
    "Backends see a connection storm after every deploy even though traffic is flat. Why?",
  learningDelta:
    "Connection pools and keep-alive must be warmed and drained alongside targets; new targets without reuse multiply handshakes",
  objectives: [
    "Separate steady-state connection churn from deploy-driven connection churn.",
    "Explain why a new target starts with a cold upstream pool.",
    "Measure the connection and latency cost of a rolling deploy.",
    "Design pool warmup and draining that do not create a new storm.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
