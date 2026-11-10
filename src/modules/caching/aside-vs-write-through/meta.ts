import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "caching-aside-vs-write-through",
  slug: "aside-vs-write-through",
  title: "Cache-Aside vs Write-Through",
  track: "caching",
  order: 19,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["foundations-caching-strategies"],
  tags: ["cache-aside", "write-through", "durability", "staleness", "write path"],
  productionQuestion: "Writes must be durable and reads must be fast. Where does the cache sit?",
  learningDelta:
    "Cache-aside leaves the cache optional and can serve stale data; write-through keeps it fresh but adds write latency and failure coupling",
  objectives: [
    "Trace a read and a write through cache-aside and through write-through.",
    "Explain why cache-aside can serve stale data after a successful database write.",
    "Explain why write-through couples write availability to the cache unless it has a bypass.",
    "Choose a strategy from the durability, freshness, and latency requirements of the data.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
