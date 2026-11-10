import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "streaming-object-storage-latency",
  slug: "object-storage-latency",
  title: "Object-Storage Streaming Latency",
  track: "streaming",
  order: 21,
  difficulty: 3,
  minutes: 16,
  prerequisites: ["streaming-warpstream"],
  tags: ["object storage", "tail latency", "throughput", "metadata", "durability"],
  productionQuestion:
    "Object storage delivers high throughput but p99 reads are slow. Which workload is affected?",
  learningDelta:
    "Object storage favors throughput and durability; per-request latency and metadata operations make it unsuitable for some low-latency paths",
  objectives: [
    "Read a latency histogram instead of a single average or throughput number.",
    "Identify which workloads a high-throughput, high-p99 storage path actually breaks.",
    "Estimate how object size, cache hit rate, and concurrency move p50 and p99 differently.",
    "Choose a mitigation that preserves durability while meeting a latency budget.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
