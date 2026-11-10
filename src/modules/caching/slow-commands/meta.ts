import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "caching-slow-commands",
  slug: "slow-commands",
  title: "Slow Commands and the Redis Event Loop",
  track: "caching",
  order: 22,
  difficulty: 3,
  minutes: 16,
  prerequisites: ["caching-big-keys"],
  tags: ["event loop", "O(N)", "KEYS", "SCAN", "slowlog", "latency"],
  productionQuestion:
    "Redis p99 spikes on every `KEYS *` call from a debug script. What is the mechanism?",
  learningDelta:
    "Redis executes commands on one thread per shard; O(N) commands and large values delay every other client",
  objectives: [
    "Explain how an O(N) command creates a latency spike that average CPU hides.",
    "Read the slowlog, command statistics, and per-command latency to identify the blocking command.",
    "Replace KEYS with a bounded SCAN loop and explain why total work does not disappear.",
    "Choose a SCAN COUNT that bounds each call without multiplying command overhead.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
