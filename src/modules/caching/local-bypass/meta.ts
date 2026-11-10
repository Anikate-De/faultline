import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "caching-local-bypass",
  slug: "local-bypass",
  title: "Local Cache Bypass on ECS",
  track: "caching",
  order: 25,
  difficulty: 3,
  minutes: 16,
  prerequisites: ["caching-coherence"],
  tags: ["local cache", "bypass", "ECS", "deployment", "kill switch", "coherence"],
  productionQuestion:
    "A local cache speeds reads but a bad value cannot be purged. What escape hatch do you need?",
  learningDelta:
    "Local caches need a bypass, versioning, or kill switch so operators can recover without redeploying every task",
  objectives: [
    "Explain why a shared-cache flush cannot clear an in-process cache on ECS tasks.",
    "Compare a rolling replacement, a TTL, a runtime bypass, and versioned keys by time to recover.",
    "Design a kill switch that is fast, observable, and safe to leave in the codebase.",
    "Choose a bypass scope that stops the bad value without overloading Redis.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
