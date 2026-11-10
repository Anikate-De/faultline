import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "streaming-rebalancing",
  slug: "rebalancing",
  title: "Rebalancing: Stop the World",
  track: "streaming",
  order: 4,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["streaming-consumer-groups"],
  tags: ["rebalance", "eager", "cooperative", "revocation", "session timeout"],
  productionQuestion:
    "Adding one consumer pauses the whole group for 40 seconds. What causes the pause?",
  learningDelta:
    "Rebalances revoke and reassign partitions; eager protocols pause all consumers, cooperative protocols reduce the blast radius",
  objectives: [
    "Trace a rebalance from a membership change through partition revocation and reassignment.",
    "Compare eager and cooperative protocols by which consumers stop processing and for how long.",
    "Relate pause length to group size, partition count, and the session or poll timeout.",
    "Choose a scaling and protocol change that keeps consumer lag inside its freshness budget.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
