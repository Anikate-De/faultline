import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "caching-memory-fragmentation",
  slug: "memory-fragmentation",
  title: "Redis Memory Fragmentation",
  track: "caching",
  order: 26,
  difficulty: 3,
  minutes: 16,
  prerequisites: ["caching-eviction-policies"],
  tags: ["RSS", "used_memory", "fragmentation", "allocator", "replica buffer"],
  productionQuestion:
    "Redis used_memory is 6GB but the process uses 10GB and the host is OOMing. Why?",
  learningDelta:
    "Allocator fragmentation, peak memory, and replica buffers make RSS larger than the logical dataset; fragmentation ratio explains the gap",
  objectives: [
    "Distinguish used_memory from resident set size and explain the gap.",
    "Read fragmentation ratio alongside workload churn and replica buffers.",
    "Size a container for peak RSS rather than the current logical dataset.",
    "Choose between defragmentation, buffer limits, and more headroom.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
