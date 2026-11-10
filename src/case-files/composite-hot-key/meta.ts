import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-composite-hot-key",
  slug: "composite-hot-key",
  title: "Composite: The Hot Key at Peak",
  track: "case-files",
  order: 22,
  difficulty: 4,
  minutes: 24,
  prerequisites: ["caching-hot-key-sharding"],
  tags: ["hot key", "salting", "local cache", "replicas", "tradeoff"],
  productionQuestion:
    "One key is 50% of reads and the shard is at 95% CPU. Which fix do you choose under time pressure?",
  learningDelta:
    "Hot-key fixes differ in time-to-mitigate and staleness; local cache is fastest but changes consistency, salting needs a migration",
  objectives: [
    "Recognize skew that aggregate cache hit rate and shard averages hide.",
    "Compare local caching, replication, and salting by latency, staleness, and migration cost.",
    "Use a short-lived local cache with coalescing as an emergency control.",
    "Plan a hot-key migration that remains correct during dual reads.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
