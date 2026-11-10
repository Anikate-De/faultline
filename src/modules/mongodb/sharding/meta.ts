import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "mongodb-sharding",
  slug: "sharding",
  title: "Sharding Architecture",
  track: "mongodb",
  order: 8,
  difficulty: 2,
  minutes: 18,
  prerequisites: ["mongodb-shard-key"],
  tags: ["mongos", "config server", "shard", "routing", "metadata"],
  productionQuestion: "A sharded cluster routes queries slowly. Which component is involved?",
  learningDelta:
    "mongos routes queries using config server metadata; shards hold data, and routing decisions depend on the shard key",
  objectives: [
    "Place mongos, config servers, and shards on the query and metadata paths.",
    "Explain why a query that omits the shard key fans out to every shard.",
    "Distinguish routing and merge cost at mongos from storage work at a shard.",
    "Recognize that config server metadata is cached by mongos and is not normally the per-query bottleneck.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
