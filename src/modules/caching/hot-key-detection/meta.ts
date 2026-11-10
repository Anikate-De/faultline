import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "caching-hot-key-detection",
  slug: "hot-key-detection",
  title: "Detecting a Hot Key",
  track: "caching",
  order: 4,
  difficulty: 3,
  minutes: 16,
  prerequisites: ["foundations-percentiles"],
  tags: ["hot key", "per-key metrics", "shard imbalance", "sampling", "latency"],
  productionQuestion:
    "Shard CPU is uneven but no dashboard shows a hot key. How do you find it?",
  learningDelta:
    "Hot keys are visible in per-key command counts, latency, and shard imbalance; aggregate hit rate hides them",
  objectives: [
    "Tell a hot key from a cluster-wide capacity problem using per-shard and per-key signals.",
    "Explain why aggregate hit rate and cluster average CPU stay healthy during a hot-key incident.",
    "Relate per-key sampling rate to the time needed to attribute a hot key.",
    "Choose a detection method whose sampling cost and blind spots you can defend.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
