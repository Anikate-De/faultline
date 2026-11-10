import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "capacity-storage-lifecycle",
  slug: "storage-lifecycle",
  title: "Storage Lifecycle",
  track: "capacity",
  order: 11,
  difficulty: 2,
  minutes: 14,
  prerequisites: ["foundations-caching-strategies"],
  tags: ["lifecycle", "tier", "transition", "retrieval", "expiry"],
  productionQuestion:
    "Storage cost grows every month and most objects are never read. What do you do?",
  learningDelta:
    "Lifecycle policies transition and expire data; retrieval cost and latency must match access patterns",
  objectives: [
    "Map object age and access pattern to a lifecycle transition.",
    "Explain how an early transition turns a hot read into an expensive retrieval.",
    "Diagnose an expiry rule that deletes data the workload still reads.",
    "Choose a transition point that balances storage savings against retrieval risk.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
