import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "mesh-sidecar-overhead",
  slug: "sidecar-overhead",
  title: "Sidecar Overhead",
  track: "mesh",
  order: 14,
  difficulty: 3,
  minutes: 16,
  prerequisites: ["containers-sidecar-patterns"],
  tags: ["sidecar", "hop", "CPU", "memory", "latency", "connection pool"],
  productionQuestion: "Latency rose after enabling the mesh. How much is the sidecar?",
  learningDelta:
    "Sidecars add hops, CPU, memory, and connection pools; the cost is visible in per-hop latency and resource usage",
  objectives: [
    "Separate mesh overhead from application latency on the same request path.",
    "Compute sidecar CPU demand from per-pod request rate and hop count.",
    "Explain how CPU throttling turns resource contention into tail latency.",
    "Tune CPU limits and connection pools from measured per-hop cost.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
