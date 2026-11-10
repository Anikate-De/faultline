import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "caching-ttl-jitter",
  slug: "ttl-jitter",
  title: "TTL Jitter and Smearing",
  track: "caching",
  order: 12,
  difficulty: 1,
  minutes: 14,
  prerequisites: ["caching-cache-stampede"],
  tags: ["TTL", "jitter", "smearing", "expiry wave", "load"],
  productionQuestion:
    "A batch warmup gives every key the same TTL and the cache expires in waves. What do you change?",
  learningDelta:
    "TTL jitter spreads expiration, smoothing backend load and reducing synchronized refreshes",
  objectives: [
    "Recognize an expiry wave from its period and its alignment with a batch load.",
    "Add jitter at the point where the TTL is written, including warmups and deploys.",
    "Quantify how jitter lowers the peak while leaving total refresh work unchanged.",
    "Bound the extra staleness that a longer maximum TTL introduces.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
