import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "streaming-ksqldb",
  slug: "ksqldb",
  title: "ksqlDB Queries and State",
  track: "streaming",
  order: 19,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["streaming-transactions"],
  tags: ["ksqlDB", "state store", "changelog", "reprocessing", "exactly-once"],
  productionQuestion:
    "A ksqlDB query restarts and takes 20 minutes to catch up. Why?",
  learningDelta:
    "Stateful queries rebuild state stores from the changelog; restart time depends on state size and changelog throughput",
  objectives: [
    "Explain why a stateful query must rebuild its state store before it can process new input.",
    "Estimate restart time from state size, restore throughput, and task count.",
    "Distinguish restore time from input backlog catch-up time.",
    "Choose a mitigation that reduces recovery time without breaking correctness.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
