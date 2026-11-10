import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "caching-cluster-resharding",
  slug: "cluster-resharding",
  title: "Redis Cluster Resharding: MOVED and ASK",
  track: "caching",
  order: 17,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["caching-hot-shard-cluster"],
  tags: ["MOVED", "ASK", "slot migration", "redirect", "client", "resharding"],
  productionQuestion:
    "During a reshard, some clients receive MOVED and others time out. What is happening?",
  learningDelta:
    "Redis Cluster redirects keys with MOVED and ASK during migration; clients must follow redirects and handle transient failures",
  objectives: [
    "Explain when Redis Cluster returns MOVED and when it returns ASK.",
    "Trace a client request through a slot migration from source to target.",
    "Predict which clients fail when redirect support is incomplete.",
    "Plan a reshard that bounds migration load and keeps clients correct.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
