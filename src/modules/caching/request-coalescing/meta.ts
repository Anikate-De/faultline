import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "caching-request-coalescing",
  slug: "request-coalescing",
  title: "Request Coalescing: One Miss, One Fetch",
  track: "caching",
  order: 10,
  difficulty: 3,
  minutes: 16,
  prerequisites: ["caching-cache-stampede"],
  tags: ["single-flight", "coalescing", "wait", "stale-while-revalidate", "backend load"],
  productionQuestion:
    "Fifty requests miss the same key at once. How many database queries should run?",
  learningDelta:
    "Single-flight coalescing lets one request compute while others wait or receive stale data; it trades latency for backend protection",
  objectives: [
    "Distinguish a concurrent miss storm from a general traffic increase.",
    "Explain how per-instance single-flight bounds backend work at one fetch per key in flight.",
    "Choose between making waiters block and serving stale data while a refresh runs.",
    "Design error, timeout, and fallback behavior for a coalesced fetch.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
