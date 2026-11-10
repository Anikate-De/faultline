import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-composite-cache-stampede",
  slug: "composite-cache-stampede",
  title: "Composite: The TTL That Expired for Everyone",
  track: "case-files",
  order: 23,
  difficulty: 4,
  minutes: 22,
  prerequisites: ["caching-cache-stampede"],
  tags: ["stampede", "TTL", "single-flight", "jitter", "database load"],
  productionQuestion:
    "A popular key expires and the database CPU goes to 100%. What do you do first?",
  learningDelta:
    "Stampede mitigation is layered: request coalescing protects immediately, jitter prevents recurrence, early refresh smooths the next expiry",
  objectives: [
    "Separate a cache miss from a miss storm using request rate and origin load.",
    "Apply request coalescing before changing the cache or database capacity.",
    "Use TTL jitter and early refresh to avoid synchronized expiry.",
    "Serve bounded stale data when the origin cannot absorb the refill.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
