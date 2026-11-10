import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "streaming-hot-partition",
  slug: "hot-partition",
  title: "Kafka Hot Partition",
  track: "streaming",
  order: 5,
  difficulty: 3,
  minutes: 20,
  prerequisites: ["streaming-keys-ordering"],
  tags: ["Kafka", "hot partition", "key skew", "salting", "consumer lag", "ordering"],
  productionQuestion:
    "One partition is at 100% and the others are idle because one key is 60% of traffic. What do you do?",
  learningDelta:
    "Hot partitions come from key skew; salting, key redesign, or splitting the event changes ordering and consumer logic",
  objectives: [
    "Diagnose a hot partition from per-partition load and lag rather than topic averages.",
    "Explain why more consumers or more partitions do not split one key by themselves.",
    "Compare salting, key redesign, event splitting, and partition changes by ordering cost.",
    "Choose a fix and a migration sequence that keeps consumers correct during rollout.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
