import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "foundations-littles-law",
  slug: "littles-law",
  title: "Little's Law: Concurrency, Latency, Throughput",
  track: "foundations",
  order: 2,
  difficulty: 1,
  minutes: 14,
  prerequisites: ["foundations-use-red"],
  tags: ["Little's Law", "concurrency", "arrival rate", "time in system", "queue depth"],
  productionQuestion:
    "Throughput is flat and latency is rising: how much concurrency is actually in the system?",
  learningDelta:
    "L = λW ties concurrency, arrival rate, and time in system; rising latency at fixed throughput means work is piling up",
  objectives: [
    "Use L = λW to estimate in-flight work from throughput and latency.",
    "Tell a throughput problem from a concurrency or capacity problem.",
    "Explain why a queue grows without bound once arrivals exceed service capacity.",
    "Size a concurrency limit or worker pool from a latency and throughput target.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
